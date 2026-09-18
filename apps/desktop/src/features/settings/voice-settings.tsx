import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, SpeechBinding, SpeechRole, SpeechStatus } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import { Input } from "../../components/ui";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { SettingsCard, SettingsRow } from "./primitives";

const NONE = "";

function presetFor(role: SpeechRole, haystack: string): Pick<SpeechBinding, "modelId" | "protocol" | "voice"> {
  const key = haystack.toLowerCase();
  if (role === "transcribe") {
    if (key.includes("groq")) return { modelId: "whisper-large-v3", protocol: "openai_audio" };
    if (key.includes("openai")) return { modelId: "whisper-1", protocol: "openai_audio" };
    return { modelId: "whisper-1", protocol: "openai_audio" };
  }
  if (key.includes("xiaomi") || key.includes("mimo")) {
    return { modelId: "mimo-v2.5-tts", protocol: "openai_chat_audio", voice: "alloy" };
  }
  if (key.includes("openai")) return { modelId: "tts-1", protocol: "openai_audio", voice: "alloy" };
  return { modelId: "tts-1", protocol: "openai_audio", voice: "alloy" };
}

function SpeechRoleFields({
  role,
  settings,
  status,
  saveSettings,
}: {
  role: SpeechRole;
  settings: AppSettings;
  status: SpeechStatus | null;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const providers = useAppStore((s) => s.providers);
  const binding = settings.speech?.[role];
  const [modelDraft, setModelDraft] = useState(binding?.modelId ?? "");
  const [voiceDraft, setVoiceDraft] = useState(binding?.voice ?? "");

  useEffect(() => {
    setModelDraft(binding?.modelId ?? "");
    setVoiceDraft(binding?.voice ?? "");
  }, [binding?.modelId, binding?.voice]);

  const protocolOptions = useMemo(() => {
    const protocols = (status?.protocols ?? []).filter((item) => item.roles.includes(role));
    return protocols.map((item) => ({ id: item.id, label: item.label }));
  }, [role, status]);

  const providerOptions = [
    { id: NONE, label: t("settings.speechNone") },
    ...providers.filter((provider) => provider.enabled !== false).map((provider) => ({
      id: provider.id,
      label: provider.name,
    })),
  ];

  const persist = async (next: SpeechBinding | undefined) => {
    const speech = { ...(settings.speech ?? {}) };
    if (!next) delete speech[role];
    else speech[role] = next;
    await saveSettings({ speech: Object.keys(speech).length ? speech : undefined });
  };

  const onProvider = async (providerId: string) => {
    if (!providerId) {
      await persist(undefined);
      return;
    }
    const provider = providers.find((item) => item.id === providerId);
    const haystack = `${provider?.vendorKey ?? ""} ${provider?.id ?? ""} ${provider?.name ?? ""}`;
    const preset = presetFor(role, haystack);
    const protocol =
      protocolOptions.some((item) => item.id === preset.protocol) ? preset.protocol : protocolOptions[0]?.id ?? preset.protocol;
    await persist({
      providerId,
      modelId: preset.modelId,
      protocol,
      ...(preset.voice ? { voice: preset.voice } : {}),
    });
  };

  const commitModel = async () => {
    const modelId = modelDraft.trim();
    if (!binding || !modelId || modelId === binding.modelId) return;
    await persist({ ...binding, modelId });
  };

  const commitVoice = async () => {
    if (role !== "synthesize" || !binding) return;
    const voice = voiceDraft.trim();
    if ((binding.voice ?? "") === voice) return;
    const next = { ...binding };
    if (voice) next.voice = voice;
    else delete next.voice;
    await persist(next);
  };

  return (
    <SettingsRow
      title={t(role === "transcribe" ? "settings.speechTranscribe" : "settings.speechSynthesize")}
      description={t(role === "transcribe" ? "settings.speechTranscribeDesc" : "settings.speechSynthesizeDesc")}
    >
      <div className="settings-speech-fields">
        <SettingsMenuSelect
          className="settings-speech-select"
          label={t("settings.speechProvider")}
          value={binding?.providerId ?? NONE}
          onChange={(id) => void onProvider(id)}
          options={providerOptions}
        />
        {binding ? (
          <>
            <SettingsMenuSelect
              className="settings-speech-select"
              label={t("settings.speechProtocol")}
              value={binding.protocol}
              onChange={(protocol) => void persist({ ...binding, protocol })}
              options={protocolOptions.length ? protocolOptions : [{ id: binding.protocol, label: binding.protocol }]}
            />
            <Input
              aria-label={t("settings.speechModel")}
              placeholder={t("settings.speechModelPlaceholder")}
              value={modelDraft}
              onChange={(event) => setModelDraft(event.target.value)}
              onBlur={() => void commitModel()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commitModel();
                }
              }}
            />
            {role === "synthesize" ? (
              <Input
                aria-label={t("settings.speechVoice")}
                placeholder={t("settings.speechVoicePlaceholder")}
                value={voiceDraft}
                onChange={(event) => setVoiceDraft(event.target.value)}
                onBlur={() => void commitVoice()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void commitVoice();
                  }
                }}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </SettingsRow>
  );
}

export function VoiceSettingsCard({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SpeechStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.speechStatus().then(
      (next) => {
        if (!cancelled) setStatus(next);
      },
      () => {
        if (!cancelled) setStatus(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [settings.speech]);

  return (
    <SettingsCard title={t("settings.speechTitle")}>
      <p className="settings-row-desc settings-speech-lead">{t("settings.speechDesc")}</p>
      <SpeechRoleFields role="transcribe" settings={settings} status={status} saveSettings={saveSettings} />
      <SpeechRoleFields role="synthesize" settings={settings} status={status} saveSettings={saveSettings} />
    </SettingsCard>
  );
}
