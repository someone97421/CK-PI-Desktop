import { realpath } from "node:fs/promises";
import type { HostProcess } from "../host-process";

export type SubagentSessionAuthorityMode = "identity" | "history";
export type SubagentSessionAuthority = (
  sessionId: string,
  mode?: SubagentSessionAuthorityMode,
) => Promise<{ projectRealPath: string; watermark: string } | null>;

/** 只读取所属会话和有效目录。上下文快照不依赖整份聊天转录的指纹。 */
export function createSubagentSessionAuthority(_dataDir: string, getHost: () => HostProcess | null): SubagentSessionAuthority {
  return async (sessionId) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error("快照会话标识无效");
    const host = getHost();
    if (!host) throw new Error("会话服务暂不可用");
    const result = await host.call<{ session?: { projectPath?: string | null; temporaryWorkspacePath?: string | null } | null }>(
      "session.get", { id: sessionId, messageLimit: 1, contentLimit: 1 }, 5_000,
    );
    if (!result.session) return null;
    const path = result.session.projectPath || result.session.temporaryWorkspacePath;
    return { projectRealPath: path ? await realpath(path) : "", watermark: "" };
  };
}
