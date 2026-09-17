/**
 * 审批 / 提问 / 计划确认。
 *
 * 三者的共同限制（宿主规则，UI 不掩盖）：决议最终由电脑上的原生确认落定，
 * 手机提交只是发起；`approval.resolve` / `ask.resolve` / `plans.resolve` 都属于
 * `needsDesktopConfirmation`。收不到确认时会得到 CONFIRMATION_REQUIRED 或
 * PERMISSION_DENIED，界面据此提示。
 */

import { button, createSheet, el, inlineSpinner, prettyJson, stateBlock } from "../dom.js";
import { DECISION_LABELS, PERMISSION_MODE_LABELS } from "../protocol.js";

const DECISION_ORDER = ["allow-once", "allow-session", "deny"];
const RISK_LABELS = { low: "低风险", medium: "中风险", high: "高风险" };

/** 工具审批：卡片（转录内）与详情面板共用。 */
export function approvalCard(ctx, approval, { compact = false } = {}) {
  const card = el("div", { className: "approval-card" });
  const head = el("div", { className: "approval-kind" });
  head.append(el("span", { text: approval.kind === "tool" ? "工具需要确认" : "需要确认" }));
  if (approval.risk) head.append(el("span", { text: RISK_LABELS[approval.risk] || approval.risk }));
  card.append(head);
  card.append(el("p", { className: "approval-summary", text: approval.toolName || approval.summary || "工具调用" }));
  if (approval.reason) card.append(el("p", { className: "approval-detail", text: approval.reason }));
  if (approval.agentName) {
    card.append(el("p", { className: "approval-detail", text: `来源：子智能体 ${approval.agentName}` }));
  }
  if (!compact) {
    const preview = prettyJson(approval.argsPreview, 1200);
    if (preview) {
      const code = el("pre", { text: preview });
      card.append(code);
    }
  }
  card.append(
    el("div", {
      className: "approval-hint",
      text: "手机提交后仍需在电脑上确认（桌面原生确认）。如果电脑端拒绝，这里会提示。",
    }),
  );
  const actions = el("div", { className: "approval-actions" });
  for (const decision of DECISION_ORDER) {
    const variant = decision === "deny" ? "danger" : decision === "allow-once" ? "primary" : "secondary";
    const node = button(DECISION_LABELS[decision], {
      variant,
      size: "sm",
      onClick: () => ctx.resolveApproval(approval, decision),
    });
    node.dataset.decision = decision;
    actions.append(node);
  }
  card.append(actions);
  return card;
}

export function openApprovalSheet(ctx, approval) {
  const sheet = createSheet({
    title: "工具需要确认",
    subtitle: approval.toolCallId ? `调用 ${approval.toolCallId}` : "",
  });
  sheet.body.append(approvalCard(ctx, approval));
  const kv = el("div", { className: "kv" });
  kv.append(el("span", { className: "kv-key", text: "会话" }));
  kv.append(el("span", { className: "kv-value mono", text: approval.sessionId || "—" }));
  sheet.body.append(kv);
  if (approval.argsPreview !== undefined) {
    sheet.body.append(el("div", { className: "group-label", text: "参数" }));
    sheet.body.append(el("pre", { className: "tool-json", text: prettyJson(approval.argsPreview, 4000) || "（空）" }));
  }
  sheet.open();
  return sheet;
}

const QUESTION_SKIP_LABEL = "跳过这个问题";

/** 智能体提问：选项多选/单选 + 跳过。 */
export function openQuestionSheet(ctx, request) {
  const sheet = createSheet({ title: "智能体提问", subtitle: request.agentName ? `来自 ${request.agentName}` : "" });
  const answers = request.questions.map(() => []);
  const container = el("div", { className: "question-list" });

  request.questions.forEach((question, questionIndex) => {
    const block = el("div", { className: "question-block" });
    block.append(el("p", { className: "approval-summary", text: question.question }));
    if (question.multiSelect) block.append(el("p", { className: "option-note", text: "可多选" }));
    const options = el("div", { className: "question-options" });
    const buttons = [];
    question.options.forEach((option) => {
      const node = el("button", {
        className: "question-option",
        attrs: { type: "button", "aria-pressed": "false" },
        text: option,
      });
      let selected = false;
      node.addEventListener("click", () => {
        if (question.multiSelect) {
          selected = !selected;
        } else {
          for (const other of buttons) {
            other.setAttribute("aria-pressed", "false");
            other.dataset.selected = "false";
          }
          answers[questionIndex] = [option];
          selected = true;
        }
        node.setAttribute("aria-pressed", selected ? "true" : "false");
        node.dataset.selected = selected ? "true" : "false";
        if (question.multiSelect) {
          const current = new Set(answers[questionIndex] || []);
          if (selected) current.add(option);
          else current.delete(option);
          answers[questionIndex] = [...current];
        }
        updateSubmit();
      });
      buttons.push(node);
      options.append(node);
    });
    block.append(options);
    const skip = button(QUESTION_SKIP_LABEL, {
      variant: "ghost",
      size: "sm",
      onClick: () => {
        answers[questionIndex] = null;
        for (const node of buttons) {
          node.setAttribute("aria-pressed", "false");
          node.dataset.selected = "false";
        }
        skip.dataset.active = "true";
        updateSubmit();
      },
    });
    skip.addEventListener("click", () => {
      for (const other of container.querySelectorAll("[data-skip-active]")) {
        if (other !== skip) {
          other.dataset.skipActive = "false";
          other.dataset.active = "false";
        }
      }
      skip.dataset.skipActive = "true";
    });
    block.append(skip);
    container.append(block);
  });

  const footer = el("div", { className: "row-actions" });
  const submit = button("提交回答", {
    variant: "primary",
    onClick: async () => {
      await ctx.answerQuestion(request, answers);
      sheet.close();
    },
  });
  function updateSubmit() {
    const anyAnswer = answers.some((answer) => answer === null || (Array.isArray(answer) && answer.length));
    submit.toggleAttribute("disabled", !anyAnswer);
  }
  updateSubmit();
  footer.append(button("取消", { variant: "secondary", onClick: () => sheet.close() }), submit);
  container.append(
    el("div", {
      className: "approval-hint",
      text: "回答会提交到电脑端；智能体提问同样需要电脑上的确认才会生效。",
    }),
  );
  sheet.body.append(container, footer);
  sheet.open();
  return sheet;
}

/** 计划审批（plans.resolve）。 */
export function planCard(ctx, plan) {
  const card = el("div", { className: "approval-card" });
  const head = el("div", { className: "approval-kind" });
  head.append(el("span", { text: "计划待确认" }));
  card.append(head);
  if (plan.title) card.append(el("p", { className: "approval-summary", text: plan.title }));
  if (plan.markdown) {
    const pre = el("pre", { className: "tool-json", text: plan.markdown });
    card.append(pre);
  }
  if (plan.question) card.append(el("p", { className: "approval-detail", text: plan.question }));

  const modeRow = el("div", { className: "field" });
  modeRow.append(el("label", { className: "field-label", text: "批准后的权限模式" }));
  const select = el("select");
  const modes = ["ask", "accept-edits", "auto"];
  for (const mode of modes) {
    const option = el("option", { value: mode, text: PERMISSION_MODE_LABELS[mode] || mode });
    if (plan.targetPermissionMode === mode) option.selected = true;
    select.append(option);
  }
  modeRow.append(select);
  card.append(modeRow);

  card.append(
    el("div", {
      className: "approval-hint",
      text: "通过计划仍需要在电脑上确认；approve 必须带上权限模式。",
    }),
  );
  const actions = el("div", { className: "approval-actions" });
  actions.append(
    button("通过计划", {
      variant: "primary",
      size: "sm",
      onClick: () => ctx.resolvePlan(plan, "approve", select.value),
    }),
    button("拒绝", { variant: "danger", size: "sm", onClick: () => ctx.resolvePlan(plan, "reject", "") }),
  );
  card.append(actions);
  return card;
}

/** 待处理计数条：提示「有未决项」也能从 AgentStatus.pendingToolConfirmations 判断。 */
export function pendingBanner(ctx, state) {
  const chat = state.chat;
  const approvals = chat.pendingApprovals.length;
  const questions = chat.pendingInputs.length;
  const plans = (chat.plans || []).length;
  const statusCount = chat.status ? chat.status.pendingToolConfirmations : 0;
  const total = approvals + questions + plans;
  if (!total && !statusCount) return null;
  const banner = el("div", { className: "approval-card" });
  const parts = [];
  if (approvals) parts.push(`${approvals} 项工具审批`);
  if (questions) parts.push(`${questions} 个提问`);
  if (plans) parts.push(`${plans} 个计划`);
  banner.append(el("p", { className: "approval-summary", text: parts.length ? `待处理：${parts.join("、")}` : "电脑端报告有待处理的确认" }));
  if (!total && statusCount) {
    banner.append(
      el("div", {
        className: "approval-hint",
        text: `电脑端报告 ${statusCount} 项待确认，但事件流没有给出详情。工具审批与提问只从事件流到达；可以刷新快照或直接在电脑上处理。`,
      }),
    );
  }
  const actions = el("div", { className: "approval-actions" });
  if (approvals) {
    actions.append(
      button("查看审批", { variant: "primary", size: "sm", onClick: () => openApprovalSheet(ctx, chat.pendingApprovals[0]) }),
    );
  }
  if (questions) {
    actions.append(
      button("回答问题", { variant: "primary", size: "sm", onClick: () => openQuestionSheet(ctx, chat.pendingInputs[0]) }),
    );
  }
  actions.append(button("刷新", { variant: "secondary", size: "sm", onClick: () => ctx.refreshSession({ quiet: true }) }));
  banner.append(actions);
  return banner;
}

export function inlineSpinnerRow(label) {
  return inlineSpinner(label);
}

export { stateBlock };
