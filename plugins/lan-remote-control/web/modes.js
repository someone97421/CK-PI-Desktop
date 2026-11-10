import { el, button } from "./dom.js";
import { describeError } from "./protocol.js";

const STATES = { running: "运行中", waiting: "等待中", paused: "已暂停", budget_exhausted: "预算已用尽", finished: "已结束", stopped: "已停止" };
const WAITS = { approval: "等待阶段审批", retries: "重试已用尽", turn_end: "等待输入", error: "等待处理错误" };

function budgetValue(text, field) {
  const value = text.trim();
  if (!value) return null;
  if (!/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return undefined;
  return field === "maxTurns"
    ? number >= 1 && number <= 10_000 ? number : undefined
    : number >= 1_000 ? number : undefined;
}

/** 只展示宿主快照，阶段推进与预算判断交由宿主。 */
export function createModeRunCard({ info, sessionId, isCurrent, mutate, refresh, isBusy, setBusy, onError, openSheet }) {
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
  const add = (label, operation, action, title) => controls.append(button(label, {
    preserveLabel: true, title, disabled: isBusy(), onClick: () => void submit(operation, { action }),
  }));
  controls.append(button("刷新状态", { preserveLabel: true, disabled: isBusy(), onClick: () => void reload() }));
  if (run && info.supported) {
    const open = ["running", "waiting", "paused", "budget_exhausted"].includes(run.state);
    if (open && info.updates && openSheet) controls.append(button("编辑目标与预算", {
      preserveLabel: true, disabled: isBusy(), onClick: edit,
    }));
    if (info.controls) {
      if (["running", "waiting"].includes(run.state)) add("暂停", "modes.run.control", "pause", "暂停后收尾当前轮，继续时恢复运行");
      if (["paused", "budget_exhausted"].includes(run.state)) add("继续", "modes.run.control", "resume");
      if (open) {
        add("停止运行", "modes.run.control", "stop", "停止后续调度并中断当前轮");
        add("移除运行", "modes.run.control", "remove", "移除后续调度，当前轮按返回模式继续");
      }
    }
    if (info.approvals && run.state === "waiting" && run.waitReason === "approval") {
      add("批准阶段", "modes.run.resolve", "approve");
      add("拒绝阶段", "modes.run.resolve", "reject");
    }
  }
  function edit() {
    if (!isCurrent() || isBusy()) return;
    const sheet = openSheet({ title: "编辑目标与预算" });
    const objective = el("textarea", { value: run.input || "", rows: 4, attrs: { "aria-label": "运行目标" } });
    const maxTurns = el("input", { value: run.maxTurns == null ? "" : String(run.maxTurns),
      attrs: { type: "text", inputmode: "numeric", placeholder: "不限", "aria-label": "最多轮次" } });
    const maxTokens = el("input", { value: run.maxTokens == null ? "" : String(run.maxTokens),
      attrs: { type: "text", inputmode: "numeric", placeholder: "不限", "aria-label": "最多 Token" } });
    const feedback = el("p", { className: "sheet-hint", attrs: { role: "status", "aria-live": "polite" } });
    sheet.body.append(el("label", { className: "sheet-field" }, "运行目标", objective),
      el("div", { className: "remote-mode-budget" },
        el("label", { className: "sheet-field" }, "最多轮次", maxTurns),
        el("label", { className: "sheet-field" }, "最多 Token", maxTokens)), feedback);
    function request() {
      const input = objective.value.trim();
      const turns = budgetValue(maxTurns.value, "maxTurns"), tokens = budgetValue(maxTokens.value, "maxTokens");
      const validInput = !!input && new TextEncoder().encode(input).length <= 100_000;
      objective.setAttribute("aria-invalid", String(!validInput));
      maxTurns.setAttribute("aria-invalid", String(turns === undefined));
      maxTokens.setAttribute("aria-invalid", String(tokens === undefined));
      if (!validInput || turns === undefined || tokens === undefined) return null;
      return {
        ...(input !== run.input ? { input } : {}),
        ...(turns !== (run.maxTurns ?? null) || tokens !== (run.maxTokens ?? null) ? { budget: { maxTurns: turns, maxTokens: tokens } } : {}),
      };
    }
    const save = button("保存", { variant: "primary", preserveLabel: true, onClick: () => {
      if (!sheet.isOpen() || !isCurrent() || isBusy()) return;
      const fields = request();
      if (!fields) return;
      if (!Object.keys(fields).length) { sheet.close(); return; }
      void submit("modes.run.update", fields, sheet);
    } });
    const validate = () => {
      const valid = request() !== null;
      save.disabled = !valid || isBusy();
      feedback.textContent = valid ? "下一轮生效；预算留空表示不限。" : "目标不能为空且至多 100000 字节；轮次填 1–10000，Token 填至少 1000 的安全整数，或留空不限。";
    };
    for (const input of [objective, maxTurns, maxTokens]) input.addEventListener("input", validate);
    sheet.panel.append(el("div", { className: "sheet-foot" },
      button("取消", { variant: "secondary", onClick: () => sheet.close() }), save));
    validate();
  }
  async function reload() {
    try { if (isCurrent()) await refresh(); }
    catch (error) { if (isCurrent() && card.isConnected) hint.textContent = describeError(error); }
  }
  async function submit(operation, fields, sheet) {
    if (!isCurrent() || isBusy()) return;
    setBusy(true);
    sheet?.setBusy(true);
    for (const control of controls.querySelectorAll("button")) control.disabled = true;
    try {
      await mutate(operation, { sessionId, runId: run.id, expectedRevision: run.revision, ...fields });
      if (sheet) { sheet.setBusy(false); sheet.close(); }
      if (isCurrent()) await refresh();
    } catch (error) {
      sheet?.setBusy(false);
      if (isCurrent()) {
        onError?.(error);
        // 失败后重新读取 CAS 水位，未决提交仍由共用恢复面板处理。
        await refresh().catch(() => {});
        if (isCurrent()) {
          if (sheet?.isOpen()) sheet.showError(describeError(error));
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
