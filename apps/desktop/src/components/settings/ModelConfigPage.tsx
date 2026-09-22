/**
 * Model configuration tab: default model, configured AI services, OAuth
 * vendor accounts, and the models.dev enrichment snapshot status.
 *
 * The default picker lists each configured model, while provider rows use
 * `models[0]` as the provider's quick default. Editing the default provider
 * preserves `settings.defaultModelId` while that model remains configured, and
 * adding a provider claims the chat or image default only while none resolves.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  OAUTH_AUTH_KIND,
  imageGenerationBindings,
  isImageGenerationModel,
  modelIdsMatch,
  type ImageGenerationBinding,
  type ModelBinding,
  type ProviderPublic,
} from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import { saveSettingsPatch } from "../../lib/settings-save";
import { providerDisplayName, providerSearchText } from "../../lib/provider-display";
import { Badge, Button, Field, Input, TooltipButton, cx } from "../ui";
import {
  IconCheck,
  IconChevronDown,
  IconConfig,
  IconCopy,
  IconDownload,
  IconFolderOpen,
  IconKey,
  IconPencil,
  IconPlug,
  IconPlus,
  IconServer,
  IconSearch,
  IconTrash,
} from "../icons";
import { AnchoredMenu } from "./AnchoredMenu";
import {
  defaultModelOptions,
  displayedDefaultModelId,
  providerOffersModel,
  type DefaultModelOption,
  keepsAppDefaultModel,
  providerServesChatModels,
} from "./default-model";
import { planImageGenerationDefaults } from "./image-generation-default";
import { copyProviderConfiguration, type ProviderCopyDraft } from "./provider-copy";
import { ImageGenerationModelRow } from "./ImageGenerationModelRow";
import { ProviderSetupDialog } from "./ProviderSetupDialog";
import { useProviderReorder } from "./useProviderReorder";
import { VendorAccountsSection } from "./VendorAccountsSection";

const DELETE_CONFIRM_MS = 3000;

/**
 * A row of the context-compaction picker: the follow entry, which names the
 * main model, or one model a ready provider configures.
 */
type CompactionModelRow =
  | { kind: "follow" }
  | { kind: "model"; provider: ProviderPublic; modelId: string };

/** The follow entry comes first, then the same list the default picker offers. */
function compactionModelRows(
  options: readonly DefaultModelOption[],
): CompactionModelRow[] {
  return [
    { kind: "follow" },
    ...options.map(({ provider, modelId }) => ({
      kind: "model" as const,
      provider,
      modelId,
    })),
  ];
}

type CatalogStatus = {
  loaded: boolean;
  source: "bundled" | "remote" | "empty";
  catalogPath: string;
  fetchedAt?: string;
  providerCount: number;
  modelCount: number;
  lastError?: string;
};

/** Host part of a base URL, or an em dash when nothing is configured. */
function hostFromBaseUrl(baseUrl?: string | null): string {
  if (!baseUrl) return "—";
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl.replace(/^https?:\/\//, "").split("/")[0] || baseUrl;
  }
}

export function ModelConfigPage() {
  const { t, i18n } = useTranslation();
  const providers = useAppStore((s) => s.providers);
  const settings = useAppStore((s) => s.settings);
  const refreshProviders = useAppStore((s) => s.refreshProviders);
  const showToast = useAppStore((s) => s.showToast);

  // null = closed, "" = add flow, provider id = edit flow.
  const [copyDraft, setCopyDraft] = useState<ProviderCopyDraft | null>(null);
  const [setupFor, setSetupFor] = useState<string | null>(null);
  const [pickingDefault, setPickingDefault] = useState(false);
  const [defaultModelQuery, setDefaultModelQuery] = useState("");
  const [pickingCompaction, setPickingCompaction] = useState(false);
  const [compactionModelQuery, setCompactionModelQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [changingImageModel, setChangingImageModel] = useState(false);
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  // Export/import share one flag: both open a modal file dialog.
  const [transferBusy, setTransferBusy] = useState<"export" | "import" | null>(null);
  const [catalogStatus, setCatalogStatus] = useState<CatalogStatus | null>(null);

  /** 导出用户自己管理的提供商配置。 */
  const exportProviders = async () => {
    if (transferBusy) return;
    setTransferBusy("export");
    try {
      const result = await api.exportProviderConfig();
      if (result.canceled) return;
      if (!result.ok) throw new Error(result.error ?? "export failed");
      showToast(
        t("settings.exportProvidersDone", {
          count: result.count,
          keys: result.withCredentials,
        }),
        { variant: "success" },
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setTransferBusy(null);
    }
  };

  /** Apply a previously exported file; matching names overwrite in place. */
  const importProviders = async () => {
    if (transferBusy) return;
    setTransferBusy("import");
    try {
      const result = await api.importProviderConfig();
      if (result.canceled) return;
      await refreshProviders();
      showToast(
        t("settings.importProvidersDone", {
          created: result.created,
          updated: result.updated,
          failed: result.failed,
        }),
        { variant: result.failed > 0 ? "error" : "success" },
      );
      if (result.errors.length > 0) {
        showToast(result.errors.slice(0, 3).join("; "), { variant: "error" });
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setTransferBusy(null);
    }
  };
  // Two-step delete: the first click arms the row, the second removes it.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // Inline API-key entry for a plugin-declared row. The plugin owns the
  // provider's fields, so the user supplies only the credential it asks for.
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState("");
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!confirmDeleteId) return;
    confirmTimer.current = setTimeout(() => setConfirmDeleteId(null), DELETE_CONFIRM_MS);
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, [confirmDeleteId]);

  useEffect(() => {
    void (async () => {
      try {
        const result = await api.modelCatalogStatus();
        setCatalogStatus(result.status);
      } catch {
        // The status line simply stays hidden when the catalog cannot report.
        setCatalogStatus(null);
      }
    })();
  }, []);

  const imageGenerationCandidates = useMemo(
    () => imageGenerationBindings(settings?.imageGenerationModels, settings?.imageGeneration),
    [settings?.imageGenerationModels, settings?.imageGeneration],
  );
  // One readiness rule for the picker, the provider rows and the add-provider
  // guard: both call `providerServesChatModels`.
  const providerReady = (provider: ProviderPublic) =>
    providerServesChatModels(provider, imageGenerationCandidates);

  const aiProviders = useMemo(
    () => providers.filter((provider) => provider.authKind !== OAUTH_AUTH_KIND),
    [providers],
  );
  const reorder = useProviderReorder(aiProviders, busyId !== null || testingId !== null || setupFor !== null);
  const readyProviders = providers.filter(providerReady);
  const defaultModelOptionsList = defaultModelOptions(readyProviders, imageGenerationCandidates);
  /*
    The compaction picker offers the follow entry plus the same configured
    models the default picker lists, filtered locally like every other picker.
  */
  const compactionQuery = compactionModelQuery.trim().toLowerCase();
  const visibleCompactionModelRows = compactionModelRows(
    defaultModelOptionsList,
  ).filter((row) => {
    if (!compactionQuery) return true;
    const haystack =
      row.kind === "follow"
        ? t("settings.compactionModelFollow")
        : `${row.provider.name} ${row.modelId}`;
    return haystack.toLowerCase().includes(compactionQuery);
  });
  const visibleDefaultModelOptions = useMemo(() => {
    const query = defaultModelQuery.trim().toLowerCase();
    if (!query) return defaultModelOptionsList;
    return defaultModelOptionsList.filter(({ provider, modelId }) =>
      `${providerSearchText(provider)} ${modelId}`.toLowerCase().includes(query),
    );
  }, [defaultModelOptionsList, defaultModelQuery]);


  if (!settings) return null;

  const defaultProvider =
    providers.find((provider) => provider.id === settings.defaultProviderId) ?? null;
  const editingProvider =
    setupFor ? providers.find((provider) => provider.id === setupFor) ?? null : null;
  const defaultProviderReady = defaultProvider !== null && providerReady(defaultProvider) &&
    !isImageGenerationModel(imageGenerationCandidates, defaultProvider.id,
      displayedDefaultModelId(defaultProvider, settings.defaultModelId));
  /*
    Compaction follows the main model until both fields name a provider and one
    of its models. A pin is only runnable while that provider is still ready and
    still offers the model; otherwise the stored value stays on screen as
    configured so the row can be reset deliberately instead of silently.
  */
  const compactionPinned = !!settings.compactionProviderId && !!settings.compactionModelId;
  const compactionModelId = settings.compactionModelId ?? "";
  const compactionProvider =
    providers.find((provider) => provider.id === settings.compactionProviderId) ?? null;
  const compactionProviderLabel =
    compactionProvider?.name ?? settings.compactionProviderId ?? "";
  const compactionPinRunnable =
    compactionPinned &&
    compactionProvider !== null &&
    providerReady(compactionProvider) &&
    providerOffersModel(compactionProvider, compactionModelId) &&
    !isImageGenerationModel(imageGenerationCandidates, compactionProvider.id, compactionModelId);


  const setDefaultModel = async (provider: ProviderPublic, modelId: string) => {
    if (isImageGenerationModel(
      imageGenerationBindings(
        useAppStore.getState().settings?.imageGenerationModels,
        useAppStore.getState().settings?.imageGeneration,
      ),
      provider.id,
      modelId,
    )) return;
    setBusyId(provider.id);
    try {
      await api.setSettings({
        ...settings,
        defaultProviderId: provider.id,
        defaultModelId: modelId,
      });
      await refreshProviders();
      showToast(t("settings.defaultUpdated"), { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setBusyId(null);
      setPickingDefault(false);
    }
  };

  /**
   * `null` returns the compaction row to following the main model. Following is
   * written as two empty strings rather than omitted keys: the host merges
   * incoming settings over the stored object, so a missing key would leave the
   * previous pin in place.
   */
  const setCompactionModel = async (
    provider: ProviderPublic | null,
    modelId: string,
  ) => {
    setBusyId(provider?.id ?? null);
    try {
      await saveSettingsPatch({
        compactionProviderId: provider?.id ?? "",
        compactionModelId: provider ? modelId : "",
      });
      showToast(t("settings.compactionModelUpdated"), { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setBusyId(null);
      setPickingCompaction(false);
    }
  };

  /**
   * Preserve the selected app defaults unless they were removed from the
   * provider or no longer resolve, and let a newly added provider claim a
   * default only while none resolves.
   */
  const afterSaved = async (
    saved: ProviderPublic,
    models: ModelBinding[],
    imageModelIds?: string[],
  ) => {
    const firstModelId = models[0]?.id;
    const replacementChatModelId =
      settings.defaultProviderId === saved.id && firstModelId &&
      !models.some((model) => modelIdsMatch(model.id, settings.defaultModelId ?? ""))
        ? firstModelId
        : undefined;
    try {
      if (imageModelIds !== undefined) {
        const current = await api.getSettings();
        const plan = planImageGenerationDefaults(
          current,
          saved.id,
          imageModelIds,
          [...providers.filter((provider) => provider.id !== saved.id), saved],
          current.imageGeneration?.providerId === saved.id &&
            !saved.models.some((model) => modelIdsMatch(model.id, current.imageGeneration?.modelId ?? "")),
        );
        const nextSettings = {
          ...current,
          ...plan,
          ...(replacementChatModelId ? { defaultModelId: replacementChatModelId } : {}),
        };
        await api.setSettings(nextSettings);
        useAppStore.setState({ settings: nextSettings });
        showToast(t(editingProvider ? "settings.providerUpdated" : "settings.providerSaved"), {
          variant: "success",
        });
      } else if (copyDraft) {
        showToast(t("settings.providerSaved"), { variant: "success" });
      } else if (!editingProvider) {
        // A freshly added provider must not take over the app default: whatever
        // the user already picked keeps running — as long as that default's own
        // provider is still runnable — until they change it themselves.
        const keepsCurrentDefault = keepsAppDefaultModel(
          providers,
          settings.defaultProviderId,
          settings.defaultModelId,
          imageGenerationCandidates,
        );
        if (!keepsCurrentDefault) {
          await api.setSettings({
            ...settings,
            defaultProviderId: saved.id,
            defaultModelId: firstModelId ?? "",
          });
        }
        showToast(t("settings.providerSaved"), { variant: "success" });
      } else {
        if (replacementChatModelId) {
          await api.setSettings({ ...settings, defaultModelId: replacementChatModelId });
        }
        showToast(t("settings.providerUpdated"), { variant: "success" });
      }
      setSetupFor(null);
      setCopyDraft(null);
      await refreshProviders();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    }
  };

  const setImageGenerationDefault = async (binding: ImageGenerationBinding) => {
    setChangingImageModel(true);
    try {
      const current = await api.getSettings();
      const candidates = imageGenerationBindings(
        current.imageGenerationModels,
        current.imageGeneration,
      );
      if (!isImageGenerationModel(candidates, binding.providerId, binding.modelId)) return;
      const nextSettings = { ...current, imageGeneration: binding };
      await api.setSettings(nextSettings);
      useAppStore.setState({ settings: nextSettings });
      showToast(t("settings.imageModelSelected"), { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setChangingImageModel(false);
    }
  };

  const toggleEnabled = async (provider: ProviderPublic) => {
    setBusyId(provider.id);
    try {
      await api.updateProvider({ id: provider.id, enabled: !provider.enabled });
      await refreshProviders();
      showToast(
        t(provider.enabled ? "settings.providerDisabled" : "settings.providerEnabled"),
        { variant: "success" },
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setBusyId(null);
    }
  };

  const removeProvider = async (provider: ProviderPublic) => {
    setConfirmDeleteId(null);
    setBusyId(provider.id);
    try {
      await api.deleteProvider(provider.id);
      await refreshProviders();
      showToast(t("settings.providerRemoved"), { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setBusyId(null);
    }
  };

  const saveProviderKey = async (provider: ProviderPublic, value: string) => {
    setBusyId(provider.id);
    try {
      await api.setProviderSecret({ id: provider.id, secretValue: value });
      await refreshProviders();
      setKeyFor(null);
      setKeyValue("");
      showToast(
        t(value.trim() ? "settings.pluginProviderKeySaved" : "settings.pluginProviderKeyRemoved"),
        { variant: "success" },
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setBusyId(null);
    }
  };

  const testProvider = async (provider: ProviderPublic) => {
    setTestingId(provider.id);
    try {
      const result = (await api.testProvider(provider.id)) as {
        ok?: boolean;
        message?: string;
        status?: number;
      };
      if (result?.ok) {
        showToast(t("settings.testOk"), { variant: "success" });
      } else {
        showToast(
          result?.message ||
            (result?.status
              ? t("settings.testFailedStatus", { status: result.status })
              : t("settings.testFailed")),
          { variant: "error" },
        );
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setTestingId(null);
    }
  };

  const refreshCatalog = async () => {
    setRefreshingCatalog(true);
    try {
      const result = await api.refreshModelCatalog();
      setCatalogStatus(result.status);
      await refreshProviders();
      if (result.refreshed) {
        showToast(t("settings.modelCatalogUpdated"), { variant: "success" });
      } else {
        showToast(result.status.lastError || t("settings.modelCatalogUpdateFailed"), {
          variant: "error",
        });
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setRefreshingCatalog(false);
    }
  };

  const catalogSourceLabel = catalogStatus
    ? t(
        catalogStatus.source === "remote"
          ? "settings.catalogSourceRemote"
          : catalogStatus.source === "bundled"
            ? "settings.catalogSourceBundled"
            : "settings.catalogSourceEmpty",
      )
    : "";

  return (
    <div className="settings-stack model-config-page">
      <section className="settings-card-block">
        <div className="model-config-section-head">
          <h3 className="settings-card-heading">{t("settings.defaultsTitle")}</h3>
        </div>
        <div className="settings-panel model-default-panel">
          <div className="settings-row model-default-row">
            <div className="settings-row-copy model-default-copy">
              <div className="settings-row-title model-default-label">
                {t("settings.defaultModel")}
              </div>
              {defaultProviderReady ? (
                <div className="settings-row-detail model-default-value">
                  <span className="model-default-provider">
                    {providerDisplayName(defaultProvider)}
                  </span>
                  <span className="model-default-sep" aria-hidden>
                    ·
                  </span>
                  <span className="model-default-model font-mono">
                    {displayedDefaultModelId(defaultProvider, settings.defaultModelId) ||
                      t("settings.noModel")}
                  </span>
                </div>
              ) : (
                <div className="settings-row-detail model-default-value">
                  <span className="model-default-empty">
                    {readyProviders.length === 0
                      ? t("settings.defaultModelNone")
                      : t("settings.noDefaultProvider")}
                  </span>
                </div>
              )}
            </div>
            <AnchoredMenu
              className="model-default-anchor"
              open={pickingDefault}
              onClose={() => setPickingDefault(false)}
              menuClassName="model-default-menu"
              label={t("settings.changeDefaultModel")}
              align="end"
              trigger={(ref) => (
                <Button
                  ref={ref}
                  className="settings-text-action model-default-trigger"
                  variant="ghost"
                  disabled={readyProviders.length === 0}
                  onClick={() => {
                    setDefaultModelQuery("");
                    setPickingDefault((current) => !current);
                  }}
                  aria-haspopup="listbox"
                  aria-expanded={pickingDefault}
                >
                  {t("settings.changeDefaultModel")}
                  <IconChevronDown className="model-default-trigger-chevron" size={13} aria-hidden />
                </Button>
              )}
            >
              <div className="model-default-search">
                <IconSearch size={14} aria-hidden />
                <Input
                  value={defaultModelQuery}
                  onChange={(event) => setDefaultModelQuery(event.target.value)}
                  placeholder={t("settings.defaultModelSearch")}
                  aria-label={t("settings.defaultModelSearch")}
                  autoFocus
                />
              </div>
              <div className="model-default-results" role="presentation">
                {visibleDefaultModelOptions.length === 0 ? (
                  <div className="model-default-no-results">{t("settings.noModelMatches")}</div>
                ) : null}
                <ul className="model-default-list">
                  {visibleDefaultModelOptions.map(({ provider, modelId }, index) => {
                    const isCurrent =
                      provider.id === settings.defaultProviderId &&
                      modelIdsMatch(settings.defaultModelId ?? "", modelId);
                    const previous = visibleDefaultModelOptions[index - 1];
                    const startsGroup = !previous || previous.provider.id !== provider.id;
                    return (
                      <li key={`${provider.id}:${modelId}`}>
                        {startsGroup ? (
                          <div
                            className={cx(
                              "model-default-provider-group",
                              index > 0 && "has-divider",
                            )}
                          >
                            {providerDisplayName(provider)}
                          </div>
                        ) : null}
                        <button
                          type="button"
                          role="option"
                          aria-selected={isCurrent}
                          aria-label={`${providerDisplayName(provider)} · ${modelId}`}
                          className={cx("model-default-option", isCurrent && "is-current")}
                          disabled={busyId === provider.id}
                          onClick={() => void setDefaultModel(provider, modelId)}
                        >
                          <span className="model-default-option-check" aria-hidden>
                            {isCurrent ? <IconCheck size={12} /> : null}
                          </span>
                          <span className="model-default-option-model font-mono">{modelId}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </AnchoredMenu>
          </div>
          <div className="settings-row model-default-row">
            <div className="settings-row-copy model-default-copy">
              <div className="settings-row-title model-default-label" title={t("settings.compactionModelFollowHint")}>
                {t("settings.compactionModel")}
              </div>
              {!compactionPinned ? (
                <div className="settings-row-desc model-default-value">
                  <span className="model-default-provider">
                    {t("settings.compactionModelFollow")}
                  </span>
                </div>
              ) : compactionPinRunnable ? (
                <div className="settings-row-desc model-default-value">
                  <span className="model-default-provider">{compactionProviderLabel}</span>
                  <span className="model-default-sep" aria-hidden>
                    ·
                  </span>
                  <span className="model-default-model font-mono">{compactionModelId}</span>
                </div>
              ) : (
                <div className="settings-row-desc model-default-value">
                  <span className="model-default-empty">
                    {t("settings.compactionModelUnavailable", {
                      provider: compactionProviderLabel,
                      model: compactionModelId,
                    })}
                  </span>
                </div>
              )}
            </div>
            <AnchoredMenu
              className="model-default-anchor"
              open={pickingCompaction}
              onClose={() => setPickingCompaction(false)}
              menuClassName="model-default-menu"
              label={t("settings.changeCompactionModel")}
              align="end"
              trigger={(ref) => (
                <Button
                  ref={ref}
                  className="settings-text-action model-default-trigger"
                  variant="ghost"
                  // A stale pin must stay reachable even with nothing ready, so
                  // the row can be reset to follow instead of being stuck.
                  disabled={readyProviders.length === 0 && !compactionPinned}
                  onClick={() => {
                    setCompactionModelQuery("");
                    setPickingCompaction((current) => !current);
                  }}
                  aria-haspopup="listbox"
                  aria-expanded={pickingCompaction}
                >
                  {t("settings.changeCompactionModel")}
                  <IconChevronDown className="model-default-trigger-chevron" size={13} aria-hidden />
                </Button>
              )}
            >
              <div className="model-default-search">
                <IconSearch size={14} aria-hidden />
                <Input
                  value={compactionModelQuery}
                  onChange={(event) => setCompactionModelQuery(event.target.value)}
                  placeholder={t("settings.defaultModelSearch")}
                  aria-label={t("settings.defaultModelSearch")}
                  autoFocus
                />
              </div>
              <div className="model-default-results" role="presentation">
                {visibleCompactionModelRows.length === 0 ? (
                  <div className="model-default-no-results">{t("settings.noModelMatches")}</div>
                ) : null}
                <ul className="model-default-list">
                  {visibleCompactionModelRows.map((row, index) => {
                    if (row.kind === "follow") {
                      const isCurrent = !compactionPinned;
                      return (
                        <li key="follow">
                          <button
                            type="button"
                            role="option"
                            aria-selected={isCurrent}
                            aria-label={t("settings.compactionModelFollow")}
                            className={cx("model-default-option", isCurrent && "is-current")}
                            onClick={() => void setCompactionModel(null, "")}
                          >
                            <span className="model-default-option-check" aria-hidden>
                              {isCurrent ? <IconCheck size={12} /> : null}
                            </span>
                            <span className="model-default-option-model">
                              {t("settings.compactionModelFollow")}
                            </span>
                          </button>
                        </li>
                      );
                    }
                    const isCurrent =
                      compactionPinned &&
                      row.provider.id === settings.compactionProviderId &&
                      modelIdsMatch(compactionModelId, row.modelId);
                    const previous = visibleCompactionModelRows[index - 1];
                    const startsGroup =
                      !previous ||
                      previous.kind !== "model" ||
                      previous.provider.id !== row.provider.id;
                    return (
                      <li key={`${row.provider.id}:${row.modelId}`}>
                        {startsGroup ? (
                          <div
                            className={cx(
                              "model-default-provider-group",
                              index > 0 && "has-divider",
                            )}
                          >
                            {row.provider.name}
                          </div>
                        ) : null}
                        <button
                          type="button"
                          role="option"
                          aria-selected={isCurrent}
                          aria-label={`${row.provider.name} · ${row.modelId}`}
                          className={cx("model-default-option", isCurrent && "is-current")}
                          disabled={busyId === row.provider.id}
                          onClick={() => void setCompactionModel(row.provider, row.modelId)}
                        >
                          <span className="model-default-option-check" aria-hidden>
                            {isCurrent ? <IconCheck size={12} /> : null}
                          </span>
                          <span className="model-default-option-model font-mono">
                            {row.modelId}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </AnchoredMenu>
          </div>
          {imageGenerationCandidates.length > 0 ? (
            <ImageGenerationModelRow
              settings={settings}
              providers={providers}
              busy={changingImageModel}
              onChange={setImageGenerationDefault}
            />
          ) : null}
        </div>
      </section>

      <section className="settings-card-block">
        <div className="model-config-section-head">
          <div className="settings-card-heading-line">
            <h3 className="settings-card-heading">{t("settings.providers")}</h3>
            {aiProviders.length > 0 ? (
              <span className="provider-section-count">{aiProviders.length}</span>
            ) : null}
          </div>
          <div className="import-toolbar-actions">
            <Button
              variant="secondary"
              disabled={transferBusy !== null}
              onClick={() => void exportProviders()}
            >
              <span className="model-config-btn-inner">
                <IconDownload size={14} />
                <span>{t("settings.exportProviders")}</span>
              </span>
            </Button>
            <Button
              variant="secondary"
              disabled={transferBusy !== null}
              onClick={() => void importProviders()}
            >
              <span className="model-config-btn-inner">
                <IconFolderOpen size={14} />
                <span>{t("settings.importProviders")}</span>
              </span>
            </Button>
            <Button variant="primary" onClick={() => setSetupFor("")}>
              <span className="model-config-btn-inner">
                <IconPlus size={14} />
                <span>{t("settings.addProvider")}</span>
              </span>
            </Button>
          </div>
        </div>

        <div className="settings-panel model-provider-panel">
          {aiProviders.length === 0 ? (
            <div className="model-provider-empty">
              <div className="model-provider-empty-icon" aria-hidden>
                <IconServer size={18} />
              </div>
              <div className="model-provider-empty-title">{t("settings.noProviders")}</div>
              <div className="model-provider-empty-desc">{t("settings.noProvidersDesc")}</div>
              <Button variant="primary" onClick={() => setSetupFor("")}>
                <span className="model-config-btn-inner">
                  <IconPlus size={14} />
                  <span>{t("settings.addProvider")}</span>
                </span>
              </Button>
            </div>
          ) : (
            <ul className="model-provider-list" aria-busy={reorder.saving}>
              {reorder.providers.map((provider) => {
                const isDefault = settings.defaultProviderId === provider.id;
                const rowBusy = reorder.saving || busyId === provider.id || testingId === provider.id;
                const confirming = confirmDeleteId === provider.id;
                const modelCount = provider.models?.length ?? 0;
                // A plugin-declared row is refreshed from the plugin's manifest
                // on every load, so its fields and its enabled switch are not
                // the user's to change. The credential is.
                const ownedByPlugin = provider.ownerPluginId;
                const keyEntry = keyFor === provider.id;
                return (
                  <li
                    key={provider.id}
                    className={cx("model-provider-row", !provider.enabled && "is-disabled", reorder.draggingId === provider.id && "is-dragging")}
                    data-provider-id={provider.id}
                    aria-label={t("settings.reorderProvider", { name: provider.name })}
                    ref={reorder.rowRef(provider.id)}
                    {...reorder.rowEvents(provider.id)}
                  >
                    <div className="model-provider-row-copy">
                      <div className="model-provider-row-title">
                        <span className="model-provider-row-name">{provider.name}</span>
                        {isDefault ? (
                          <Badge tone="success">{t("settings.default")}</Badge>
                        ) : null}
                        {!provider.hasSecret && provider.authKind !== "none" ? (
                          <Badge tone="warning">{t("settings.noSecret")}</Badge>
                        ) : null}
                        {!provider.enabled ? (
                          <Badge tone="neutral">{t("settings.providerDisabledBadge")}</Badge>
                        ) : null}
                        {ownedByPlugin ? (
                          <span
                            title={t("settings.pluginProviderManaged", {
                              plugin: ownedByPlugin,
                            })}
                          >
                            <Badge tone="neutral">{t("settings.pluginProviderBadge")}</Badge>
                          </span>
                        ) : null}
                      </div>
                      <div className="model-provider-row-meta">
                        <span>{hostFromBaseUrl(provider.baseUrl)}</span>
                        <span className="model-provider-meta-dot" aria-hidden>
                          ·
                        </span>
                        <span>{t("settings.providerModelCount", { count: modelCount })}</span>
                        {ownedByPlugin ? (
                          <>
                            <span className="model-provider-meta-dot" aria-hidden>
                              ·
                            </span>
                            <span>{t("settings.pluginProviderBy", { plugin: ownedByPlugin })}</span>
                          </>
                        ) : null}
                      </div>
                    </div>

                    <div className="model-provider-row-actions">
                      {!isDefault ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={rowBusy || !providerReady(provider)}
                          onClick={() =>
                            void setDefaultModel(provider, defaultModelOptions([provider], imageGenerationCandidates)[0]?.modelId ?? "")
                          }
                        >
                          {t("settings.makeDefault")}
                        </Button>
                      ) : null}
                      {!ownedByPlugin ? (
                        <TooltipButton
                          type="button"
                          className="icon-btn icon-btn-square model-provider-icon-btn"
                          tooltip={t("settings.copyProvider")}
                          ariaLabel={t("settings.copyProvider")}
                          disabled={rowBusy}
                          onClick={() => {
                            setCopyDraft(copyProviderConfiguration(provider, t("settings.copyProviderName", { name: provider.name })));
                            setSetupFor("");
                          }}
                        >
                          <IconCopy size={14} />
                        </TooltipButton>
                      ) : null}
                      {ownedByPlugin && provider.authKind === "api_key" ? (
                        <TooltipButton
                          type="button"
                          className="icon-btn icon-btn-square model-provider-icon-btn"
                          tooltip={t("settings.pluginProviderKey")}
                          ariaLabel={t("settings.pluginProviderKey")}
                          disabled={rowBusy}
                          onClick={() => {
                            setKeyFor(keyEntry ? null : provider.id);
                            setKeyValue("");
                          }}
                        >
                          <IconKey size={14} />
                        </TooltipButton>
                      ) : null}
                      <TooltipButton
                        type="button"
                        className="icon-btn icon-btn-square model-provider-icon-btn"
                        tooltip={
                          ownedByPlugin
                            ? t("settings.pluginProviderManaged", { plugin: ownedByPlugin })
                            : t("settings.editProvider")
                        }
                        ariaLabel={t("settings.editProvider")}
                        disabled={rowBusy || Boolean(ownedByPlugin)}
                        onClick={() => setSetupFor(provider.id)}
                      >
                        <IconPencil size={14} />
                      </TooltipButton>
                      <TooltipButton
                        type="button"
                        className={cx(
                          "icon-btn icon-btn-square model-provider-icon-btn",
                          testingId === provider.id && "is-testing",
                        )}
                        tooltip={t("settings.testConnection")}
                        ariaLabel={t("settings.testConnection")}
                        disabled={rowBusy}
                        onClick={() => void testProvider(provider)}
                      >
                        <IconPlug size={14} />
                      </TooltipButton>
                      {confirming ? (
                        <button
                          type="button"
                          className="model-provider-delete-confirm"
                          disabled={rowBusy}
                          onBlur={() => setConfirmDeleteId(null)}
                          onClick={() => void removeProvider(provider)}
                        >
                          {t("settings.deleteConfirm")}
                        </button>
                      ) : (
                        <TooltipButton
                          type="button"
                          className="icon-btn icon-btn-square model-provider-icon-btn is-danger"
                          tooltip={
                            ownedByPlugin
                              ? t("settings.pluginProviderManaged", { plugin: ownedByPlugin })
                              : t("settings.delete")
                          }
                          ariaLabel={t("settings.delete")}
                          disabled={rowBusy || Boolean(ownedByPlugin)}
                          onClick={() => setConfirmDeleteId(provider.id)}
                        >
                          <IconTrash size={14} />
                        </TooltipButton>
                      )}
                      <TooltipButton
                        type="button"
                        className={cx("settings-toggle", provider.enabled && "on")}
                        role="switch"
                        aria-checked={provider.enabled}
                        tooltip={
                          ownedByPlugin
                            ? t("settings.pluginProviderManaged", { plugin: ownedByPlugin })
                            : t("settings.enabledToggle")
                        }
                        ariaLabel={t("settings.enabledToggle")}
                        disabled={rowBusy || Boolean(ownedByPlugin)}
                        onClick={() => void toggleEnabled(provider)}
                      >
                        <span className="settings-toggle-thumb" />
                      </TooltipButton>
                    </div>
                    {keyEntry ? (
                      <div className="model-provider-key-entry">
                        <Field
                          label={t("settings.pluginProviderKey")}
                          hint={t("settings.pluginProviderKeyHint")}
                        >
                          <Input
                            type="password"
                            autoFocus
                            disabled={rowBusy}
                            value={keyValue}
                            placeholder={
                              provider.hasSecret ? t("settings.apiKeyKeepHint") : undefined
                            }
                            onChange={(event) => setKeyValue(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") setKeyFor(null);
                              if (event.key === "Enter") {
                                event.preventDefault();
                                if (!rowBusy && keyValue.trim()) void saveProviderKey(provider, keyValue);
                              }
                            }}
                          />
                        </Field>
                        <div className="model-provider-key-actions">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={rowBusy}
                            onClick={() => setKeyFor(null)}
                          >
                            {t("settings.cancel")}
                          </Button>
                          {provider.hasSecret ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={rowBusy}
                              onClick={() => void saveProviderKey(provider, "")}
                            >
                              {t("settings.pluginProviderKeyRemove")}
                            </Button>
                          ) : null}
                          <Button
                            size="sm"
                            disabled={rowBusy || !keyValue.trim()}
                            onClick={() => void saveProviderKey(provider, keyValue)}
                          >
                            {t("settings.save")}
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <VendorAccountsSection />

      <div className="model-catalog-status">
        <span className="model-catalog-status-text">
          {catalogStatus
            ? t("settings.catalogStatusLine", {
                source: catalogSourceLabel,
                models: catalogStatus.modelCount,
                fetchedAt: catalogStatus.fetchedAt
                  ? new Date(catalogStatus.fetchedAt).toLocaleString(
                      i18n.resolvedLanguage ?? i18n.language,
                    )
                  : t("settings.catalogNeverFetched"),
              })
            : t("settings.catalogStatusUnknown")}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={refreshingCatalog}
          onClick={() => void refreshCatalog()}
        >
          <span className="model-config-btn-inner">
            <IconConfig size={13} />
            <span>
              {refreshingCatalog
                ? t("settings.refreshingModelCatalog")
                : t("settings.refreshModelCatalog")}
            </span>
          </span>
        </Button>
      </div>

      {setupFor !== null ? (
        <ProviderSetupDialog
          provider={editingProvider}
          initialDraft={copyDraft}
          onClose={() => { setSetupFor(null); setCopyDraft(null); }}
          imageModelIds={editingProvider
            ? imageGenerationCandidates
                .filter((binding) => binding.providerId === editingProvider.id)
                .map((binding) => binding.modelId)
            : undefined}
          onSaved={afterSaved}
        />
      ) : null}
    </div>
  );
}
