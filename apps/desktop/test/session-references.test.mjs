import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { formatSessionLink, parseSessionLinks } = await import("@pi-desktop/shared");
const { formatSessionExcerpt, resolveSessionReferences } = await import(
  "../electron/main/session-references.ts"
);

const PROJECT = "/Users/dev/project";

/** Only the host surface the resolver uses: `session.get`. */
function fakeHost(sessions) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push([method, params]);
      return { session: sessions[params?.id] };
    },
  };
}

const silentLogger = { app() {} };

test("a session excerpt is bounded, ordered, and states what it left out", () => {
  const messages = Array.from({ length: 6 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index}`,
  }));
  const text = formatSessionExcerpt(
    { id: "session-a", title: "Nightly review", messages },
    64,
  );
  assert.match(text, /Referenced conversation "Nightly review" \(session-a\)/);
  assert.match(text, /\(session-a\)\. \d+ messages? shown in order, newest last, \d+ earlier messages?/);
  assert.match(text, /omitted for length/);
  const lines = text.split("\n").filter((line) => /^[a-z][a-z ]*: /.test(line));
  assert.ok(lines.length > 0 && lines.length < messages.length, "the tail stays, the head is cut");
  assert.equal(lines.at(-1), "assistant: message 5", "newest message last");
  assert.ok(text.length <= 200, "the whole excerpt stays near the requested bound");
});

test("an empty reference never produces an excerpt", () => {
  assert.equal(formatSessionExcerpt({ id: "session-a", messages: [] }), "");
  assert.equal(
    formatSessionExcerpt({ id: "session-a", messages: [{ role: "user", content: "  " }] }),
    "",
  );
});

test("session links resolve against their own project only", async () => {
  const host = fakeHost({
    "same-project": {
      id: "same-project",
      title: "Dependency sweep",
      projectPath: PROJECT,
      messages: [
        { role: "user", content: "check the lockfile" },
        { role: "assistant", content: "two advisories" },
      ],
    },
    "other-project": {
      id: "other-project",
      title: "Elsewhere",
      projectPath: "/Users/dev/other",
      messages: [{ role: "user", content: "secret" }],
    },
  });

  const content = `please continue from ${formatSessionLink("same-project")} and ${formatSessionLink(
    "other-project",
  )}`;
  const attachments = await resolveSessionReferences({
    host,
    logger: silentLogger,
    sessionId: "current",
    projectPath: PROJECT,
    content,
  });

  assert.equal(attachments.length, 1, "only the same-project reference is attached");
  assert.deepEqual(
    { kind: attachments[0].kind, name: attachments[0].name, ref: attachments[0].ref },
    { kind: "session", name: "Dependency sweep", ref: "same-project" },
  );
  assert.match(attachments[0].text, /user: check the lockfile/);
  assert.match(attachments[0].text, /assistant: two advisories/);
  assert.deepEqual(
    host.calls.map(([, params]) => params.id),
    ["same-project", "other-project"],
    "each link is read through the host with a bounded window",
  );
  assert.equal(host.calls[0][1].id, "same-project");
  assert.ok(host.calls[0][1].messageLimit > 0 && host.calls[0][1].contentLimit > 0);
  assert.deepEqual(parseSessionLinks(content), ["same-project", "other-project"]);
});

test("the current session is never referenced and a missing one is skipped", async () => {
  const host = fakeHost({});
  const attachments = await resolveSessionReferences({
    host,
    logger: silentLogger,
    sessionId: "current",
    projectPath: PROJECT,
    content: `${formatSessionLink("current")} ${formatSessionLink("missing")}`,
  });
  assert.deepEqual(attachments, []);
  assert.deepEqual(
    host.calls.map(([, params]) => params.id),
    ["missing"],
    "a self-reference is dropped before any read",
  );
});

test("a resolved reference keeps the message text untouched", async () => {
  const host = fakeHost({
    "session-a": {
      id: "session-a",
      title: "A",
      projectPath: PROJECT,
      messages: [{ role: "user", content: "hi" }],
    },
  });
  const content = `see ${formatSessionLink("session-a")}`;
  await resolveSessionReferences({
    host,
    logger: silentLogger,
    sessionId: "current",
    projectPath: PROJECT,
    content,
  });
  assert.equal(content, `see ${formatSessionLink("session-a")}`);
});

test("临时会话仅引用相同独立工作目录的会话", async () => {
  const host = fakeHost({
    same: { id: "same", temporaryWorkspacePath: `${PROJECT}/`, messages: [{ role: "user", content: "same root" }] },
    other: { id: "other", temporaryWorkspacePath: "/Users/dev/other", messages: [{ role: "user", content: "other root" }] },
    scratch: { id: "scratch", messages: [{ role: "user", content: "scratch only" }] },
    project: { id: "project", projectPath: PROJECT, messages: [{ role: "user", content: "project session" }] },
  });
  const attachments = await resolveSessionReferences({
    host, logger: silentLogger, sessionId: "current", temporaryWorkspacePath: PROJECT,
    content: ["same", "other", "scratch", "project"].map(formatSessionLink).join(" "),
  });
  assert.deepEqual(attachments.map((attachment) => attachment.ref), ["same"]);
  assert.match(attachments[0].text, /same root/);
});

test("未选目录的临时会话保持原有会话引用作用域", async () => {
  const host = fakeHost({
    scratch: { id: "scratch", messages: [{ role: "user", content: "shared temporary scope" }] },
    bound: { id: "bound", temporaryWorkspacePath: PROJECT, messages: [{ role: "user", content: "bound root" }] },
  });
  const attachments = await resolveSessionReferences({
    host, logger: silentLogger, sessionId: "current",
    content: `${formatSessionLink("scratch")} ${formatSessionLink("bound")}`,
  });
  assert.deepEqual(attachments.map((attachment) => attachment.ref), ["scratch"]);
});
