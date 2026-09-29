import {
  IPC,
  type LiveConnectRequest,
  type LiveConnectResult,
  type LiveControlEvent,
  type LiveDelegationRequest,
  type LiveEndRequest,
  type LiveMediaReport,
  type LivePlaybackCursor,
  type LivePrepareRequest,
  type LivePreparedCall,
  type LiveStatus,
  type LiveTranscriptEvent,
} from "@pi-desktop/shared";
import type { LiveCallView } from "@pi-desktop/shared";

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const bridge = window.piDesktop;
  if (!bridge) throw liveError("LIVE_INVALID_OWNER", "Live Voice bridge unavailable");
  const result = await bridge.invoke<T>(channel, ...args);
  if (!result.ok) {
    throw liveError(result.error.code, result.error.message, result.error.retriable === true);
  }
  return result.data;
}

export const liveVoiceApi = {
  status: () => invoke<LiveStatus>(IPC.invoke.liveVoiceStatus),
  prepare: (request: LivePrepareRequest) => invoke<LivePreparedCall>(IPC.invoke.liveVoicePrepare, request),
  connect: (request: LiveConnectRequest) => invoke<LiveConnectResult>(IPC.invoke.liveVoiceConnect, request),
  setMuted: (request: { callId: string; muted: boolean; captureEpoch: number }) => invoke<LiveCallView>(IPC.invoke.liveVoiceSetMuted, request),
  reportMedia: (report: LiveMediaReport) => invoke<LiveCallView>(IPC.invoke.liveVoiceReportMedia, report),
  reportPlayback: (input: { callId: string; cursors: LivePlaybackCursor[] }) => invoke<{ ok: true }>(IPC.invoke.liveVoiceReportPlayback, input),
  reportDelegation: (request: LiveDelegationRequest) => invoke<{ accepted: boolean }>(IPC.invoke.liveVoiceReportDelegation, request),
  reportControlApplied: (input: { callId: string; actionId: string; applied: boolean; errorCode?: string }) => invoke<{ ok: true }>(IPC.invoke.liveVoiceReportControlApplied, input),
  end: (request: LiveEndRequest) => invoke<{ ok: true }>(IPC.invoke.liveVoiceEnd, request),
  heartbeat: (callId: string) => invoke<{ ok: true }>(IPC.invoke.liveVoiceHeartbeat, { callId }),
  resolveWorkSelection: (input: { callId: string; selectionRef: string }) => invoke<
    | { kind: "session"; sessionId: string }
    | { kind: "project"; projectPath: string }
  >(IPC.invoke.liveVoiceResolveWorkSelection, input),
  onView: (listener: (view: LiveCallView) => void) => subscribe(IPC.event.liveVoiceChanged, listener),
  onControl: (listener: (event: LiveControlEvent) => void) => subscribe(IPC.event.liveVoiceControl, listener),
  onTranscript: (listener: (event: LiveTranscriptEvent) => void) => subscribe(IPC.event.liveVoiceTranscript, listener),
};

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const bridge = window.piDesktop;
  if (!bridge) return () => undefined;
  return bridge.on(channel, (value) => listener(value as T));
}

export function liveError(code: string, message = code, retriable = false): Error & { code: string; retriable: boolean } {
  return Object.assign(new Error(message), { code, retriable });
}
