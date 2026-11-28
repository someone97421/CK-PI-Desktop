import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { createRendererRecovery } from "../electron/main/renderer-recovery.ts";

const crashDetails = { reason: "crashed", exitCode: 73 };
const cleanExit = { reason: "clean-exit", exitCode: 0 };

function recovery() {
  const calls = { reloads: 0, trips: 0, logs: [] };
  let live = true;
  const controller = createRendererRecovery({
    canReload: () => live,
    reload: () => calls.reloads++,
    log: (details, reloaded) => calls.logs.push({ details, reloaded }),
    onCrashLoopDetected: () => calls.trips++,
  });
  return {
    calls,
    controller,
    crash: () => controller.rendererGone(crashDetails),
    makeInactive: () => { live = false; },
  };
}

describe("main-window renderer recovery", () => {
  beforeEach(() => mock.timers.enable({ apis: ["Date", "setTimeout"] }));
  afterEach(() => mock.timers.reset());

  it("unexpected exits reload the live window and preserve diagnostics", () => {
    const { calls, controller, crash } = recovery();
    crash();
    mock.timers.tick(3_000);
    const unknownExit = { reason: "future-electron-reason", exitCode: 2 };
    controller.rendererGone(unknownExit);
    assert.equal(calls.reloads, 2);
    assert.deepEqual(calls.logs, [
      { details: crashDetails, reloaded: true },
      { details: unknownExit, reloaded: true },
    ]);
  });

  it("clean exits and exits outside the live lifecycle do not count or reload", () => {
    const { calls, controller, crash, makeInactive } = recovery();
    for (let i = 0; i < 6; i++) controller.rendererGone(cleanExit);
    assert.equal(calls.reloads, 0);
    makeInactive();
    for (let i = 0; i < 6; i++) crash();
    assert.equal(calls.reloads, 0);
    assert.equal(calls.trips, 0);
    assert.equal(calls.logs.length, 12);
    assert.ok(calls.logs.every(({ reloaded }) => !reloaded));
  });

  it("coalesces rapid crashes and measures cooldown from each actual reload", () => {
    const { calls, crash } = recovery();
    crash();
    mock.timers.tick(500);
    crash();
    mock.timers.tick(500);
    crash();
    assert.equal(calls.reloads, 1);
    mock.timers.tick(1_000);
    assert.equal(calls.reloads, 2);
    crash();
    mock.timers.tick(1_999);
    assert.equal(calls.reloads, 2);
    mock.timers.tick(1);
    assert.equal(calls.reloads, 3);
  });

  it("drops the queued reload after shutdown, disposal, or a successful load", () => {
    for (const interrupt of [
      (run) => run.makeInactive(),
      (run) => run.controller.dispose(),
      (run) => run.controller.rendererLoaded(),
    ]) {
      const run = recovery();
      run.crash();
      run.crash();
      interrupt(run);
      mock.timers.tick(2_000);
      assert.equal(run.calls.reloads, 1);
    }
  });

  it("trips on the fifth consecutive startup crash and suppresses subsequent reloads", () => {
    const { calls, controller, crash } = recovery();
    for (let i = 0; i < 4; i++) {
      crash();
      mock.timers.tick(2_000);
    }
    crash();
    controller.rendererLoaded();
    crash();
    mock.timers.tick(2_000);
    assert.equal(calls.reloads, 4);
    assert.equal(calls.trips, 1);
    assert.equal(calls.logs.length, 6);
    assert.equal(calls.logs.at(-1).reloaded, false);
  });

  it("tripping the breaker cancels a queued reload", () => {
    const { calls, crash } = recovery();
    for (let i = 0; i < 5; i++) crash();
    mock.timers.tick(2_000);
    assert.equal(calls.reloads, 1);
    assert.equal(calls.trips, 1);
  });

  it("successful loads reset the streak before escalation", () => {
    const { calls, controller, crash } = recovery();
    for (let i = 0; i < 6; i++) {
      crash();
      controller.rendererLoaded();
      mock.timers.tick(2_000);
    }
    assert.equal(calls.trips, 0);
    assert.equal(calls.reloads, 6);
  });

  it("a replacement main window starts with its own cooldown and streak", () => {
    const first = recovery();
    for (let i = 0; i < 4; i++) first.crash();
    const next = recovery();
    next.crash();
    assert.equal(next.calls.reloads, 1);
    assert.equal(next.calls.trips, 0);
    next.controller.rendererLoaded();
    first.crash();
    assert.equal(first.calls.trips, 1);
  });
});
