import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createHostAdapter } = require("../host-adapter.cjs");

function fixture({ loseCreateResponse = false } = {}) {
  const calls = [], sessions = new Map();
  let creates = 0;
  const model = { key: "fixture/title", providerId: "fixture", modelId: "title", providerName: "Fixture", label: "Fixture", isDefault: true, thinkingLevels: ["off"] };
  const adapter = createHostAdapter({
    models: { list: async () => [model] },
    desktop: {
      listOperations: async () => ["project/list", "session/list", "session/get", "session/create", "session/configure", "agent/prompt", "composer/commands", "agent/getStatus", "plans/pending"].map((id) => ({ id })),
      invoke: async ({ operation, args }) => {
        calls.push({ operation, args });
        if (operation === "settings/get") return { defaultProviderId: "fixture", defaultModelId: "title", defaultMode: "agent" };
        if (operation === "session/list") return { sessions: [...sessions.values()] };
        if (operation === "session/get") return { session: sessions.get(args[0].id) || null };
        if (operation === "project/list") return { projects: [{ id: 1, name: "Fixture", path: "/project" }] };
        if (operation === "session/create") {
          creates++;
          const session = { ...args[0], id: args[0].draftId || "project-session", source: "desktop", permissionMode: "inherit", messages: [] };
          sessions.set(session.id, session);
          if (loseCreateResponse && creates === 1) throw Object.assign(new Error("response lost"), { code: "TIMEOUT" });
          return { session };
        }
        if (operation === "agent/getStatus") return { running: false };
        if (operation === "agent/prompt") return { accepted: true };
        if (operation === "attachments/import") {
          assert.ok(sessions.has(args[0].sessionId));
          return { ref: "fixture-attachment", ...args[0] };
        }
        if (operation === "session/configure") {
          const session = sessions.get(args[0]);
          Object.assign(session, args[1]);
          return { session, queued: false };
        }
        if (operation === "composer/commands") return { commands: [] };
        throw new Error(`Unexpected host operation ${operation}`);
      },
    },
  });
  return { calls, sessions, get creates() { return creates; }, invoke: (op, input = {}) => adapter.invoke(op, input, { isAuthorized: () => true }) };
}

test("临时分组只返回本地无项目会话，并保留工作目录和分页", async () => {
  const f = fixture();
  for (const session of [
    { id: "first", source: "desktop", temporaryWorkspacePath: "/work", updatedAt: "2026-11-02T02:00:00Z" },
    { id: "second", source: "desktop", updatedAt: "2026-11-01T02:00:00Z" },
    { id: "project", source: "desktop", projectPath: "/project" },
    { id: "remote:host:id", source: "remote" },
    { id: "native-pi:id", source: "native-pi" },
  ]) f.sessions.set(session.id, session);
  const page = await f.invoke("sessions.list", { temporary: true, limit: 1 });
  assert.deepEqual(page.items.map((session) => session.id), ["first"]);
  assert.equal(page.items[0].temporaryWorkspacePath, "/work");
  const more = await f.invoke("sessions.list", { temporary: true, limit: 1, cursor: page.nextCursor });
  assert.deepEqual(more.items.map((session) => session.id), ["second"]);
  assert.equal(more.nextCursor, undefined);
});

test("新建、读取、配置及命令目录不提前创建临时会话，空消息也不落库", async () => {
  const f = fixture();
  const { session: draft } = await f.invoke("sessions.create", { temporary: true });
  assert.equal(draft.draft, true);
  assert.equal(f.creates, 0);
  assert.equal((await f.invoke("sessions.get", { sessionId: draft.id })).session.draft, true);
  await f.invoke("models.configure", { sessionId: draft.id, permissionMode: "auto" });
  await f.invoke("commands.list", { sessionId: draft.id });
  assert.deepEqual(f.calls.find((call) => call.operation === "composer/commands").args, [{ temporaryWorkspacePath: null }]);
  await assert.rejects(f.invoke("chat.send", { sessionId: draft.id, text: " " }), { code: "INVALID_PARAMS" });
  assert.equal(f.creates, 0);
  await f.invoke("chat.send", { sessionId: draft.id, text: "开始" });
  assert.equal(f.creates, 1);
  assert.equal(f.sessions.get(draft.id).permissionMode, "auto");
  assert.equal(f.sessions.get(draft.id).projectPath, undefined);
  assert.equal((await f.invoke("sessions.list", { temporary: true })).items.length, 1);
});

test("创建回执丢失后重试沿用同一草稿 ID，不重复创建", async () => {
  const f = fixture({ loseCreateResponse: true });
  const { session: draft } = await f.invoke("sessions.create", { temporary: true });
  const message = { sessionId: draft.id, text: "开始" };
  await assert.rejects(f.invoke("chat.send", message), { code: "TIMEOUT" });
  await f.invoke("chat.send", message);
  assert.equal(f.creates, 1);
  assert.equal(f.calls.filter((call) => call.operation === "agent/prompt").length, 1);
});

test("临时草稿的附件在正式创建后导入，项目创建行为保持不变", async (t) => {
  const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "remote-temporary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "fixture.txt");
  await writeFile(file, "fixture");
  const f = fixture();
  const { session: draft } = await f.invoke("sessions.create", { temporary: true, temporaryWorkspacePath: directory });
  await f.invoke("chat.send", { sessionId: draft.id, text: "", __attachments: [{ path: file, name: "fixture.txt", kind: "file", mimeType: "text/plain" }] });
  assert.ok(f.calls.findIndex((call) => call.operation === "session/create") < f.calls.findIndex((call) => call.operation === "attachments/import"));
  assert.equal(f.sessions.get(draft.id).temporaryWorkspacePath, draft.temporaryWorkspacePath);
  const project = await f.invoke("sessions.create", { projectId: 1 });
  assert.equal(project.session.projectPath, "/project");
  assert.equal(project.session.draft, undefined);
});

test("创建响应丢失后修改的草稿设置在重试时应用", async () => {
  const f = fixture({ loseCreateResponse: true });
  const { session: draft } = await f.invoke("sessions.create", { temporary: true });
  const message = { sessionId: draft.id, text: "开始" };
  await assert.rejects(f.invoke("chat.send", message), { code: "TIMEOUT" });
  await f.invoke("models.configure", { sessionId: draft.id, mode: "plan", permissionMode: "auto" });
  await f.invoke("chat.send", message);
  assert.equal(f.creates, 1);
  assert.equal(f.sessions.get(draft.id).mode, "plan");
  assert.equal(f.sessions.get(draft.id).permissionMode, "auto");
});

test("失效附件不建立正式会话，放弃草稿不影响正式会话", async () => {
  const f = fixture();
  const { session: draft } = await f.invoke("sessions.create", { temporary: true });
  await assert.rejects(f.invoke("chat.send", { sessionId: draft.id, text: "附件", __attachments: [{ path: "missing-remote-fixture" }] }));
  assert.equal(f.creates, 0);
  await f.invoke("sessions.discard", { sessionId: draft.id });
  assert.equal((await f.invoke("sessions.list", { temporary: true })).items.length, 0);
  await assert.rejects(f.invoke("sessions.discard", { sessionId: "project-session" }), { code: "NOT_FOUND" });
  assert.equal(f.creates, 0);
});
