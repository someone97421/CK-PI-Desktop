import { el, button } from "./dom.js";
import { describeError } from "./protocol.js";

const STATES = { running: "运行中", waiting: "等待中", paused: "已暂停", budget_exhausted: "预算已用尽", finished: "已结束", stopped: "已停止" };
const WAITS = { approval: "等待阶段审批", retries: "重试已用尽", turn_end: "等待输入", error: "等待处理错误" };

/** 只展示宿主快照，阶段推进与预算判断交由宿主。 */
export function createModeRunCard({ info, sessionId, isCurrent, mutate, refresh, isBusy, setBusy, onError }) {
  if (!info) return null;
  const run = info.run;
  if (!run && !info.error) return null;
  const card = el("section", { className: "approval-card remote-mode-run", attrs: { "aria-label": "模式运行" } });
  const hint = el("p", { className: "sheet-hint", attrs: { role: "status", "aria-live": "polite" } });
  const controls = el("div", { className: "remote-mode-controls" });
  card.append(el("strong", { text: run ? `${run.modeId} · ${run.stageId}` : "模式状态暂不可用" }));
  if (run) {
    card.append(el("p", { text: run.state === "waiting" ? WAITS[run.waitReason] || STATES.waiting : STATES[run.state] || run.state }),
      el("small", { text: `轮次 ${run.roundsCompleted} / ${run.maxTurns ?? "∞"} · Token ${run.tokensUsed} / ${run.maxTokens ?? "∞"}` }));
    if (run.lastError) hint.textContent = run.lastError;
  } else hint.textContent = info.error;
  card.append(hint, controls);
  const add = (label, operation, action) => controls.append(button(label, {
    preserveLabel: true, disabled: isBusy(), onClick: () => void submit(operation, action),
  }));
  controls.append(button("刷新状态", { preserveLabel: true, disabled: isBusy(), onClick: () => void reload() }));
  if (run && info.supported) {
    const open = ["running", "waiting", "paused", "budget_exhausted"].includes(run.state);
    if (info.controls) {
      if (["running", "waiting"].includes(run.state)) add("暂停", "modes.run.control", "pause");
      if (["paused", "budget_exhausted"].includes(run.state)) add("继续", "modes.run.control", "resume");
      if (open) add("停止运行", "modes.run.control", "stop");
    }
    if (info.approvals && run.state === "waiting" && run.waitReason === "approval") {
      add("批准阶段", "modes.run.resolve", "approve");
      add("拒绝阶段", "modes.run.resolve", "reject");
    }
  }
  async function reload() {
    try { if (isCurrent()) await refresh(); }
    catch (error) { if (isCurrent() && card.isConnected) hint.textContent = describeError(error); }
  }
  async function submit(operation, action) {
    if (!isCurrent() || isBusy()) return;
    setBusy(true);
    for (const control of controls.querySelectorAll("button")) control.disabled = true;
    try {
      await mutate(operation, { sessionId, runId: run.id, expectedRevision: run.revision, action });
      if (isCurrent()) await refresh();
    } catch (error) {
      if (isCurrent()) {
        onError?.(error);
        // 失败后重新读取 CAS 水位，未决提交仍由共用恢复面板处理。
        await refresh().catch(() => {});
        if (isCurrent()) {
          const target = document.querySelector(".remote-mode-run .sheet-hint");
          if (target) target.textContent = describeError(error);
          else if (card.isConnected) hint.textContent = describeError(error);
        }
      }
    } finally {
      setBusy(false);
      if (isCurrent()) {
        for (const control of document.querySelectorAll(".remote-mode-controls button")) control.disabled = false;
      }
    }
  }
  return card;
}
