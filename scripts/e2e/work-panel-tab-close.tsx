import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { WorkPanel } from "../../apps/desktop/src/components/workpanel/WorkPanel";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";

/*
  Renderer-level regression for #1762: the active tab's close control must sit
  inside the tab strip's viewport and be the element the pointer would hit,
  after a narrow panel and after a resize that keeps the same active tab.

  Source assertions cannot prove this — the maintainer asked for actual
  geometry and hit target, and DOM geometry plus `elementFromPoint` is what
  this environment can honestly measure. Native Win32 hit testing stays in
  scripts/e2e-work-panel-drag.mjs for the drag regions.
*/

type CloseGeometry = {
  stage: string;
  tabId: string;
  stripLeft: number;
  stripRight: number;
  stripClientWidth: number;
  closeLeft: number;
  closeRight: number;
  insideStrip: boolean;
  hitIsClose: boolean;
  hitIsDescendant: boolean;
};
declare global {
  var tabCloseProbe: (stage: string) => Promise<CloseGeometry>;
}

const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};

const host = document.createElement("div");
host.style.cssText = "position:absolute;left:0;top:0;height:600px;display:flex";
document.body.append(host);
const root = createRoot(host);
const i18n = createInstance();
const ready = i18n.init({
  lng: "en",
  resources: { en: { translation: catalogs.en } },
  interpolation: { escapeValue: false },
});

function element(selector: string): HTMLElement {
  const found = host.querySelector<HTMLElement>(selector);
  if (!found) throw new Error("Missing " + selector);
  return found;
}

async function rendered() {
  await Promise.all(document.getAnimations().map((a) => a.finished));
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

function renderPanel(containerWidth: number) {
  // The panel's own width comes from the store; `containerWidth` is the shell
  // budget. Resize the host so the strip's box actually changes. Each probe
  // stage starts from the stylesheet width, even when React reuses the strip.
  const existingStrip = host.querySelector<HTMLElement>(".work-panel-tab-strip");
  existingStrip?.style.removeProperty("flex");
  existingStrip?.style.removeProperty("width");
  host.style.width = `${containerWidth}px`;
  flushSync(() => {
    useAppStore.setState({
      activeSessionId: "tab-close-a",
      workPanelWidth: Math.min(300, Math.max(244, containerWidth - 40)),
      pluginViews: [],
    });
    root.render(
      <I18nextProvider i18n={i18n}>
        <WorkPanel containerWidth={containerWidth} sidebarCollapsed />
      </I18nextProvider>,
    );
  });
}

function click(selector: string) {
  flushSync(() => element(selector).click());
}

/** Long labels are what pushes the close control past the overflow edge. */
function openManyLongTabs(count: number) {
  for (let i = 0; i < count; i += 1) click(".work-panel-new-tab");
}

function activeTabId(): string {
  const id = useAppStore.getState().activeWorkPanelTabId;
  assert(id, "no active tab");
  return id!;
}

function measure(stage: string): CloseGeometry {
  const strip = element(".work-panel-tab-strip");
  const stripRect = strip.getBoundingClientRect();
  const tabId = activeTabId();
  const wrapper = host.querySelector<HTMLElement>(
    `[data-work-panel-tab-id="${CSS.escape(tabId)}"]`,
  );
  assert(wrapper, "active tab wrapper missing");
  const close = wrapper!.querySelector<HTMLElement>(".work-panel-tab-close");
  assert(close, "active tab close control missing");
  const closeRect = close!.getBoundingClientRect();

  const centerX = closeRect.x + closeRect.width / 2;
  const centerY = closeRect.y + closeRect.height / 2;
  const hit = document.elementFromPoint(centerX, centerY);

  return {
    stage,
    tabId,
    stripLeft: stripRect.left,
    stripRight: stripRect.right,
    stripClientWidth: strip.clientWidth,
    closeLeft: closeRect.left,
    closeRight: closeRect.right,
    // The control must be fully inside the strip's client box. A sub-pixel
    // tolerance keeps a fractional device pixel ratio from failing the probe.
    insideStrip:
      closeRect.left >= stripRect.left - 0.5 && closeRect.right <= stripRect.right + 0.5,
    hitIsClose: hit === close,
    hitIsDescendant: !!hit && (close!.contains(hit) || hit.contains(close!)),
  };
}

globalThis.tabCloseProbe = async (stage) => {
  await ready;

  if (stage === "narrow-active") {
    renderPanel(900);
    openManyLongTabs(10);
    await rendered();
    const strip = element(".work-panel-tab-strip");
    assert(strip.scrollWidth > strip.clientWidth, "tabs did not overflow the strip");
    return measure(stage);
  }

  if (stage === "resize-same-tab") {
    // Render wide first so every tab fits, then narrow the panel without
    // changing `activeTabId` or `tabs.length` — the exact case the maintainer
    // flagged: the reveal effect's dependencies do not change.
    renderPanel(1400);
    openManyLongTabs(10);
    await rendered();
    const before = measure("before-resize");
    assert(before.insideStrip, "fixture invalid: close control clipped before the resize");

    // Resize the strip's actual scrollport while leaving the active tab and tab
    // count untouched. The wide fixture above confirms that the close control
    // fits before this resize; 80px forces it out of view until the observer
    // reveals the same active tab again.
    const strip = element(".work-panel-tab-strip");
    strip.style.flex = "0 0 80px";
    strip.style.width = "80px";
    await rendered();
    const after = measure(stage);
    assert(
      after.stripClientWidth < before.stripClientWidth,
      "fixture invalid: the tab strip scrollport did not narrow",
    );
    return after;
  }

  if (stage === "hover-inactive") {
    // Wide enough for a real panel: 560 leaves the panel squeezed to a sliver
    // because MAIN_PANE_MIN_WIDTH (450) eats the budget.
    renderPanel(1000);
    openManyLongTabs(10);
    await rendered();
    // Park the strip mid-list so a tab is clipped by the inline-end edge while
    // the active tab is elsewhere. That is the state the issue describes: a
    // partly visible inactive tab whose close control appears on hover.
    const stripEl = element(".work-panel-tab-strip");
    stripEl.scrollLeft = Math.floor((stripEl.scrollWidth - stripEl.clientWidth) / 2);
    await rendered();
    const stripRect0 = stripEl.getBoundingClientRect();
    const all = [...host.querySelectorAll<HTMLElement>(".work-panel-tab")];
    // Pick the inactive tab nearest the inline-end edge that is still partly
    // inside: its close control is the one at risk of being clipped.
    const candidate = all
      .filter((node) => node.dataset.workPanelTabId !== activeTabId())
      .filter((node) => {
        const r = node.getBoundingClientRect();
        return r.right > stripRect0.left && r.left < stripRect0.right;
      })
      .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0];
    assert(candidate, "no partly visible inactive tab to hover");
    const first = candidate!;
    const firstId = first.dataset.workPanelTabId;
    assert(firstId && firstId !== activeTabId(), "fixture invalid: hovered tab is active");
    // React delegates from the root, and `pointerenter` does not bubble, so a
    // synthetic dispatch never reaches the handler. `pointerover` bubbles and
    // is what the platform sends on entering an element.
    flushSync(() => {
      first!.dispatchEvent(
        new PointerEvent("pointerover", { bubbles: true, cancelable: true }),
      );
    });
    await rendered();
    const strip = element(".work-panel-tab-strip");
    const stripRect = strip.getBoundingClientRect();
    const close = first!.querySelector<HTMLElement>(".work-panel-tab-close");
    assert(close, "hovered tab has no close control");
    const rect = close!.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
    );
    return {
      stage,
      tabId: firstId!,
      stripLeft: stripRect.left,
      stripRight: stripRect.right,
      stripClientWidth: strip.clientWidth,
      closeLeft: rect.left,
      closeRight: rect.right,
      insideStrip: rect.left >= stripRect.left - 0.5 && rect.right <= stripRect.right + 0.5,
      hitIsClose: hit === close,
      hitIsDescendant: !!hit && (close!.contains(hit) || hit.contains(close!)),
    };
  }

  throw new Error("Unknown tab-close probe stage: " + stage);
};
