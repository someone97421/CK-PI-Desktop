import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { I18nextProvider } from "react-i18next";
import i18n from "i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { ChatTranscript } from "../../apps/desktop/src/features/chat/transcript/ChatTranscript";
import { TranscriptDisclosureProvider } from "../../apps/desktop/src/features/chat/transcript/disclosure";
import { captureTranscriptReadingPosition, forgetTranscriptReadingState } from "../../apps/desktop/src/lib/transcript-reading-position";

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function frames(count = 12) { for (let n = 0; n < count; n++) await frame(); }
function assert(value: unknown, label: string): asserts value { if (!value) throw new Error(label); }

function turns(start: number, end: number): UiMessage[] {
  return Array.from({ length: end - start }, (_, n) => {
    const id = `folded-${start + n}`;
    const createdAt = "2026-11-01T00:00:00Z";
    const task = { id, status: "completed" as const, usageIncomplete: true, finalMessageId: `${id}-answer` };
    return [
      { id: `${id}-user`, role: "user" as const, content: `检查第 ${start + n} 项`, createdAt, taskId: id, task },
      { id: `${id}-intro`, role: "assistant" as const, status: "complete" as const, createdAt, taskId: id, task,
        content: Array.from({ length: 10 }, (_, k) => `隐藏的过程段落 ${k}。${"过程说明。".repeat(30)}`).join("\n\n") },
      { id: `${id}-tool`, role: "tool" as const, content: "完成", createdAt, taskId: id, task,
        toolName: "Read", toolCallId: `${id}-call`, toolStatus: "success" as const, toolArgs: { path: "example.ts" } },
      { id: `${id}-answer`, role: "assistant" as const, status: "complete" as const, createdAt, taskId: id, task,
        content: n % 3 ? `第 ${start + n} 项已完成。` : `第 ${start + n} 项已完成。\n\n${"较长的最终回答。".repeat(120)}\n\n\`\`\`ts\nconst done = true;\n\`\`\`` },
    ];
  }).flat();
}

/** 真实 ChatTranscript、任务抽屉、消息样式与分页，只使用合成数据。 */
export async function foldedHistoryProbe() {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;display:flex;flex-direction:column;background:var(--ds-bg-base)";
  document.body.append(host);
  const root = createRoot(host);
  const sessionId = "folded-history-regression";
  forgetTranscriptReadingState(sessionId);
  let current = turns(20, 40);
  let more = true;
  let mount = 0;
  let calls = 0;
  let finish: (() => void) | undefined;
  const load = () => new Promise<void>(resolve => { calls++; finish = resolve; });
  const render = () => flushSync(() => root.render(<I18nextProvider i18n={i18n}>
    <TranscriptDisclosureProvider key={mount} sessionId={sessionId}>
      <ChatTranscript sessionId={sessionId} messages={current} isRunning={false} hasMoreBefore={more} onLoadOlder={load} />
    </TranscriptDisclosureProvider>
  </I18nextProvider>));
  const scroller = () => host.querySelector<HTMLElement>(".thread-scroll")!;
  const content = () => host.querySelector<HTMLElement>(".thread-content")!;
  const top = (node: HTMLElement) => node.getBoundingClientRect().top - scroller().getBoundingClientRect().top;
  const wait = async (predicate: () => boolean, label: string) => {
    const deadline = performance.now() + 6000;
    while (!predicate()) { assert(performance.now() < deadline, label); await frame(); }
  };
  const scroll = (to: number) => {
    const el = scroller();
    el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: to - el.scrollTop }));
    el.scrollTo({ top: to, behavior: "instant" });
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  };
  const failures: string[] = [];
  const check = (value: unknown, label: string) => { if (!value) failures.push(label); };
  try {
    render();
    await wait(() => !host.querySelector('[data-transcript-settling="true"]'), "折叠历史首屏未稳定");
    await frames();
    // 在折叠标题处开始阅读，隐藏的过程正文不能抢占阅读锚点。
    const title = host.querySelector<HTMLElement>('[data-minimap-id="folded-22-answer"] .task-process-summary')!;
    assert(title, "任务抽屉标题缺失");
    scroll(scroller().scrollTop + top(title) - 80);
    await frames();
    const position = captureTranscriptReadingPosition(scroller(), content(), false, 60);
    const chosen = position?.messageId ? content().querySelector<HTMLElement>(`[data-message-id="${position.messageId}"]`) : null;
    check(!chosen?.closest("details:not([open])"), `隐藏正文抢占锚点：${position?.messageId}`);

    await wait(() => Boolean(finish), "折叠历史未触发分页");
    const travel = async (delta: number) => {
      const el = scroller();
      const start = top(title);
      let previous = start;
      let reversal = 0;
      el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: delta < 0 ? "PageUp" : "PageDown" }));
      el.scrollTo({ top: el.scrollTop + delta, behavior: "smooth" });
      for (let n = 0; n < 36; n++) {
        await new Promise<void>(resolve => {
          const observer = new ResizeObserver(() => { observer.disconnect(); resolve(); });
          requestAnimationFrame(() => observer.observe(el));
        });
        const next = top(title);
        reversal = Math.max(reversal, (next - previous) * Math.sign(delta));
        previous = next;
      }
      check((top(title) - start) * -Math.sign(delta) > 20, "折叠历史滚动未前进");
      check(reversal <= 1, `折叠历史滚动发生反向回拉 ${reversal}px`);
      return reversal;
    };
    const pendingReversal = Math.max(await travel(-60), await travel(60));
    // 请求中改变阅读位置，补页必须保住新的位置。
    scroll(scroller().scrollTop + 75);
    await frames(3);
    const baseline = top(title);
    const samples: number[] = [];
    let sampling = true;
    const sample = () => {
      const observer = new ResizeObserver(() => { observer.disconnect(); if (sampling) samples.push(top(title)); });
      observer.observe(scroller());
      if (sampling) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    const resolve = finish!; finish = undefined;
    current = [...turns(0, 20), ...current]; more = false;
    render(); resolve();
    await wait(() => !host.querySelector('.transcript-history-loading[aria-hidden="false"]'), "折叠分页未结束");
    await frames(); sampling = false;
    const drift = Math.max(...samples.map(value => Math.abs(value - baseline)), 0);
    check(drift <= 1, `折叠分页的绘制帧偏移 ${drift}px`);
    check(calls === 1, `折叠分页重复请求 ${calls} 次`);
    const settledReversal = Math.max(await travel(-120), await travel(120));
    const near = content().querySelectorAll(":scope > [data-transcript-nearby]");
    check(near.length > 0 && near.length < content().querySelectorAll(":scope > [data-reading-anchor]").length,
      "消息预布局应覆盖附近行，并保留远处行的离屏优化");

    // native details 的展开选择也要跨 React 卸载保留。
    title.click(); await frames();
    check(title.closest("details")?.open, "任务抽屉未展开");
    mount++; render(); await frames();
    const reopened = content().querySelector<HTMLDetailsElement>('[data-minimap-id="folded-22-answer"] details');
    check(reopened?.open, "任务抽屉重新挂载后丢失展开状态");
    const reopenedTitle = reopened!.querySelector<HTMLElement>("summary")!;
    const beforeCollapse = top(reopenedTitle);
    reopenedTitle.click(); await frames();
    check(!reopened!.open, "任务抽屉未收起");
    const collapseDrift = Math.abs(top(reopenedTitle) - beforeCollapse);
    check(collapseDrift <= 1, `收起任务抽屉移动标题 ${collapseDrift}px`);
    assert(failures.length === 0, failures.join("；"));
    return { ok: true, calls, frames: samples.length, maxDrift: drift, pendingReversal, settledReversal,
      nearbyRows: near.length, drawerRetained: true, collapseDrift };
  } finally {
    finish?.();
    flushSync(() => root.unmount()); host.remove(); forgetTranscriptReadingState(sessionId);
  }
}

declare global { var foldedHistoryProbe: () => Promise<unknown>; }
globalThis.foldedHistoryProbe = foldedHistoryProbe;
