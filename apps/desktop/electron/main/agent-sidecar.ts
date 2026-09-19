import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  AgentSidecar as RuntimeAgentSidecar,
  type StderrHandler,
} from "@pi-desktop/host-runtime";
import { redactValue } from "./logger";

export type {
  LocalToolHandler,
  LocalToolResult,
  ProjectInstructionResolver,
  SidecarNotificationHandler,
  TrustedExtensionSidecarBridge,
  VendorAuthResolver,
} from "@pi-desktop/host-runtime";

function resolveSidecarEntry(): string {
  const candidates = [
    join(process.resourcesPath || "", "agent-runtime/sidecar.js"),
    join(__dirname, "../../../agent-runtime/dist/sidecar.js"),
    join(__dirname, "../../../../packages/agent-runtime/dist/sidecar.js"),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return join(__dirname, "../../../../packages/agent-runtime/dist/sidecar.js");
}

/**
 * The desktop's agent sidecar: the shared stdio transport from
 * `@pi-desktop/host-runtime`, launched the only way Electron can run Node
 * code out of process — its own executable with `ELECTRON_RUN_AS_NODE` — on
 * the sidecar bundle this build ships.
 */
export class AgentSidecar extends RuntimeAgentSidecar {
  // Sessions bound for durable subagent persistence (TaskResume encrypted
  // snapshots). A session joins only when main registers its project root —
  // the same host-owned turn-start flow — so a stale runtime cannot reach a
  // session this sidecar never owned.
  private snapshotSessions = new Set<string>();
  private snapshotHandler?: (params: Record<string, unknown>) => Promise<unknown>;

  constructor(onStderr?: StderrHandler) {
    super({
      launch: {
        command: process.execPath,
        args: [resolveSidecarEntry()],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
      onStderr: onStderr ?? fallbackStderrLogger,
    });
    this.setProxyMethodHandler("subagent.persistence", (params) =>
      this.dispatchSubagentPersistence(params),
    );
  }

  setSubagentPersistenceHandler(
    handler: (params: Record<string, unknown>) => Promise<unknown>,
  ): void {
    this.snapshotHandler = handler;
  }

  private async dispatchSubagentPersistence(
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.isClosed() || !this.snapshotHandler) {
      throw new Error("Subagent persistence unavailable");
    }
    if (
      params.operation !== "capabilities" &&
      (typeof params.sessionId !== "string" || !this.snapshotSessions.has(params.sessionId))
    ) {
      throw new Error("Subagent persistence session is not bound to this sidecar");
    }
    return this.snapshotHandler(params);
  }

  setProjectInstructionRoot(sessionId: string, projectPath?: string): void {
    super.setProjectInstructionRoot(sessionId, projectPath);
    const id = sessionId.trim();
    if (id) this.snapshotSessions.add(id);
  }

  clearProjectInstructionRoot(sessionId: string): void {
    super.clearProjectInstructionRoot(sessionId);
    this.snapshotSessions.delete(sessionId.trim());
  }

  async dispose(): Promise<void> {
    this.snapshotSessions.clear();
    await super.dispose();
  }
}

function fallbackStderrLogger(text: string): void {
  console.error(
    `[agent/runtime] ${JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      channel: "agent",
      category: "runtime",
      event: "child.process.stderr",
      message: "child process stderr",
      data: { output: redactValue(text.trimEnd()) },
    })}`,
  );
}
