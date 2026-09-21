(function () {
  "use strict";

  const OUTCOMES = new Set(["running", "completed", "timed_out", "aborted", "failed", "stopped", "denied"]);

  function record(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  }

  function parseJson(value) {
    if (typeof value !== "string") return null;
    try { return JSON.parse(value); } catch { return null; }
  }

  function resultPayload(message) {
    const raw = message?.toolResult;
    const top = record(raw);
    if (!top) return parseJson(raw) || raw;
    if (record(top.details)) return top.details;
    if (record(top.data)) return top.data;
    if (Array.isArray(top.content)) {
      const joined = top.content
        .filter((item) => record(item)?.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n");
      return parseJson(joined) || (joined ? { report: joined } : top);
    }
    return top;
  }

  function bareToolName(name) {
    return String(name || "").split(".").pop().toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  function isStart(message) {
    if (message?.parentToolCallId || message?.role !== "tool") return false;
    const name = bareToolName(message.toolName);
    return name === "task" || name === "subagent" || name === "taskresume";
  }

  function executionKey(value) {
    const data = record(value);
    const key = data?.executionId ?? data?.delegationId;
    return typeof key === "string" && key ? key : "";
  }

  function startPayload(message, children) {
    let payload = record(resultPayload(message));
    const rootKey = executionKey(payload);
    for (const child of children) {
      if (child.toolName !== "TaskExecution") continue;
      const next = record(resultPayload(child));
      if (!next) continue;
      if (!rootKey || executionKey(next) === rootKey) payload = { ...(payload || {}), ...next };
    }
    return payload || {};
  }

  function timestamp(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  function ingestEntry(maps, entry, stopped) {
    const data = record(entry);
    if (!data) return;
    const key = executionKey(data);
    if (!key) return;
    const status = OUTCOMES.has(data.status) ? data.status : "";
    if (stopped || status) maps.status.set(key, stopped && (!status || status === "running") ? "stopped" : status);
    const startedAt = timestamp(data.startedAt);
    const completedAt = timestamp(data.completedAt);
    if (startedAt !== undefined || completedAt !== undefined) {
      maps.timing.set(key, { ...(maps.timing.get(key) || {}), ...(startedAt !== undefined ? { startedAt } : {}), ...(completedAt !== undefined ? { completedAt } : {}) });
    }
    if (record(data.error)) maps.error.set(key, data.error);
    if (record(data.collaboration)) maps.collaboration.set(key, data.collaboration);
    maps.snapshot.set(key, data);
  }

  function metadata(messages) {
    const maps = {
      status: new Map(), timing: new Map(), error: new Map(), collaboration: new Map(), snapshot: new Map(),
    };
    for (const message of messages) {
      const payload = record(resultPayload(message));
      if (!payload) continue;
      if (Array.isArray(payload.delegations)) payload.delegations.forEach((item) => ingestEntry(maps, item, false));
      if (Array.isArray(payload.stopped)) payload.stopped.forEach((item) => ingestEntry(maps, item, true));
      if (isStart(message) || message.toolName === "TaskExecution") ingestEntry(maps, payload, false);
    }
    // A refreshed Task/TaskExecution terminal snapshot outranks an older
    // lifecycle row that may still report running.
    for (const message of messages) {
      if (message.toolName !== "TaskExecution") continue;
      const payload = record(resultPayload(message));
      if (payload && payload.status !== "running") ingestEntry(maps, payload, false);
    }
    for (const message of messages) {
      if (!isStart(message)) continue;
      const payload = record(resultPayload(message));
      if (payload && payload.status !== "running") ingestEntry(maps, payload, false);
    }
    return maps;
  }

  function stringField(object, ...keys) {
    const data = record(object);
    for (const key of keys) if (typeof data?.[key] === "string" && data[key].trim()) return data[key].trim();
    return "";
  }

  function taskDescription(message) {
    return stringField(message?.toolArgs, "task", "instruction", "prompt");
  }

  function taskName(message, payload, children) {
    return stringField(message?.toolArgs, "description", "agent") ||
      stringField(payload, "agent") || children.find((item) => item.agentName)?.agentName || "";
  }

  function outcome(message, payload, key, maps) {
    const settled = maps.status.get(key);
    if (settled) return settled;
    if (OUTCOMES.has(payload.status)) return payload.status;
    if (message.toolStatus === "running") return "running";
    if (message.toolStatus === "error") return "failed";
    if (message.toolStatus === "denied") return "denied";
    return "completed";
  }

  function usageOf(messages) {
    let total = 0;
    let input = 0;
    let output = 0;
    let found = false;
    for (const message of messages) {
      const usage = record(message.usage);
      const toolUsage = record(message.toolUsage);
      if (typeof usage?.totalTokens === "number") {
        found = true;
        total += usage.totalTokens;
        input += Number(usage.inputTokens || 0);
        output += Number(usage.outputTokens || 0);
      } else if (typeof toolUsage?.totalTokens === "number") {
        found = true;
        total += toolUsage.totalTokens;
      }
    }
    return found ? { total, input, output } : null;
  }

  function buildTasks(messages) {
    const ordered = [...messages].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const maps = metadata(ordered);
    const childrenByParent = new Map();
    for (const message of ordered) {
      if (!message.parentToolCallId) continue;
      const list = childrenByParent.get(message.parentToolCallId) || [];
      list.push(message);
      childrenByParent.set(message.parentToolCallId, list);
    }
    const tasks = [];
    for (const message of ordered) {
      if (!isStart(message)) continue;
      const parentId = message.toolCallId || message.id;
      const children = childrenByParent.get(parentId) || [];
      const payload = startPayload(message, children);
      const key = executionKey(payload) || parentId;
      const snapshot = { ...payload, ...(maps.snapshot.get(key) || {}) };
      const collaboration = maps.collaboration.get(key) || record(snapshot.collaboration);
      const timing = { ...(maps.timing.get(key) || {}) };
      if (timestamp(snapshot.startedAt) !== undefined) timing.startedAt = snapshot.startedAt;
      if (timestamp(snapshot.completedAt) !== undefined) timing.completedAt = snapshot.completedAt;
      const execution = Number.isSafeInteger(snapshot.execution) ? snapshot.execution : 1;
      const delegationId = stringField(snapshot, "delegationId") || key.split(":")[0];
      const aliases = [...new Set([key, parentId, delegationId].filter(Boolean))];
      tasks.push({
        key,
        aliases,
        delegationId,
        execution,
        parentToolCallId: parentId,
        message,
        children,
        payload: snapshot,
        name: taskName(message, snapshot, children),
        description: taskDescription(message),
        modelId: stringField(snapshot, "modelId"),
        thinkingLevel: stringField(snapshot, "thinkingLevel"),
        outcome: outcome(message, snapshot, key, maps),
        timing,
        collaboration,
        error: maps.error.get(key) || record(snapshot.error),
        usage: usageOf(children),
        createdAt: message.createdAt,
      });
    }
    return tasks.reverse();
  }

  function sessionFrom(result) {
    return record(result)?.session || null;
  }

  function messagesFrom(result) {
    const session = sessionFrom(result);
    return Array.isArray(session?.messages) ? session.messages : [];
  }

  function mergeMessages(current, incoming) {
    const merged = new Map(current.map((item) => [item.id, item]));
    for (const item of incoming) if (item && typeof item.id === "string") merged.set(item.id, item);
    return [...merged.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  function taskMatches(task, key) {
    return !key || task.key === key || (Array.isArray(task.aliases) && task.aliases.includes(key));
  }

  function searchTask(tasks, target) {
    const messageId = String(target?.message || "");
    const query = String(target?.query || "").trim().toLowerCase();
    const exact = target?.task ? tasks.filter((task) => task.key === target.task) : [];
    const scopedTasks = exact.length ? exact : target?.task ? tasks.filter((task) => taskMatches(task, target.task)) : tasks;
    if (messageId) {
      for (const task of scopedTasks) {
        const row = [task.message, ...task.children].find((item) => item.id === messageId || item.toolCallId === messageId);
        if (row) return { task, message: row };
      }
      return null;
    }
    if (!query) return null;
    for (const task of scopedTasks) {
      for (const row of [task.message, ...task.children]) {
        const haystack = [row.content, row.thinking, row.toolName, JSON.stringify(row.toolArgs ?? ""), JSON.stringify(row.toolResult ?? "")].join("\n").toLowerCase();
        if (haystack.includes(query)) return { task, message: row };
      }
    }
    return null;
  }

  window.ObserverParser = {
    buildTasks,
    mergeMessages,
    messagesFrom,
    sessionFrom,
    resultPayload,
    searchTask,
  };
})();
