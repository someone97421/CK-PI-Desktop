import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopAgentRuntime } from "../packages/agent-runtime/dist/runtime.js";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

const dataDir = mkdtempSync(join(tmpdir(), "pi-agent-live-"));
// No defaults on purpose: this script sends a real prompt with a real key, so
// the endpoint and model must be chosen explicitly by whoever runs it.
const REQUIRED_ENV = ["PI_DESKTOP_TEST_API_KEY", "PI_DESKTOP_TEST_BASE_URL", "PI_DESKTOP_TEST_MODEL"];
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
if (missingEnv.length > 0) {
  console.error(`missing required environment variables: ${missingEnv.join(", ")}`);
  console.error(
    "Set PI_DESKTOP_TEST_API_KEY (provider API key), PI_DESKTOP_TEST_BASE_URL " +
      "(OpenAI-compatible base URL), and PI_DESKTOP_TEST_MODEL (model id) to run this live test.",
  );
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
}
const API_KEY = process.env.PI_DESKTOP_TEST_API_KEY;
const BASE_URL = process.env.PI_DESKTOP_TEST_BASE_URL;
const MODEL = process.env.PI_DESKTOP_TEST_MODEL;

let hostBin;
try {
  hostBin = resolveHostBinary();
} catch (error) {
  console.error(error instanceof Error ? error.message : "host-core binary missing");
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
}

const events = [];
const host = new Host(hostBin, dataDir);
let runtime;
let durableTurnId;
try {
  await host.start(PROTOCOL_VERSION);
  const provider = await host.call("providers.create", {
    name: "Live",
    baseUrl: BASE_URL,
    defaultModelId: MODEL,
    secretValue: API_KEY,
    type: "openai_compatible",
    protocol: "openai_compatible",
    authKind: "api_key_and_base_url",
  });
  const session = await host.call("session.create", {
    title: "Pi live E2E",
    mode: "agent",
    projectPath: process.cwd(),
  });
  const turn = await host.call("session.beginTurn", { sessionId: session.session.id });
  durableTurnId = turn.turnId;
  const userMessageId = randomUUID();
  const prompt = "Reply with exactly: hello-from-pi-desktop";
  await host.call("session.appendMessage", {
    sessionId: session.session.id,
    turnId: durableTurnId,
    message: {
      id: userMessageId,
      role: "user",
      content: prompt,
      createdAt: new Date().toISOString(),
      status: "complete",
    },
  });

  runtime = new DesktopAgentRuntime({
    host,
    sessionId: session.session.id,
    turnId: durableTurnId,
    mode: "agent",
    provider: {
      id: provider.provider.id,
      name: "Live",
      baseUrl: BASE_URL,
      modelId: MODEL,
      apiKey: API_KEY,
      authKind: "api_key_and_base_url",
      apiStyle: "chat_completions",
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
    },
    thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    onEvent: (e) => {
      events.push(e.event);
      if (e.event.type === "message_update" && e.event.deltaText) {
        process.stdout.write(e.event.deltaText);
      }
      if (e.event.type === "message_end" && e.event.message.role === "assistant") {
        process.stdout.write("\n");
        console.log("assistant:", e.event.message.content.slice(0, 200));
      }
      if (e.event.type === "error") {
        console.error("error event", e.event.error);
      }
    },
  });

  console.log("prompting…");
  await runtime.prompt(prompt, userMessageId, durableTurnId);
  for (const event of events) {
    if (event.type === "message_end" && event.message.role === "assistant") {
      await host.call("session.appendMessage", {
        sessionId: session.session.id,
        turnId: durableTurnId,
        message: event.message,
      });
    }
  }
  const response = events.findLast(
    (event) => event.type === "message_end" && event.message.role === "assistant",
  )?.message.content;
  const ok = typeof response === "string" &&
    response.toLowerCase().includes("hello-from-pi-desktop") &&
    !events.some((event) => event.type === "error");
  await host.call("session.endTurn", {
    turnId: durableTurnId,
    status: ok ? "completed" : "error",
    createNotification: false,
  });
  durableTurnId = undefined;
  console.log(ok ? "PASS E2E-agent-live" : "FAIL E2E-agent-live");
} finally {
  await runtime?.dispose();
  try {
    if (durableTurnId) {
      await host.call("session.endTurn", {
        turnId: durableTurnId,
        status: "error",
        createNotification: false,
      });
    }
  } finally {
    try {
      await host.stop();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
}

console.log("events:", events.map((event) => event.type).join(" > "));
