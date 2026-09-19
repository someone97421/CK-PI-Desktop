import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createAgentHostBridge, DESKTOP_PRINCIPAL } = await import(
  "../electron/main/agent-host-bridge.ts"
);
const { IPC } = await import("@pi-desktop/shared");

/**
 * The bridge exposes an `agentHost` whose `startTurn` runs the same runtime
 * port the Electron composition wires. These tests reach through it to verify
 * the per-turn permission-ceiling policy: a request whose effective mode
 * differs from the session's stored mode is refused (fail closed), and a
 * matching request stays silent. The sidecar's `permissionMode` override is
 * not yet enforced anywhere downstream, so no mismatched turn may reach it.
 */
function fixture({ sessionPermissionMode }) {
  const prompts = [];
  const host = {
    async call(method, params) {
      if (method === "session.get") {
        return {
          session: {
            id: params?.id ?? "s1",
            title: "S1",
            mode: "agent",
            permissionMode: sessionPermissionMode,
            createdAt: "2026-09-18T10:00:00.000Z",
            updatedAt: "2026-09-18T10:00:00.000Z",
          },
        };
      }
      if (method === "session.queueList") return { entries: [] };
      if (method === "session.queuePush") return {};
      if (method === "session.queueRemove") return { removed: true };
      if (method === "session.queuePrioritize") return {};
      if (method === "session.queueReorder") return { moved: true };
      throw new Error(`unexpected host call: ${method}`);
    },
  };

  const bridge = createAgentHostBridge({
    channels: IPC.invoke,
    getHost: () => host,
    isSessionBusy: () => false,
    log: () => undefined,
    async invoke(channel, [request]) {
      prompts.push({ channel, request });
      const turnId = `runtime-${prompts.length}`;
      return { accepted: true, turnId };
    },
  });
  return { bridge, prompts };
}

async function callStart(bridge, principal) {
  return bridge.agentHost.startTurn(principal, {
    sessionId: "s1",
    input: { text: "hi" },
    context: { requestId: "req-1" },
  }).catch((error) => error);
}

test("a matching session/effective mode leaves the sidecar call without an override", async () => {
  const { bridge, prompts } = fixture({ sessionPermissionMode: "auto" });
  const outcome = await callStart(bridge, DESKTOP_PRINCIPAL);
  assert.ok(outcome && (outcome.accepted === true || outcome.turn), "startTurn should accept");
  const promptCall = prompts.find((entry) => entry.channel === IPC.invoke.agentPrompt);
  assert.ok(promptCall, "sidecar prompt must be invoked");
  assert.equal(
    promptCall.request.permissionMode,
    undefined,
    "matching mode must not attach a per-turn override",
  );
});

test("a per-turn ceiling that narrows below the session mode refuses the turn", async () => {
  // The default policy `remoteMaxPermissionMode` is `ask`, so a non-paired
  // controller on an `auto` session computes an effective mode of `ask`. The
  // sidecar records nothing for `agent.prompt`'s `permissionMode` override and
  // host-core `session.beginTurn` has no per-turn override, so letting it ride
  // through would run the turn at the session's stored `auto` mode. Until the
  // enforcement gate exists, the mismatch fails closed before the runtime.
  const { bridge, prompts } = fixture({ sessionPermissionMode: "auto" });
  const remoteController = {
    subject: "remote-controller",
    roles: ["controller"],
    pairedDevice: false,
    approverOverride: false,
  };
  const outcome = await callStart(bridge, remoteController);
  assert.equal(outcome.code, "FORBIDDEN", "a narrowed ceiling must refuse the turn");
  assert.equal(
    outcome.message,
    "the local runtime cannot apply a per-turn permission ceiling yet",
  );
  assert.equal(
    outcome.details?.sessionPermissionMode,
    "auto",
    "the refusal names the session's stored mode",
  );
  assert.equal(
    outcome.details?.effectivePermissionMode,
    "ask",
    "the refusal names the computed per-turn ceiling",
  );
  assert.equal(
    prompts.find((entry) => entry.channel === IPC.invoke.agentPrompt),
    undefined,
    "a refused turn must never reach the sidecar prompt path",
  );
});

test("the bridge's mismatch gate stays fail closed at the source", async () => {
  // Widening cannot arrive via `effectiveRemotePermissionMode` (the ceiling
  // clamps DOWN by construction), so the whole mismatch family — wider,
  // narrower, or otherwise different — is covered by one gate. The runtime
  // port is not exported for direct probing (spec §7.3: the port belongs to
  // the AgentHost), so pin the fail-closed contract to the source of truth:
  // every session-vs-effective mismatch throws FORBIDDEN before the sidecar
  // call is assembled, and no per-turn override is ever attached to it.
  const bridgeSource = readFileSync(
    join(here, "..", "electron", "main", "agent-host-bridge.ts"),
    "utf8",
  );
  assert.match(
    bridgeSource,
    /summary\.permissionMode !== request\.effectivePermissionMode/,
    "bridge must gate on any session/effective mode mismatch before forwarding",
  );
  assert.match(
    bridgeSource,
    /"the local runtime cannot apply a per-turn permission ceiling yet"/,
    "bridge must throw a FORBIDDEN with the fail-closed message",
  );
  assert.doesNotMatch(
    bridgeSource,
    /permissionModeOverride/,
    "no per-turn override may be attached to the sidecar prompt call",
  );
});
