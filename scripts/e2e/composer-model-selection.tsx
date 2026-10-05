import { ComposerModelPicker } from "../../apps/desktop/src/features/chat/composer/ComposerModelPicker";
import { createInstance } from "i18next";
import { en } from "@pi-desktop/i18n";
const i18n = createInstance();
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ModelInfo, ProviderPublic, SessionThinkingLevel } from "@pi-desktop/shared";
import { useComposerModelMenu } from "../../apps/desktop/src/features/chat/composer/hooks/useComposerModelMenu";
import { useAppStore } from "./fixtures/composer-model-selection-store";

type MenuController = ReturnType<typeof useComposerModelMenu>;

declare global {
  var composerModelSelectionProbe: () => Promise<{
    model: string;
    switchedLevel: string;
    level: string;
    writes: Array<{ providerId?: string; modelId?: string; thinkingLevel: SessionThinkingLevel }>;
  }>;
  var composerModelSelectionController: MenuController | undefined;
}

const provider: ProviderPublic = {
  id: "fixture-provider",
  name: "Fixture provider",
  vendorKey: "custom",
  type: "openai_compatible",
  protocol: "openai_compatible",
  enabled: true,
  authKind: "none",
  hasSecret: false,
  models: [
    { id: "model-c", contextWindow: 32000, maxTokens: 4000, thinkingLevels: [], defaultThinkingLevel: null },
    { id: "model-d", contextWindow: 32000, maxTokens: 4000, thinkingLevels: [], defaultThinkingLevel: null },
    { id: "model-a", contextWindow: 32_000, maxTokens: 4_000, thinkingLevels: ["low", "high"], defaultThinkingLevel: "high" },
    { id: "model-b", contextWindow: 32_000, maxTokens: 4_000, thinkingLevels: ["low", "high"], defaultThinkingLevel: "high" },
  ],
  supportsReasoning: true,
  supportedThinkingLevels: ["low", "high"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const models: ModelInfo[] = ["model-a", "model-b"].map((modelId) => ({
  modelId,
  displayName: modelId === "model-a" ? "Model A" : "Model B",
  providerId: provider.id,
  reasoning: true,
  supportedThinkingLevels: ["low", "high"],
  capabilities: ["text", "reasoning"],
  source: "user",
}));

useAppStore.setState({ providers: [provider], providerModels: { [provider.id]: models },
  recentModels: ["model-d", "model-c", "model-b", "model-a"].map(modelId => ({ providerId: provider.id, modelId })),
});

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const writes: Array<{ providerId?: string; modelId?: string; thinkingLevel: SessionThinkingLevel }> = [];

function Fixture() {
  const [modelId, setModelId] = useState("model-a");
  // Start with a manual value that differs from Model A's default.
  const [thinkingLevel, setThinkingLevel] = useState<SessionThinkingLevel>("low");
  const controller = useComposerModelMenu({
    mode: "agent",
    activeSessionId: "fixture-session",
    provider,
    modelId,
    thinkingProvider: undefined,
    thinkingLevel,
    controlsBlocked: false,
    configureActiveSession: async (configuration) => {
      writes.push(configuration);
      setModelId(configuration.modelId ?? "model-a");
      setThinkingLevel(configuration.thinkingLevel);
    },
  });
  globalThis.composerModelSelectionController = controller;
  return (
    <div className="composer-stack" style={{ position: "absolute", left: 120, top: 300, width: 640 }}>
      <ComposerModelPicker
        t={i18n.t} controller={controller} modelLabel={modelId}
        thinkingLabel={thinkingLevel} thinkingLevel={thinkingLevel}
        selectedProviderId={provider.id} selectedModelId={modelId}
        controlsBlocked={false} onCloseOtherMenus={() => {}}
      />
      <span className="selected-model">{modelId}</span>
      <span className="selected-thinking-level">{thinkingLevel}</span>
    </div>
  );
}

const settle = () => new Promise<void>((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
);

globalThis.composerModelSelectionProbe = async () => {
  await i18n.init({ lng: "en", resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  flushSync(() => root.render(<Fixture />));
  await settle();
  document.querySelector<HTMLButtonElement>(".composer-model-thinking-chip")!.click();
  await settle();
  const recentRows = Array.from(document.querySelectorAll<HTMLButtonElement>(".composer-menu-root [role=menuitemradio]"));
  if (recentRows.length !== 3 || !recentRows[0].textContent?.includes("model-d") || !recentRows[2].textContent?.includes("model-b")) {
    throw new Error("The first model menu must show exactly the three most recent models in order");
  }
  recentRows[2].dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  await settle();
  const otherModels = document.querySelector<HTMLButtonElement>(".composer-menu-root [aria-expanded]")!;
  otherModels.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  otherModels.focus();
  await settle();
  if (document.querySelector(".composer-model-list .kb-active")) {
    throw new Error("Moving from a recent model to Other models must clear stale keyboard highlight");
  }
  const keyboardSearch = document.querySelector<HTMLInputElement>(".composer-model-search input")!;
  keyboardSearch.focus();
  keyboardSearch.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await settle();
  if (!document.querySelector(".composer-model-list .kb-active")) throw new Error("Arrow navigation must highlight a model");
  otherModels.focus();
  // The offscreen window does not own OS focus; deliver the native focusout edge.
  keyboardSearch.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: otherModels }));
  await settle();
  if (document.querySelector(".composer-model-list .kb-active")) throw new Error("Leaving search must clear keyboard highlight");
  recentRows[2].click();
  await settle();
  if (!document.querySelector(".composer-menu-root [role=menuitemradio]")?.textContent?.includes("model-d")) {
    throw new Error("Selecting without sending must preserve actual usage order");
  }

  const switchedLevel = document.querySelector(".selected-thinking-level")?.textContent?.trim() ?? "";
  await globalThis.composerModelSelectionController!.commitThinkingLevel("low");
  await settle();
  const disclosure = document.querySelector<HTMLButtonElement>(".composer-menu-root [aria-expanded]")!;
  disclosure.click();
  await settle();
  const expandedRows = document.querySelectorAll(".composer-model-list [role=menuitemradio]");
  if (expandedRows.length !== 4) throw new Error("Expanded models must appear once in the same list");
  const recentStyle = getComputedStyle(expandedRows[0]);
  const otherStyle = getComputedStyle(expandedRows[3]);
  if (recentStyle.fontSize !== otherStyle.fontSize || recentStyle.fontWeight !== otherStyle.fontWeight) {
    throw new Error(`Model typography differs: recent ${recentStyle.fontSize}/${recentStyle.fontWeight}, other ${otherStyle.fontSize}/${otherStyle.fontWeight}`);
  }
  disclosure.click();
  await settle();
  const search = document.querySelector<HTMLInputElement>(".composer-model-search input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "model-b");
  search.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
  const restored = useAppStore.getState().recentModels;
  if (restored[0]?.modelId !== "model-d") throw new Error("Menu interactions alone must not record usage");
  useAppStore.setState({ recentModels: [] });
  await settle();
  if (document.querySelectorAll(".composer-model-list [role=menuitemradio]").length !== 4) {
    throw new Error("Without history all configured models must be directly visible");
  }
  useAppStore.setState({ recentModels: restored });
  await settle();
  return {
    model: document.querySelector(".selected-model")?.textContent?.trim() ?? "",
    switchedLevel,
    level: document.querySelector(".selected-thinking-level")?.textContent?.trim() ?? "",
    writes: [...writes],
  };
};
