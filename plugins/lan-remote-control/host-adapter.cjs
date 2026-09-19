"use strict";

const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const definitions = {
  capabilities: [false],
  "projects.list": [false, "project/list"],
  "workspace.get": [false, "project/get"],
  "sessions.list": [false, "session/list"],
  "sessions.get": [false, "session/get"],
  "sessions.messages": [false, "session/get"],
  "sessions.pending": [false, "plans/pending"],
  "models.list": [false],
  "commands.list": [false, "composer/commands"],
  "subagents.list": [false, "subagent/catalog"],
  "queue.list": [false, "queue/list"],
  "collaboration.get": [false, "session/collaboration/get"],
  "attachments.read": [false, "fs/read"],
  "plans.list": [false, "plans/pending"],
  "sessions.create": [true, "session/create"],
  "sessions.fork": [true, "session/fork"],
  "chat.send": [true, "agent/prompt", true],
  "chat.edit": [true, "agent/prompt", true],
  "chat.retry": [true, "agent/prompt"],
  "chat.stop": [true, "agent/stop"],
  "queue.push": [true, "queue/push", true],
  "queue.remove": [true, "queue/remove"],
  "queue.prioritize": [true, "queue/prioritize"],
  "queue.reorder": [true, "queue/reorder"],
  "queue.edit": [true, "queue/remove"],
  "models.configure": [true, "session/configure"],
  "approval.resolve": [true, "tool/resolvePermission"],
  "ask.resolve": [true, "agent/askTool/resolve"],
  "plans.resolve": [true, "plans/resolve"],
};
const OPERATION_META = Object.fromEntries(
  Object.entries(definitions).map(([name, [mutation, host, attachments]]) => [
    name,
    {
      mutation,
      host,
      attachments: !!attachments,
    },
  ]),
);
const READ_OPERATIONS = Object.keys(definitions).filter(
  (x) => !definitions[x][0],
);
const MUTATION_OPERATIONS = Object.keys(definitions).filter(
  (x) => definitions[x][0],
);
function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}
function text(value, name, max = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail("INVALID_PARAMS", `${name} 无效`);
  return value.trim();
}
function pick(value, keys) {
  return Object.fromEntries(
    keys.filter((k) => value?.[k] !== undefined).map((k) => [k, value[k]]),
  );
}
function session(s) {
  return {
    ...pick(s, [
      "id",
      "title",
      "projectId",
      "projectPath",
      "mode",
      "permissionMode",
      "providerId",
      "modelId",
      "thinkingLevel",
      "createdAt",
      "updatedAt",
      "source",
    ]),
    modelKey: s.providerId && s.modelId ? `${s.providerId}/${s.modelId}` : null,
    running: !!s.running,
  };
}
function attachment(a) {
  return {
    ...pick(a, ["kind", "name", "mimeType", "size"]),
    ref: a.ref || a.path,
  };
}
function message(m) {
  return {
    ...pick(m, [
      "id",
      "role",
      "content",
      "createdAt",
      "status",
      "thinking",
      "steering",
      "command",
      "tool",
      "taskId", "task", "parentToolCallId", "agentName",
      "toolName", "toolCallId", "toolStatus", "toolArgs", "toolResult",
      "toolDurationMs", "toolCompletedAt", "isError", "usage", "toolUsage",
      "modelId", "providerId", "error",
    ]),
    attachments: (m.attachments || []).map(attachment),
  };
}
function queueItem(e) {
  return {
    turnId: e.id || e.turnId,
    content: e.content,
    position: e.position,
    priority: e.priority,
    locked: e.priority !== undefined,
    createdAt: e.createdAt,
    attachments: (e.attachments || []).map(attachment),
  };
}
function createHostAdapter(pi) {
  let catalogue;
  const requests = new AsyncLocalStorage();
  function assertAuthorized() {
    const context = requests.getStore();
    if (context && !context.isAuthorized())
      fail("UNAUTHORIZED", "设备授权已撤销");
  }
  const subscriptions = new Map(),
    drafts = new Map(),
    references = new Map(),
    locks = new Map();
  async function host(op, args = []) {
    assertAuthorized();
    return pi.desktop.invoke({
      operation: op,
      args,
      // 密码登录已授权远控操作，宿主控制器仍要求显式 confirm。
      confirm: true,
    });
  }
  async function ops() {
    if (!catalogue)
      catalogue = new Set((await pi.desktop.listOperations()).map((x) => x.id));
    return catalogue;
  }
  async function capabilities() {
    const available = await ops();
    return {
      operations: Object.fromEntries(
        Object.entries(OPERATION_META).map(([name, meta]) => [
          name,
          {
            ...meta,
            supported: !meta.host || available.has(meta.host),
            reason:
              meta.host && !available.has(meta.host)
                ? "宿主缺少此接口"
                : undefined,
          },
        ]),
      ),
      events: {
        subscribe: typeof pi.desktop.subscribe === "function",
        snapshotPending: typeof pi.desktop.getSessionSnapshot === "function",
      },
      limits: {
        maxTextPromptChars: 120000,
        maxAttachmentBytes: 10 * 1024 * 1024,
        maxAttachments: 8,
      },
    };
  }
  function remember(id, messages) {
    let index = references.get(id);
    if (!index) {
      index = new Map();
      references.set(id, index);
    }
    for (const m of messages)
      for (const a of m.attachments || []) {
        if (a.ref || a.path) index.set(a.ref || a.path, attachment(a));
      }
    while (index.size > 1000) index.delete(index.keys().next().value);
    while (references.size > 64)
      references.delete(references.keys().next().value);
  }
  async function rawSession(id, input = {}) {
    const result = await host("session/get", [
      {
        id,
        messageLimit: Math.min(200, Math.max(1, Number(input.limit) || 50)),
        ...(Number.isInteger(input.before)
          ? { messageBefore: input.before }
          : {}),
        ...(input.messageId ? { messageAround: input.messageId } : {}),
      },
    ]);
    if (!result?.session) fail("NOT_FOUND", "会话不存在");
    remember(id, result.session.messages || []);
    return result.session;
  }
  async function live(id) {
    if (typeof pi.desktop.getSessionSnapshot !== "function") return null;
    try {
      return await pi.desktop.getSessionSnapshot({ sessionId: id });
    } catch (error) {
      if (["UNSUPPORTED", "NOT_FOUND"].includes(error.code)) return null;
      throw error;
    }
  }
  async function pending(id, snap) {
    const result = await host("plans/pending", [{ sessionId: id }]);
    return {
      approvals: (snap?.pendingApprovals || []).map((a) => ({
        ...a,
        approvalId: a.id || a.approvalId,
        resolveWith: a.kind === "tool" ? "approval.resolve" : "plans.resolve",
      })),
      questions: (snap?.pendingInputs || []).map((a) => ({
        ...a,
        inputId: a.id || a.inputId,
      })),
      plans: result?.plans || [],
      complete: !!snap,
      notes: snap ? [] : ["宿主不支持完整实时快照"],
    };
  }
  async function status(id) {
    const v = await host("agent/getStatus", [id]);
    const s = v?.status && typeof v.status === "object" ? v.status : v;
    return { ...s, running: !!(s?.running ?? s?.isRunning) };
  }
  async function entries(id) {
    const result = await host("queue/list", [{ sessionId: id }]);
    const rows = result?.entries || [];
    remember(id, rows);
    return rows;
  }
  async function imported(id, input) {
    const list = input.__attachments || [];
    if (!Array.isArray(list) || list.length > 8)
      fail("INVALID_PARAMS", "附件数量超过限制");
    const result = [];
    for (const item of list) {
      const info = await fs.lstat(item.path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 10 * 1024 * 1024
      )
        fail("INVALID_PARAMS", "附件不可用");
      const bytes = await fs.readFile(item.path);
      const a = await host("attachments/import", [
        {
          sessionId: id,
          name: item.name,
          mimeType: item.mimeType,
          kind: item.kind,
          size: bytes.length,
          dataBase64: bytes.toString("base64"),
        },
      ]);
      result.push({
        path: a.ref,
        name: a.name,
        kind: a.kind,
        mimeType: a.mimeType,
        size: a.size,
      });
    }
    return result;
  }
  async function execute(op, input = {}) {
    if (!OPERATION_META[op]) fail("OPERATION_NOT_ALLOWED", "未知远程操作");
    if (op === "capabilities") return capabilities();
    const available = await ops();
    if (definitions[op][1] && !available.has(definitions[op][1]))
      fail("UNSUPPORTED", "宿主不支持此操作");
    if (op === "projects.list") {
      const r = await host("project/list");
      return {
        items: (r.projects || r.items || []).map((p) => ({
          ...pick(p, ["id", "name", "path"]),
          name: p.name || p.path?.split(/[\\/]/).pop() || "项目",
        })),
      };
    }
    if (op === "workspace.get") return { project: await host("project/get") };
    if (op === "sessions.list") {
      const r = await host("session/list");
      const projects = input.projectId
        ? (await execute("projects.list")).items
        : [];
      const project = projects.find((p) => p.id === input.projectId);
      let items = (r.sessions || [])
        .filter(
          (s) =>
            !input.projectId ||
            s.projectId === input.projectId ||
            (project && s.projectPath === project.path),
        )
        .map(session);
      const start = Math.max(0, Number(input.cursor) || 0),
        limit = Math.min(100, Math.max(1, Number(input.limit) || 50));
      return {
        items: items.slice(start, start + limit),
        nextCursor:
          start + limit < items.length ? String(start + limit) : undefined,
      };
    }
    if (op === "models.list") {
      const models = await pi.models.list();
      return {
        items: models.map((m) => ({
          ...pick(m, [
            "providerId",
            "modelId",
            "thinkingLevels",
            "contextWindow",
            "maxTokens",
            "capabilities",
          ]),
          key: m.key || `${m.providerId}/${m.modelId || m.id}`,
          label: m.label || m.name || m.modelId || m.id,
        })),
      };
    }
    if (op === "commands.list") {
      const r = await host("composer/commands", [
        { sessionId: text(input.sessionId, "sessionId") },
      ]);
      return {
        items: (Array.isArray(r) ? r : r.commands || []).map((command) => ({
          ...command,
          supported: ["skill", "template"].includes(command.kind),
        })),
        context: { scope: "session-project" },
      };
    }
    if (op === "subagents.list") {
      const result = await host("subagent/catalog", [
        { sessionId: text(input.sessionId, "sessionId") },
      ]);
      return {
        items: (result.subagents || []).map((agent) =>
          pick(agent, ["name", "description", "model", "tools"]),
        ),
      };
    }
    if (op === "sessions.create") {
      const projects = (await execute("projects.list")).items;
      const project = projects.find((p) => p.id === input.projectId);
      if (!project) fail("INVALID_PARAMS", "请选择已有项目");
      const r = await host("session/create", [
        {
          projectId: project.id,
          projectPath: project.path,
          title:
            typeof input.title === "string"
              ? input.title.slice(0, 200)
              : undefined,
        },
      ]);
      return { session: session(r.session) };
    }
    const id = text(input.sessionId, "sessionId");
    if (op === "sessions.get" || op === "sessions.messages") {
      const s = await rawSession(id, input),
        rows = (s.messages || []).map(message);
      const page = {
        items: rows,
        cursor: s.messageStart ?? 0,
        hasMoreBefore: !!(s.messageWindow?.hasMoreBefore || s.hasMoreBefore),
      };
      if (op === "sessions.messages") return page;
      const snap = await live(id);
      return {
        session: session(s),
        status: await status(id),
        pending: await pending(id, snap),
        messages: page,
        snapshot: snap ? { ...snap, available: true } : { available: false },
        collaboration: null,
      };
    }
    if (op === "sessions.pending") return pending(id, await live(id));
    if (op === "queue.list")
      return { items: (await entries(id)).map(queueItem) };
    if (op === "plans.list") {
      const r = await host("plans/pending", [{ sessionId: id }]);
      return { items: r.plans || [] };
    }
    if (op === "collaboration.get")
      return host("session/collaboration/get", [{ sessionId: id }]);
    if (op === "sessions.fork") {
      await rawSession(id);
      const r = await host("session/fork", [
        { sessionId: id, ...pick(input, ["throughMessageId", "title"]) },
      ]);
      return { session: session(r.session) };
    }
    if (op === "chat.stop") {
      await rawSession(id);
      const r = await host("agent/stop", [{ sessionId: id }]);
      return { stopped: r?.requested !== false };
    }
    if (op === "models.configure") {
      const s = await rawSession(id);
      const config = {
        mode: input.mode || s.mode,
        ...pick(input, ["thinkingLevel", "permissionMode"]),
      };
      if (input.modelKey) {
        const model = (await execute("models.list")).items.find(
          (m) => m.key === input.modelKey,
        );
        if (!model) fail("INVALID_PARAMS", "模型不可用");
        config.providerId = model.providerId;
        config.modelId = model.modelId;
      }
      const r = await host("session/configure", [id, config]);
      return { session: session(r.session) };
    }
    if (op.startsWith("queue.") && op !== "queue.push") {
      const row = (await entries(id)).find(
        (e) => (e.id || e.turnId) === input.turnId,
      );
      if (!row) fail("NOT_FOUND", "队列项不存在");
      if (row.priority !== undefined) fail("QUEUE_LOCKED", "优先组已锁定");
      if (op === "queue.prioritize") {
        await host("queue/prioritize", [{ turnId: row.id }]);
        await host("agent/stop", [{ sessionId: id }]);
        return { item: queueItem(row) };
      }
      if (op === "queue.reorder") {
        if (!["up", "down"].includes(input.direction))
          fail("INVALID_PARAMS", "移动方向无效");
        return host("queue/reorder", [
          { turnId: row.id, direction: input.direction },
        ]);
      }
      if (op === "queue.edit") {
        for (const [key, draft] of drafts)
          if (draft.expires < Date.now()) drafts.delete(key);
        if (drafts.size >= 200)
          fail("RATE_LIMITED", "队列草稿过多，请先发送已有草稿");
      }
      await host("queue/remove", [{ turnId: row.id }]);
      if (op === "queue.edit") {
        const draftId = crypto.randomUUID();
        drafts.set(draftId, {
          sessionId: id,
          attachments: row.attachments || [],
          expires: Date.now() + 7200000,
        });
        return {
          removed: true,
          draft: {
            id: draftId,
            text: row.content,
            attachments: (row.attachments || []).map(attachment),
          },
        };
      }
      return { removed: true };
    }
    if (["chat.send", "chat.edit", "chat.retry", "queue.push"].includes(op)) {
      let content = typeof input.text === "string" ? input.text : "",
        attachments = await imported(id, input),
        truncate;
      if (input.queuedDraftId) {
        const d = drafts.get(input.queuedDraftId);
        if (!d || d.sessionId !== id || d.expires < Date.now())
          fail("NOT_FOUND", "队列草稿已失效");
        attachments = [
          ...d.attachments.filter(
            (a) =>
              !(input.omitQueuedAttachmentRefs || []).includes(a.ref || a.path),
          ),
          ...attachments,
        ];
      }
      const running = (await status(id))?.running;
      if (op === "chat.edit" || op === "chat.retry") {
        if (running) fail("SESSION_BUSY", "请先停止当前生成");
        const s = await rawSession(id, {
          limit: 200,
          messageId: input.messageId,
        });
        const target = input.messageId
          ? (s.messages || []).find((m) => m.id === input.messageId)
          : [...(s.messages || [])].reverse().find((m) => m.role === "user");
        if (!target || target.role !== "user")
          fail("NOT_FOUND", "用户消息不存在");
        truncate = target.id;
        if (op === "chat.retry") content = target.content;
        attachments = attachments.length
          ? attachments
          : (target.attachments || []).map((a) => ({ ...a, path: a.ref }));
      }
      if (!content.trim() && !attachments.length)
        fail("INVALID_PARAMS", "消息不能为空");
      if (content.length > 120000) fail("INVALID_PARAMS", "消息过长");
      const queued = op === "queue.push" || (op === "chat.send" && running);
      const r = await host(queued ? "queue/push" : "agent/prompt", [
        {
          sessionId: id,
          content,
          attachments,
          ...(truncate ? { truncateFromMessageId: truncate } : {}),
        },
      ]);
      if (input.queuedDraftId) drafts.delete(input.queuedDraftId);
      return queued
        ? {
            accepted: true,
            mode: "queue",
            item: queueItem(r.entry || r),
            queueItemId: r.entry?.id || r.id,
          }
        : { ...r, mode: "prompt" };
    }
    if (op === "approval.resolve") {
      const p = await pending(id, await live(id));
      const a = p.approvals.find(
        (a) => a.approvalId === input.approvalId && a.kind === "tool",
      );
      if (!a) fail("NOT_FOUND", "审批已处理");
      if (!(a.allowedDecisions || []).includes(input.decision))
        fail("INVALID_PARAMS", "审批选项无效");
      await host("tool/resolvePermission", [
        { requestId: a.approvalId, decision: input.decision },
      ]);
      return { resolved: true };
    }
    if (op === "ask.resolve") {
      const p = await pending(id, await live(id));
      const q = p.questions.find((q) => q.inputId === input.inputId);
      if (!q) fail("NOT_FOUND", "问题已处理");
      if (
        !Array.isArray(input.answers) ||
        input.answers.length !== q.questions.length ||
        input.answers.some(
          (a) =>
            a !== null &&
            (!Array.isArray(a) ||
              a.some((v) => typeof v !== "string" || v.length > 10000)),
        )
      )
        fail("INVALID_PARAMS", "回答格式无效");
      await host("agent/askTool/resolve", [
        { requestId: q.inputId, sessionId: id, answers: input.answers },
      ]);
      return { resolved: true };
    }
    if (op === "plans.resolve") {
      const plans = (await execute("plans.list", { sessionId: id })).items;
      const p = plans.find((p) => (p.id || p.proposalId) === input.proposalId);
      if (!p) fail("NOT_FOUND", "计划已处理");
      if (!["approve", "reject"].includes(input.action))
        fail("INVALID_PARAMS", "决议无效");
      await host("plans/resolve", [
        {
          proposalId: p.id || p.proposalId,
          sessionId: id,
          turnId: p.turnId,
          toolCallId: p.toolCallId,
          action: input.action,
          ...pick(input, ["version", "targetPermissionMode"]),
        },
      ]);
      return { resolved: true };
    }
    if (op === "attachments.read") {
      await rawSession(id, { limit: 200 });
      const a = references.get(id)?.get(input.ref);
      if (!a) fail("NOT_FOUND", "附件不属于此会话");
      if (a.kind === "image") {
        const r = await host("fs/readImageDataUrl", [
          { ref: a.ref, mimeType: a.mimeType },
        ]);
        return {
          kind: "image",
          dataUrl: typeof r === "string" ? r : r.dataUrl,
          size: a.size,
        };
      }
      const r = await host("fs/read", [{ path: a.ref, sessionId: id }]);
      return {
        kind: "text",
        content: typeof r === "string" ? r : r.content || r.text,
        size: a.size,
      };
    }
    fail("UNSUPPORTED", "尚未支持该操作");
  }
  async function invokeAuthorized(op, input) {
    assertAuthorized();
    const key = OPERATION_META[op]?.mutation ? input?.sessionId : null;
    if (!key) return execute(op, input);
    const previous = locks.get(key) || Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(() => {
        assertAuthorized();
        return execute(op, input);
      });
    locks.set(key, task);
    try {
      return await task;
    } finally {
      if (locks.get(key) === task) locks.delete(key);
    }
  }
  return {
    capabilities,
    invoke: (op, input, context) =>
      requests.run(context, () => invokeAuthorized(op, input)),
    async subscribe(sessionId) {
      if (subscriptions.has(sessionId)) return subscriptions.get(sessionId);
      if (typeof pi.desktop.subscribe !== "function")
        fail("UNSUPPORTED", "宿主缺少实时订阅能力");
      const pending = pi.desktop.subscribe({ sessionId });
      subscriptions.set(sessionId, pending);
      try {
        return await pending;
      } catch (error) {
        if (subscriptions.get(sessionId) === pending)
          subscriptions.delete(sessionId);
        throw error;
      }
    },
    async unsubscribe(sessionId) {
      const s = subscriptions.get(sessionId);
      subscriptions.delete(sessionId);
      if (s) {
        const resolved = await s;
        await pi.desktop.unsubscribe(resolved.subscriptionId);
      }
    },
  };
}
module.exports = {
  createHostAdapter,
  OPERATION_META,
  READ_OPERATIONS,
  MUTATION_OPERATIONS,
};
