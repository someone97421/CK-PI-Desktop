import { useTranslation } from "react-i18next";
import {
  THINKING_LEVELS,
  bindingDefaultThinkingMenuLevels,
  modelMatchesFilter,
  resolveBindingDefaultThinkingLevel,
  sortThinkingLevels,
  type FastModeBilling,
  type ModelBinding,
  type ModelInfo,
  type SessionThinkingLevel,
  type ThinkingLevel,
  type ThinkingProtocol,
  type VideoTransport,
} from "@pi-desktop/shared";
import {
  CONTEXT_WINDOW_PRESETS,
  MAX_OUTPUT_PRESETS,
  matchPresetIndex,
  type LimitPreset,
} from "../../lib/model-limit-presets";
import { Checkbox, HelpIcon, Input, TooltipButton, cx } from "../ui";
import { ReasoningEffortSelect } from "./ReasoningEffortSelect";
import { SettingsMenuSelect } from "./SettingsMenuSelect";

type FastModeHintKey =
  | "settings.fastModeAllowedSubscriptionHint"
  | "settings.fastModeAllowedUsageHint"
  | "settings.fastModeAllowedUnsupported";

type ModelAdvancedSettingsProps = {
  id: string;
  hidden: boolean;
  binding: ModelBinding;
  info?: ModelInfo;
  publishedLevels: readonly ThinkingLevel[];
  followsCatalog: boolean;
  apiStyle?: string;
  busy: boolean;
  imageModelSelected: boolean;
  onImageModelChange?: (id: string, selected: boolean) => void;
  nativeWebSearchWireCapable: boolean;
  fastModeBilling: FastModeBilling | undefined;
  fastModeHint: FastModeHintKey;
  updateBinding: (id: string, patch: Partial<ModelBinding>) => void;
};

export function ModelAdvancedSettings({
  id,
  hidden,
  binding,
  info,
  publishedLevels,
  followsCatalog,
  apiStyle,
  busy,
  imageModelSelected,
  onImageModelChange,
  nativeWebSearchWireCapable,
  fastModeBilling,
  fastModeHint,
  updateBinding,
}: ModelAdvancedSettingsProps) {
  const { t } = useTranslation();
  // The catalog is a baseline, not a capability gate.
  const levelChoices = THINKING_LEVELS;
  const enabledLevels = sortThinkingLevels(binding.thinkingLevels);
  const publishedImages = info ? modelMatchesFilter(info, "vision") : false;
  const publishedDocuments = info ? modelMatchesFilter(info, "pdf") : false;
  const googleGenerativeAi = apiStyle === "google_generative_ai";
  const showVideoInput = !apiStyle || apiStyle === "chat_completions" || googleGenerativeAi;
  const showReasoningEffort =
    !apiStyle || apiStyle === "chat_completions" || apiStyle === "opencode_go";
  const nativeWebSearchHint = t(
    nativeWebSearchWireCapable
      ? googleGenerativeAi
        ? "settings.nativeWebSearchGoogleHint"
        : "settings.nativeWebSearchHint"
      : "settings.nativeWebSearchUnsupported",
  );

  return (
    <div className="provider-chosen-row-body" id={id} hidden={hidden}>
      <section className="provider-advanced-section">
        <label className="provider-chosen-field">
          <span className="provider-chosen-field-label">
            {t("settings.modelAlias")}
            <HelpIcon label={t("settings.modelAliasHint")} />
          </span>
          <Input
            value={binding.alias ?? ""}
            placeholder={t("settings.modelAliasPlaceholder")}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            onChange={(event) =>
              updateBinding(binding.id, {
                alias: [...event.target.value].slice(0, 60).join(""),
              })
            }
          />
        </label>
        <div className="provider-chosen-limits">
          <TokenLimitField
            label={t("settings.contextWindow")}
            hint={followsCatalog ? t("settings.contextWindowCatalogHint") : undefined}
            presets={CONTEXT_WINDOW_PRESETS}
            value={binding.contextWindow}
            onChange={(tokens) =>
              updateBinding(binding.id, {
                contextWindow: tokens,
                contextWindowSource: "user",
              })
            }
          />
          <TokenLimitField
            label={t("settings.maxOutput")}
            presets={MAX_OUTPUT_PRESETS}
            value={binding.maxTokens}
            onChange={(tokens) =>
              updateBinding(binding.id, {
                maxTokens: tokens,
                maxTokensSource: "user",
              })
            }
          />
        </div>
      </section>

      <section className="provider-advanced-section">
        <span className="provider-advanced-heading">
          {t("settings.supportedThinkingLevels")}
          {publishedLevels.length === 0 ? (
            <HelpIcon label={t("settings.thinkingManualOverrideHint")} />
          ) : null}
        </span>
        <div
          className="provider-chosen-thinking-chips"
          role="group"
          aria-label={t("settings.supportedThinkingLevels")}
        >
          {levelChoices.map((level) => {
            const on = binding.thinkingLevels.includes(level);
            return (
              <TooltipButton
                key={level}
                type="button"
                className={cx("provider-thinking-chip", on && "selected")}
                ariaLabel={level}
                tooltip={level}
                aria-pressed={on}
                onClick={() => {
                  const next: ThinkingLevel[] = on
                    ? binding.thinkingLevels.filter((entry) => entry !== level)
                    : [...binding.thinkingLevels, level];
                  updateBinding(binding.id, {
                    thinkingLevels: next,
                    defaultThinkingLevel: resolveBindingDefaultThinkingLevel(
                      binding.defaultThinkingLevel,
                      sortThinkingLevels(next),
                    ),
                  });
                }}
              >
                {level}
              </TooltipButton>
            );
          })}
        </div>
        <div className="provider-advanced-options">
          {bindingDefaultThinkingMenuLevels(enabledLevels).length > 1 ? (
            <div className="provider-advanced-option">
              <span className="provider-chosen-thinking-label">
                {t("settings.defaultThinkingLevel")}
              </span>
              <SettingsMenuSelect
                className="provider-chosen-thinking-select"
                fullWidth
                label={t("settings.defaultThinkingLevel")}
                value={
                  resolveBindingDefaultThinkingLevel(
                    binding.defaultThinkingLevel,
                    enabledLevels,
                  ) ?? ""
                }
                onChange={(id) =>
                  updateBinding(binding.id, {
                    defaultThinkingLevel: id as SessionThinkingLevel,
                  })
                }
                options={bindingDefaultThinkingMenuLevels(enabledLevels).map((level) => ({
                  id: level,
                  label: level,
                }))}
              />
            </div>
          ) : null}
          <div className="provider-advanced-option">
            <span className="provider-chosen-thinking-label">
              {t("settings.thinkingProtocol")}
            </span>
            {googleGenerativeAi ? (
              <span className="provider-chosen-thinking-label">
                {t("settings.googleThinking")}
                <HelpIcon label={t("settings.googleThinkingHint")} />
              </span>
            ) : (
              <SettingsMenuSelect
                className="provider-chosen-thinking-select"
                fullWidth
                label={t("settings.thinkingProtocol")}
                value={binding.thinkingProtocol ?? info?.thinkingProtocol ?? "legacy"}
                onChange={(id) =>
                  updateBinding(binding.id, {
                    thinkingProtocol: id as ThinkingProtocol,
                  })
                }
                options={[
                  { id: "legacy", label: t("settings.thinkingProtocolLegacy") },
                  { id: "adaptive", label: t("settings.thinkingProtocolAdaptive") },
                ]}
              />
            )}
          </div>
          {showReasoningEffort ? (
            <ReasoningEffortSelect
              value={binding.supportsReasoningEffort}
              onChange={(supportsReasoningEffort) =>
                updateBinding(binding.id, { supportsReasoningEffort })
              }
            />
          ) : null}
        </div>
      </section>

      <section className="provider-advanced-section">
        <span className="provider-advanced-heading">{t("settings.modelCapabilities")}</span>
        <div className="provider-chosen-capability-rows">
          <CapabilityToggle
            label={t("settings.imageInput")}
            published={publishedImages}
            value={binding.supportsImages}
            onChange={(next) => updateBinding(binding.id, { supportsImages: next })}
          />
          <CapabilityToggle
            label={t("settings.documentInput")}
            published={publishedDocuments}
            value={binding.supportsDocuments}
            onChange={(next) => updateBinding(binding.id, { supportsDocuments: next })}
          />
          {showVideoInput ? (
            <CapabilityToggle
              label={t("settings.videoInput")}
              published={false}
              value={binding.supportsVideo}
              onChange={(next) => updateBinding(binding.id, { supportsVideo: next })}
            />
          ) : null}
          {googleGenerativeAi ? (
            <CapabilityToggle
              label={t("settings.audioInput")}
              published={false}
              value={binding.supportsAudio}
              onChange={(next) => updateBinding(binding.id, { supportsAudio: next })}
            />
          ) : null}
          <span className="provider-chosen-capability-item">
            <Checkbox
              className="provider-chosen-capability"
              checked={binding.availableForSubagents ?? false}
              onChange={(event) =>
                updateBinding(binding.id, {
                  availableForSubagents: event.target.checked || undefined,
                })
              }
              label={t("settings.availableForSubagents")}
            />
            <HelpIcon label={t("settings.availableForSubagentsHint")} />
          </span>
          {onImageModelChange ? (
            <ImageModelToggle
              selected={imageModelSelected}
              disabled={busy}
              onChange={(next) => onImageModelChange(binding.id, next)}
            />
          ) : null}
          <span className="provider-chosen-capability-item">
            <Checkbox
              className="provider-chosen-capability"
              checked={binding.nativeWebSearch === true}
              disabled={!nativeWebSearchWireCapable}
              onChange={(event) =>
                updateBinding(binding.id, {
                  nativeWebSearch: event.target.checked || undefined,
                })
              }
              label={t("settings.nativeWebSearch")}
            />
            <HelpIcon label={nativeWebSearchHint} />
          </span>
          <span className="provider-chosen-capability-item">
            <Checkbox
              className="provider-chosen-capability"
              checked={binding.fastModeAllowed === true}
              disabled={!fastModeBilling}
              onChange={(event) =>
                updateBinding(binding.id, {
                  fastModeAllowed: event.target.checked || undefined,
                })
              }
              label={t("settings.fastModeAllowed")}
            />
            <HelpIcon label={t(fastModeHint)} />
          </span>
          <span className="provider-chosen-capability-item">
            <Checkbox
              className="provider-chosen-capability"
              checked={binding.allowEmptyThinkingSignature === true}
              disabled={busy || apiStyle !== "anthropic_messages"}
              onChange={(event) => updateBinding(binding.id, { allowEmptyThinkingSignature: event.target.checked })}
              label={t("settings.allowEmptyThinkingSignature")}
            />
            <HelpIcon label={t("settings.allowEmptyThinkingSignatureHint")} />
          </span>
        </div>
        {showVideoInput && binding.supportsVideo === true ? (
          <div className="provider-advanced-option">
            <span className="provider-chosen-field-label">
              {t("settings.videoTransport")}
              <HelpIcon label={t("settings.videoTransportHint")} />
            </span>
            <SettingsMenuSelect
              className="provider-chosen-thinking-select"
              fullWidth
              label={t("settings.videoTransport")}
              value={binding.videoTransport ?? "base64"}
              disabled={busy}
              onChange={(value) =>
                updateBinding(binding.id, { videoTransport: value as VideoTransport })
              }
              options={[
                { id: "base64", label: t("settings.videoTransportBase64") },
                { id: "url", label: t("settings.videoTransportUrl") },
                ...(googleGenerativeAi ? [] : [
                  { id: "provider-file", label: t("settings.videoTransportProviderFile") },
                ]),
              ]}
            />
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ImageModelToggle({
  selected,
  disabled,
  onChange,
}: {
  selected: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  const { t } = useTranslation();
  const label = t(selected ? "settings.imageModelSelected" : "settings.setImageModel");
  return (
    <span className="provider-chosen-capability-item">
      <Checkbox
        className="provider-chosen-capability"
        checked={selected}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
        label={label}
      />
      <HelpIcon label={t("settings.imageModelChatExclusionHint")} />
    </span>
  );
}

type TokenLimitFieldProps = {
  label: string;
  hint?: string;
  presets: readonly LimitPreset[];
  value: number | undefined;
  onChange: (tokens: number) => void;
};

function TokenLimitField({ label, hint, presets, value, onChange }: TokenLimitFieldProps) {
  const active = matchPresetIndex(presets, value);
  return (
    <div className="provider-chosen-field">
      <div className="provider-limit-field-head">
        <span className="provider-chosen-field-label">
          {label}
          {hint ? <HelpIcon label={hint} /> : null}
        </span>
        <Input
          type="number"
          min={1}
          inputMode="numeric"
          aria-label={label}
          className="provider-limit-input"
          value={value}
          onChange={(event) => onChange(Number(event.target.value) || 0)}
        />
      </div>
      <div className="provider-limit-presets" role="group" aria-label={label}>
        {presets.map((preset, index) => {
          const on = active === index;
          return (
            <TooltipButton
              key={preset.label}
              type="button"
              className={cx("provider-thinking-chip", on && "selected")}
              ariaLabel={preset.label}
              tooltip={preset.label}
              aria-pressed={on}
              onClick={() => onChange(preset.tokens)}
            >
              {preset.label}
            </TooltipButton>
          );
        })}
      </div>
    </div>
  );
}

type CapabilityToggleProps = {
  label: string;
  published: boolean;
  value: boolean | null | undefined;
  onChange: (next: boolean) => void;
};

// An untouched value follows the catalog. Every user change pins a boolean.
function CapabilityToggle({ label, published, value, onChange }: CapabilityToggleProps) {
  const effective = typeof value === "boolean" ? value : published;
  return (
    <span className="provider-chosen-capability-item">
      <Checkbox
        className="provider-chosen-capability"
        checked={effective}
        onChange={(event) => onChange(event.target.checked)}
        label={label}
      />
    </span>
  );
}
