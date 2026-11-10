import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { readFileSync } from "node:fs";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { remoteWorkspaceForFiles } = await import("../electron/main/remote/workspace-file-scope.ts");

test("native file views resolve the sidecar session instead of the selected Desktop workspace", async () => {
  const host = { call: () => assert.fail("native identity reached Desktop storage") };
  const sidecar = { async call(method, input) {
    assert.equal(method, "native.session.get");
    assert.equal(input.id, "native-pi:fixture");
    return { session: { projectPath: "C:/fixture/native-project", source: "pi-native" } };
  } };
  assert.equal(await remoteWorkspaceForFiles(() => host, "native-pi:fixture", () => sidecar), null);
});

test("unavailable native sources fail closed without Desktop workspace fallback", async () => {
  const host = { call: () => assert.fail("native identity reached Desktop storage") };
  await assert.rejects(remoteWorkspaceForFiles(() => host, "native-pi:missing", () => null), { errorCode: "HOST_UNAVAILABLE" });
  const sidecar = { call: async () => ({ session: null }) };
  await assert.rejects(remoteWorkspaceForFiles(() => host, "native-pi:missing", () => sidecar), { errorCode: "NOT_FOUND" });
});

test("a replaced sidecar cannot publish a stale native file root", async () => {
  let finish;
  const host = { call: () => assert.fail("native identity reached Desktop storage") };
  let sidecar = { call: () => new Promise(resolve => { finish = resolve; }) };
  const pending = remoteWorkspaceForFiles(() => host, "native-pi:fixture", () => sidecar);
  sidecar = null;
  finish({ session: { projectPath: "C:/fixture" } });
  await assert.rejects(pending, { errorCode: "HOST_UNAVAILABLE", message: "session source replaced" });
});

test("文件入口为 native Pi 使用 sidecar，并保留 fork 工作目录解析", () => {
  const source = readFileSync(new URL("../electron/main/ipc/workspace-ipc.ts", import.meta.url), "utf8");
  const fileWorkspace = source.slice(source.indexOf("const fileWorkspace ="), source.indexOf("handle(IPC.invoke.fsList"));
  assert.match(fileWorkspace, /scope\.sessionId\.startsWith\("native-pi:"\)/);
  assert.match(fileWorkspace, /sessionForFiles\(getHost, scope\.sessionId, getSidecar\)/);
  assert.match(fileWorkspace, /resolveSessionWorkspace\(host, scope\.sessionId\)/);
  assert.match(fileWorkspace, /scope\.temporaryWorkspacePath/);
  assert.match(source, /id\.startsWith\("native-pi:"\) \|\| !host\) return null/);
});
