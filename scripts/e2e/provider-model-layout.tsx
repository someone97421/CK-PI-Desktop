import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import type { ModelBinding, ProviderPublic } from "@pi-desktop/shared";
import { ProviderSetupDialog } from "../../apps/desktop/src/components/settings/ProviderSetupDialog";
import { VendorAccountDialog } from "../../apps/desktop/src/components/settings/VendorAccountDialog";
import { api } from "../../apps/desktop/src/lib/api";

const assert = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const models: ModelBinding[] = Array.from({ length: 60 }, (_, index) => ({
  id: `model-${String(index).padStart(2, "0")}`, contextWindow: 32000, maxTokens: 4000,
  thinkingLevels: ["off"], defaultThinkingLevel: "off",
}));
const provider: ProviderPublic = {
  id: "fixture", name: "Fixture", vendorKey: "custom", type: "openai_compatible",
  protocol: "openai_compatible", enabled: true, authKind: "none", apiStyle: "chat_completions",
  baseUrl: "http://127.0.0.1:9/v1", hasSecret: false, supportsReasoning: false,
  supportedThinkingLevels: ["off"], createdAt: "", updatedAt: "", models,
};
// Only model discovery's IPC boundary is faked; React, dialogs, hooks and CSS are real.
api.listProviderModels = async () => ({ models: models.map((model) => ({
  modelId: model.id, displayName: model.id, providerId: provider.id, source: "discovered",
  capabilities: ["text"], supportedThinkingLevels: ["off"],
})), source: "remote" });

async function probe(vendor: boolean) {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(<I18nextProvider i18n={i18n}>
      {vendor
        ? <VendorAccountDialog provider={provider} initialName="Fixture" onClose={() => {}} onSave={() => {}} saving={false} />
        : <ProviderSetupDialog provider={provider} onClose={() => {}} onSaved={() => {}} />}
    </I18nextProvider>));
    const deadline = performance.now() + 5000;
    while (document.querySelector(".provider-models-list")?.children.length !== 60 && performance.now() < deadline) await frame();
    // Wait for the production opening animation before measuring geometry.
    await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished));
    const heights: number[] = [];
    for (const selector of [".provider-models-list", ".provider-chosen-list"]) {
      const list = document.querySelector<HTMLElement>(selector)!;
      assert(list?.children.length === 60, `${selector}: full model list missing`);
      const first = list.firstElementChild as HTMLElement;
      const last = list.lastElementChild as HTMLElement;
      assert(list.clientHeight >= first.getBoundingClientRect().height, `${selector}: list cannot display even one complete row (height=${list.clientHeight})`);
      for (const row of [last, first]) {
        list.scrollTop = row === last ? list.scrollHeight : 0;
        row.scrollIntoView({ block: "nearest" });
        await frame();
        const item = row.getBoundingClientRect();
        const bounds = list.getBoundingClientRect();
        const body = document.querySelector<HTMLElement>(vendor ? ".vendor-account-body" : ".provider-setup-body")!.getBoundingClientRect();
        assert(item.top >= Math.max(bounds.top, body.top, 0) - 1 && item.bottom <= Math.min(bounds.bottom, body.bottom, innerHeight) + 1,
          `${selector}: ${row === last ? "last" : "first"} model is clipped`);
      }
      heights.push(list.clientHeight);
    }
    const panes = document.querySelector<HTMLElement>(".provider-setup-panes")!;
    const trays = [...panes.children].map((child) => child.getBoundingClientRect());
    assert(innerWidth <= 940 ? trays[1].top >= trays[0].bottom : trays[1].left >= trays[0].right,
      "narrow panes must stack; wide panes must stay side by side");
    return { vendor, viewport: [innerWidth, innerHeight], heights };
  } finally { flushSync(() => root.unmount()); host.remove(); }
}
Object.assign(globalThis, { providerModelLayoutProbe: probe });
