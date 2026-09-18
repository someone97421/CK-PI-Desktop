// 任务元数据优先；旧历史只按用户输入分组，不估算结束时间。
export function buildProcessTimeline(messages, tools) {
  const rows = messages.filter((m) => !m.parentToolCallId).map((m) => ({ ...m }));
  for (const [id, tool] of tools) {
    if (tool.parentToolCallId) continue;
    const existing = rows.find((m) => m.role === "tool" && (m.toolCallId || m.id) === id);
    const row = {
      ...existing, id: existing?.id || `live-tool:${id}`, role: "tool",
      toolCallId: id, toolName: tool.toolName || existing?.toolName,
      toolArgs: tool.args ?? existing?.toolArgs,
      toolResult: tool.result ?? tool.partialResult ?? existing?.toolResult,
      toolStatus: tool.running ? "running" : tool.isError ? "error" : "success",
      createdAt: existing?.createdAt || tool.createdAt,
      taskId: existing?.taskId || tool.taskId,
      isError: tool.isError ?? existing?.isError,
    };
    if (existing) Object.assign(existing, row);
    else {
      const time = Date.parse(row.createdAt);
      const after = Number.isFinite(time) ? rows.findIndex((m) => Date.parse(m.createdAt) > time) : -1;
      if (after < 0) rows.push(row); else rows.splice(after, 0, row);
    }
  }
  const summaries = new Map();
  for (const row of rows) {
    if (!row.task?.id) continue;
    const previous = summaries.get(row.task.id);
    if (!previous || (previous.status === "running" && row.task.status !== "running")
      || (previous.status === row.task.status && (row.task.revision ?? 0) >= (previous.revision ?? 0))) summaries.set(row.task.id, row.task);
  }
  const entries = [], groups = new Map();
  let fallback = "history", active;
  for (const row of rows) {
    const taskId = row.taskId || row.task?.id;
    if (row.role === "user" && !row.steering) {
      entries.push({ message: row });
      fallback = row.id;
      active = null;
      continue;
    }
    const key = taskId || active?.key || `legacy:${fallback}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, task: summaries.get(taskId), rows: [], finalId: null };
      groups.set(key, group);
      entries.push(group);
    }
    group.rows.push(row);
    active = group;
  }
  for (const group of groups.values()) {
    const task = group.task;
    if (task?.status === "completed") {
      const last = task.finalMessageId
        ? group.rows.find((m) => m.id === task.finalMessageId)
        : group.rows.filter((m) => m.role === "assistant" || m.role === "tool").at(-1);
      if (last?.role === "assistant" && last.status === "complete" && !last.error && last.content?.trim()) group.finalId = last.id;
    } else if (!task || task.status === "running") {
      const last = group.rows.at(-1);
      if (last?.role === "assistant" && last.content) group.finalId = last.id;
    }
  }
  return { entries, rows };
}

export function processSummary(task) {
  if (!task) return { label: "工作过程", detail: "历史记录未提供任务耗时" };
  const start = Date.parse(task.startedAt), end = Date.parse(task.endedAt);
  const elapsed = Number.isFinite(start) && (Number.isFinite(end) || task.status === "running")
    ? Math.max(0, Math.round(((Number.isFinite(end) ? end : Date.now()) - start) / 1000)) : null;
  const duration = elapsed === null ? "" : elapsed >= 60 ? `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒` : `${elapsed} 秒`;
  const status = { running: "工作中", completed: "已工作", aborted: "已停止", failed: "执行失败" }[task.status] || "工作过程";
  const usage = task.usage;
  const tokens = Number.isFinite(usage?.totalTokens) ? `${usage.totalTokens.toLocaleString()} tokens` : "token 未报告";
  const detail = [tokens, task.usageIncomplete ? "统计不完整" : "", task.estimatedDuration ? "耗时为估算值" : ""].filter(Boolean).join(" · ");
  const breakdown = usage ? [
    ["输入", usage.inputTokens], ["输出", usage.outputTokens], ["缓存读取", usage.cacheReadTokens],
    ["缓存写入", usage.cacheWriteTokens], ["推理", usage.reasoningTokens],
  ].filter(([, value]) => Number.isFinite(value)).map(([name, value]) => `${name} ${value.toLocaleString()}`).join(" · ") : "";
  return { label: `${task.estimatedDuration ? "≈ " : ""}${status}${duration ? ` ${duration}` : ""}`, detail, breakdown };
}
