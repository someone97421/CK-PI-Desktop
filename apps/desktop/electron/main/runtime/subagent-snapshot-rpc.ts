import type {
  SubagentBeginRequest, SubagentClaimSessionRequest, SubagentCommitRequest,
  SubagentConfirmEventsRequest, SubagentFailRequest, SubagentListRequest,
  SubagentLoadRequest, SubagentRevokeRequest,
} from "@pi-desktop/agent-runtime";
import type { SubagentSnapshotStore } from "./subagent-snapshot-store";

/** 仅由当前 AgentSidecar 的反向 RPC 路由调用；不注册 Renderer/插件文件能力。 */
export async function dispatchSubagentPersistence(
  store: SubagentSnapshotStore,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (params.operation === "capabilities") {
    return { protocolVersion: 1, settings: await store.getSettings() };
  }
  if (typeof params.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(params.sessionId)) {
    throw new Error("Invalid subagent persistence session");
  }
  // 输入强校验与 CAS 在唯一存储服务内完成；这里严格限制操作名称。
  switch (params.operation) {
    case "claimSession": return store.claimSession(params as unknown as SubagentClaimSessionRequest);
    case "beginExecution": return store.beginExecution(params as unknown as SubagentBeginRequest);
    case "commitSnapshot": return store.commitSnapshot(params as unknown as SubagentCommitRequest);
    case "failExecution": return store.failExecution(params as unknown as SubagentFailRequest);
    case "revokeExecution": return store.revokeExecution(params as unknown as SubagentRevokeRequest);
    case "loadSnapshot": return store.loadSnapshot(params as unknown as SubagentLoadRequest);
    case "listEntries": return store.listEntries(params as unknown as SubagentListRequest);
    case "confirmEvents": return store.confirmEvents(params as unknown as SubagentConfirmEventsRequest);
    default: throw new Error("Unsupported subagent persistence operation");
  }
}
