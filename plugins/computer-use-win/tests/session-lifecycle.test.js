"use strict";
// Fake EventEmitter children only. Never spawns cua-driver or injects input.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const sourcePath = path.join(__dirname, "..", "runtime.js");

function fixture() {
  const children = [];
  const initializers = [];
  const sandbox = {
    module: { exports: {} }, Buffer, console, setTimeout, clearTimeout,
    __dirname: path.dirname(sourcePath), process: { platform: "win32", env: {} },
    require(name) {
      if (name === "./powershell") return { resolvePowerShell: () => "powershell.exe" };
      if (name === "node:child_process") return {
        spawn() {
          const child = new EventEmitter();
          child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
          child.stdout.setEncoding = child.stderr.setEncoding = () => {};
          child.stdin = { write() {}, end() {} };
          child.kill = () => { child.killed = true; };
          children.push(child);
          return child;
        },
        spawnSync() { throw new Error("Native calls forbidden in lifecycle tests"); },
      };
      if (name === "./overlay") return { ControlBanner: class {} };
      if (name === "./cua") return {};
      if (name === "./policy") return require("../policy");
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(sourcePath, "utf8"), sandbox, { filename: sourcePath });
  const runtime = Object.create(sandbox.module.exports.ComputerUseRuntime.prototype);
  Object.assign(runtime, { targets: new Map(), pending: new Map(), settings: {}, info: {}, nextId: 1,
    status: "stopped", stoppedByUser: false, _starting: null, _nativeMenuContext: null,
    queue: Promise.resolve(), banner: { stop() {} } });
  runtime.binaryPath = () => ({ mcpCommand: "C:\\fake\\driver.exe", mcpArgs: [] });
  runtime._childEnv = () => ({});
  runtime._cua = async () => ({});
  runtime._rpcUnlocked = () => new Promise((resolve, reject) => initializers.push({ resolve, reject }));
  return { runtime, children, initializers };
}

test("old child stdout and stderr cannot reach a replacement session", async () => {
  const f = fixture();
  const first = f.runtime.start();
  f.initializers[0].resolve({}); await first;
  const old = f.children[0];
  f.runtime.stop("test stop");
  const second = f.runtime.start();
  f.initializers[1].resolve({}); await second;
  const received = [];
  f.runtime._onStdout = chunk => received.push(chunk);
  f.runtime.stderrTail = "current";
  old.stdout.emit("data", "old response");
  old.stderr.emit("data", "old error");
  f.children[1].stdout.emit("data", "new response");
  assert.deepEqual(received, ["new response"]);
  assert.equal(f.runtime.stderrTail, "current");
});

test("stop during startup allows immediate restart and old startup cannot kill the replacement", async () => {
  const f = fixture();
  const first = f.runtime.start();
  const firstRejected = assert.rejects(first, /cancelled or replaced/);
  f.runtime.stop("stop during startup");
  const second = f.runtime.start();
  assert.notEqual(first, second);
  assert.equal(f.children.length, 2);
  f.initializers[0].resolve({}); await firstRejected;
  assert.equal(f.runtime.child, f.children[1]);
  assert.equal(f.runtime._starting, second);
  assert.equal(f.runtime.stoppedByUser, false);
  assert.equal(f.children[1].killed, undefined);
  f.initializers[1].resolve({}); await second;
  assert.equal(f.runtime.status, "running");
  assert.equal(f.runtime._starting, null);
});

test("capture spanning teardown cannot repopulate a newer session's actionable tree", async () => {
  const f = fixture();
  f.runtime.targets.set("notepad", { app: "Notepad", pid: 42, window_id: 100 });
  let release;
  const started = new Promise(resolve => {
    f.runtime._cua = async () => { resolve(); return new Promise(done => { release = done; }); };
  });
  const capture = f.runtime._getAppState({ app: "Notepad", window_id: 100, include_screenshot: false });
  const rejected = assert.rejects(capture, error => error.code === "session_changed");
  await started;
  f.runtime._killChild();
  f.runtime._rememberTarget("Notepad", { app: "Notepad", pid: 43, window_id: 200, tree_actionable: true });
  f.runtime._nativeMenuContext = { pid: 43, window_id: 200 };
  release({ structuredContent: { snapshot_id: "stale", elements: [{ role: "Button", label: "Old", element_index: 1 }] } });
  await rejected;
  assert.equal(f.runtime.targets.get("notepad").window_id, 200);
  assert.equal(f.runtime.targets.get("notepad").tree_actionable, true);
  assert.equal(f.runtime._nativeMenuContext.window_id, 200);
});

test("driver session_ended refusal reopens the session once and retries the call", async () => {
  const f = fixture();
  delete f.runtime._cua; // expose the prototype's real _cua over the stubbed _rpcUnlocked
  const requests = [];
  f.runtime._rpcUnlocked = async (method, params) => {
    requests.push(params.name);
    if (requests.length === 1) return { isError: true, structuredContent: { status: "refused", refusal: { code: "session_ended", message: "ended" } } };
    if (params.name === "start_session") return { structuredContent: { ok: true } };
    return { structuredContent: { windows: [] } };
  };
  let invalidated = 0;
  f.runtime._invalidateTrees = () => { invalidated++; };
  const result = await f.runtime._cua("list_windows", {});
  assert.deepEqual(requests, ["list_windows", "start_session", "list_windows"]);
  assert.equal(result.structuredContent.session_recovered, true);
  assert.equal(invalidated, 1);
});

test("a second session_ended refusal is not retried again", async () => {
  const f = fixture();
  const refused = { isError: true, structuredContent: { status: "refused", refusal: { code: "session_ended" } } };
  delete f.runtime._cua;
  const requests = [];
  f.runtime._rpcUnlocked = async (method, params) => { requests.push(params.name); return refused; };
  f.runtime._invalidateTrees = () => {};
  const result = await f.runtime._cua("get_window_state", {});
  assert.deepEqual(requests, ["get_window_state", "start_session", "get_window_state"]);
  assert.equal(result.structuredContent.session_recovered, undefined);
});

test("session recovery never replays start_session itself or runs while stopped", async () => {
  const f = fixture();
  const refused = { isError: true, structuredContent: { status: "refused", refusal: { code: "session_ended" } } };
  delete f.runtime._cua;
  const requests = [];
  f.runtime._rpcUnlocked = async (method, params) => { requests.push(params.name); return refused; };
  f.runtime._invalidateTrees = () => {};
  const direct = await f.runtime._cua("start_session", {});
  assert.deepEqual(requests, ["start_session"]);
  assert.equal(direct.structuredContent.refusal.code, "session_ended");
  f.runtime.stoppedByUser = true;
  requests.length = 0;
  await f.runtime._cua("list_windows", {});
  assert.deepEqual(requests, ["list_windows"]);
});
