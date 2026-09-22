import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { HostProcess } from "../host-process";

const MAX_TRANSCRIPT_BYTES = 512 * 1024 * 1024;

export type SubagentSessionAuthorityMode = "identity" | "history";
export type SubagentSessionAuthority = (
  sessionId: string,
  mode?: SubagentSessionAuthorityMode,
) => Promise<{ projectRealPath: string; watermark: string } | null>;

/** 新会话登记只核对身份；历史快照核验与覆盖水位更新读取完整稳定转录。 */
export function createSubagentSessionAuthority(
  dataDir: string,
  getHost: () => HostProcess | null,
): SubagentSessionAuthority {
  return async (sessionId: string, mode = "history"): Promise<{ projectRealPath: string; watermark: string } | null> => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error("Invalid snapshot session identity");
    const host = getHost();
    if (!host) throw new Error("会话服务尚未就绪，暂不能校验快照。");
    const result = await host.call<{ session?: { id: string; projectPath?: string | null; createdAt?: string; messageCount?: number } | null }>(
      "session.get", { id: sessionId, messageLimit: 1, contentLimit: 1 },
    );
    if (!result.session) return null;
    const session = result.session;
    const projectRealPath = session.projectPath ? await realpath(session.projectPath) : "";
    const digest = createHash("sha256");
    digest.update(JSON.stringify({ id: session.id, createdAt: session.createdAt, projectRealPath, messageCount: session.messageCount }));
    const directory = join(dataDir, "sessions");
    try {
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("转录目录不是受控目录。");
      const actual = await realpath(directory);
      const expected = resolve(directory);
      if (process.platform === "win32" ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected) {
        throw new Error("转录目录真实路径不匹配。");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || session.messageCount) throw error;
      return { projectRealPath, watermark: digest.update("no-transcript-directory").digest("hex") };
    }
    if (mode === "identity") {
      return { projectRealPath, watermark: `identity:${digest.digest("hex")}` };
    }
    for (const suffix of [".jsonl", ".revisions.jsonl"]) {
      const path = join(directory, `${sessionId}${suffix}`);
      digest.update(suffix);
      let info;
      try { info = await lstat(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (suffix === ".jsonl" && session.messageCount) throw new Error("会话转录缺失，不能恢复快照。");
        digest.update("missing");
        continue;
      }
      if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_TRANSCRIPT_BYTES) throw new Error("转录类型或大小不支持安全核对。");
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await file.stat();
        if (before.dev !== info.dev || before.ino !== info.ino || before.size > MAX_TRANSCRIPT_BYTES) throw new Error("转录读取期间发生替换。");
        const buffer = Buffer.alloc(64 * 1024);
        let offset = 0;
        while (offset < before.size) {
          const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
          if (!bytesRead) throw new Error("转录读取期间发生截断。");
          digest.update(buffer.subarray(0, bytesRead));
          offset += bytesRead;
        }
        const after = await file.stat();
        const current = await lstat(path);
        // 时间戳仅用于识别本次读取竞态，跨启动的比较值是完整内容哈希。
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || current.ino !== before.ino || current.dev !== before.dev) {
          throw new Error("转录正在变化，请在保存完成后重新校验。");
        }
      } finally { await file.close(); }
    }
    return { projectRealPath, watermark: digest.digest("hex") };
  };
}
