import { net, type BrowserWindow, type WebContents } from "electron";
import { IPC, type AppSettings } from "@pi-desktop/shared";
import type { VendorOAuth } from "../oauth";
import type { HostProcess } from "../host-process";
import type { AgentHostBridge } from "../agent-host-bridge";
import { LiveCallService } from "./call-service";
import { LiveAuthResolver } from "./auth-resolver";
import { createLivePcmBridge } from "./audio-port";
import { createCodexAdapter } from "./codex-adapter";
import { createGeminiAdapter } from "./gemini-adapter";
import { createOpenAIRealtimeAdapter } from "./openai-realtime-adapter";
import { liveOwnerFrame } from "./owner";
import { assertLiveHttpsEndpoint } from "./websocket-transport";
import type { MicrophoneLeaseRegistry } from "./microphone-lease";
import type { LiveOwner } from "./call-service";
import { createLiveWorkBridge } from "./work-bridge";
import type { ThinkingLevel } from "@pi-desktop/shared";

type BackgroundLease = { webContents: WebContents; previous: boolean; count: number };

export function createLiveCallService(input: {
  getHost: () => HostProcess | null;
  getMainWindow: () => BrowserWindow | null;
  getAgentHostBridge: () => AgentHostBridge | null;
  vendorOAuth: Pick<VendorOAuth, "resolveAuth">;
  microphoneLeases: MicrophoneLeaseRegistry;
  resolveAgentRuntimeLaunch: (
    sessionId: string,
    session: Record<string, unknown>,
    settings: unknown,
    overrides: { providerId?: string; modelId?: string; thinkingLevel?: ThinkingLevel },
  ) => Promise<{
    providerId: string;
    sidecarParams: { provider: import("@pi-desktop/agent-runtime").RuntimeProviderConfig };
  }>;
}): LiveCallService {
  const backgroundLeases = new Map<number, BackgroundLease>();
  const authResolver = new LiveAuthResolver({
    callHost: <T,>(method: string, params?: unknown): Promise<T> => {
      const host = input.getHost();
      if (!host) return Promise.reject(Object.assign(new Error("host unavailable"), { errorCode: "LIVE_PROVIDER_NOT_FOUND" }));
      return host.call<T>(method, params);
    },
    vendorOAuth: input.vendorOAuth,
  });

  let liveCallService: LiveCallService | null = null;
  const workBridge = createLiveWorkBridge({
    getHost: input.getHost,
    getAgentHostBridge: input.getAgentHostBridge,
    vendorOAuth: input.vendorOAuth,
    navigateSession: (callId, sessionId) => {
      if (!liveCallService) return Promise.reject(Object.assign(new Error("Live call service is unavailable"), { errorCode: "LIVE_WORK_NOT_READY" }));
      return liveCallService.navigateWorkSession(callId, sessionId);
    },
    resolveAgentRuntimeLaunch: input.resolveAgentRuntimeLaunch,
    onOperation: (callId, update) => {
      const operation = update.operation;
      liveCallService?.notifyWorkOperation(callId, {
        operationId: operation.operationId,
        admission: operation.admission,
        execution: operation.execution,
        ...(operation.turnId ? { turnId: operation.turnId } : {}),
        ...(operation.queueEntryId ? { queueEntryId: operation.queueEntryId } : {}),
        ...(operation.summary ? { summary: operation.summary } : {}),
        ...(operation.selections ? { selections: operation.selections } : {}),
      }, operation.providerRequestId, operation.resultSummary, update.intent);
    },
    onAnnouncementPolicy: ({ callId, policy }) => liveCallService?.setWorkAnnouncementPolicy(callId, policy),
  });

  liveCallService = new LiveCallService({
    loadSettings: async () => {
      const host = input.getHost();
      if (!host) throw Object.assign(new Error("host unavailable"), { errorCode: "LIVE_PROVIDER_NOT_FOUND" });
      return host.call<AppSettings>("settings.get");
    },
    authResolver,
    resolveWorkBinding: async (target) => {
      if (target.workSessionId.startsWith("native-pi:")) {
        throw Object.assign(new Error("Live work integration does not support native Pi sessions"), {
          errorCode: "LIVE_WORK_BACKEND_UNSUPPORTED",
        });
      }
      const host = input.getHost();
      if (!host) throw Object.assign(new Error("Local Host is unavailable"), { errorCode: "LIVE_WORK_NOT_READY" });
      const result = await host.call<{ sessions?: Array<{ id?: unknown; title?: unknown; source?: unknown; projectPath?: unknown }> }>("session.list");
      const session = result.sessions?.find((item) => item.id === target.workSessionId);
      if (!session) {
        throw Object.assign(new Error("The selected local work session is unavailable"), { errorCode: "LIVE_WORK_SESSION_UNAVAILABLE" });
      }
      if (session.source !== undefined && session.source !== "desktop") {
        throw Object.assign(new Error("Live work integration supports only local Desktop sessions"), { errorCode: "LIVE_WORK_BACKEND_UNSUPPORTED" });
      }
      return {
        workSessionId: target.workSessionId,
        workBindingRevision: 1,
        label: formatWorkSessionLabel(session.projectPath, session.title),
        contextEnabled: target.contextEnabled,
      };
    },
    openWorkScope: (callId, binding) => workBridge.openCall({ ...binding, callId }),
    closeWorkScope: workBridge.closeCall,
    resolveWorkSelection: workBridge.resolveSelection,
    receiveWorkCandidate: workBridge.receiveCandidate,
    createAdapter: (context) => {
      switch (context.binding.adapterId) {
        case "codex-live":
          return createCodexAdapter(context, {
            fetchImpl: (url, init) => net.fetch(url instanceof URL ? url.toString() : url, init),
            assertEndpoint: (url) => assertLiveHttpsEndpoint(url, "third-party"),
          });
        case "gemini-live":
          return createGeminiAdapter(context);
        case "openai-realtime":
          return createOpenAIRealtimeAdapter(context);
      }
    },
    createPcmBridge: (bridgeInput) => {
      const frame = liveOwnerFrame(input.getMainWindow(), bridgeInput.owner);
      if (!frame) throw Object.assign(new Error("Live Voice owner frame is unavailable"), { errorCode: "LIVE_INVALID_OWNER" });
      return createLivePcmBridge({
        ...bridgeInput,
        ownerFrame: frame,
      });
    },
    sendView: (owner, view) => sendToOwner(input.getMainWindow(), owner, IPC.event.liveVoiceChanged, view),
    sendControl: (owner, event) => sendToOwner(input.getMainWindow(), owner, IPC.event.liveVoiceControl, event),
    sendTranscript: (owner, event) => sendToOwner(input.getMainWindow(), owner, IPC.event.liveVoiceTranscript, event),
    ownerAlive: (owner) => liveOwnerFrame(input.getMainWindow(), owner) !== null,
    acquireMicrophone: (callId) => input.microphoneLeases.acquire("live", callId),
    acquireBackgroundThrottlingLease: (callId) => acquireBackgroundLease(input.getMainWindow(), callId, backgroundLeases),
  });
  return liveCallService;
}

function formatWorkSessionLabel(projectPath: unknown, title: unknown): string {
  const sessionLabel = typeof title === "string" ? title.trim().slice(0, 100) : "";
  const projectLabel = typeof projectPath === "string" && projectPath.trim()
    ? projectPath.split(/[\\/]/).filter(Boolean).at(-1)?.slice(0, 60)
    : undefined;
  return [projectLabel, sessionLabel].filter((part): part is string => Boolean(part)).join(" / ");
}

function sendToOwner(window: BrowserWindow | null, owner: LiveOwner, channel: string, payload: unknown): void {
  const frame = liveOwnerFrame(window, owner);
  if (!frame || !window || window.isDestroyed()) return;
  frame.send(channel, payload);
}

function acquireBackgroundLease(
  window: BrowserWindow | null,
  _callId: string,
  leases: Map<number, BackgroundLease>,
): () => void {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    throw Object.assign(new Error("Live Voice owner window is unavailable"), { errorCode: "LIVE_INVALID_OWNER" });
  }
  const contents = window.webContents;
  let lease = leases.get(contents.id);
  if (!lease) {
    const previous = contents.getBackgroundThrottling();
    lease = { webContents: contents, previous, count: 0 };
    leases.set(contents.id, lease);
    contents.setBackgroundThrottling(false);
  }
  lease.count += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = leases.get(contents.id);
    if (current !== lease) return;
    current.count -= 1;
    if (current.count > 0) return;
    leases.delete(contents.id);
    if (!contents.isDestroyed()) contents.setBackgroundThrottling(current.previous);
  };
}
