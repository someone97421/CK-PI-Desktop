import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, utimes } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { validateCheckpoint } from "@pi-desktop/agent-runtime";
import { SubagentSnapshotFiles } from "../runtime/subagent-snapshot-files.js";
import type { SessionControlRecord, StoredControlRecord } from "../runtime/subagent-snapshot-store.js";
import type { QueuedSteeringReceipt } from "../queued-steering-receipts.js";

async function optionalStat(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function children(path: string) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const identifier = /^[a-zA-Z0-9_-]{1,128}$/;

/** 冷复制与 Rust 重定位之后、发布目录指针之前调用；失败由调用方保留旧目录。 */
export async function relocateForkData(source: string, destination: string): Promise<void> {
  const oldRoot = resolve(source);
  const newRoot = resolve(destination);
  const canonicalSource = await realpath(oldRoot);
  const nativePath = (path: string) => process.platform === "win32"
    ? path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "")
    : path;
  const roots = [oldRoot, canonicalSource].map((path) => resolve(nativePath(path)));
  const relocatePath = (value: string): string => {
    if (!isAbsolute(value) || value.split(/[\\/]/).includes("..")) return value;
    const path = resolve(nativePath(value));
    for (const root of roots) {
      const suffix = relative(root, path);
      if (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`)) {
        return resolve(newRoot, suffix);
      }
    }
    return value;
  };

  // 核心复制层已保留源文件时间；重写后恢复目标副本时间，避免延长快照保留期。
  const preserveTimes = async (path: string) => {
    const times = await lstat(path);
    return async () => { await utimes(path, times.atimeMs / 1000, times.mtimeMs / 1000); };
  };
  const snapshotRoot = join(newRoot, "subagent-contexts", "v1");
  const files = new SubagentSnapshotFiles(snapshotRoot);
  const readEnvelope = async <T>(path: string, identity: string) => {
    if (!await optionalStat(path)) return null;
    const restoreTimes = await preserveTimes(path);
    try { return { value: files.decode<T>(await files.readBounded(path), identity), restoreTimes }; }
    catch { return null; } // 无法读取的历史快照保留原字节，由召回流程报告其可用性。
  };

  for (const session of await children(snapshotRoot)) {
    if (!session.isDirectory() || !identifier.test(session.name)) continue;
    const sessionId = session.name;
    const sessionPath = files.path(sessionId, "session-control.bin");
    const sessionIdentity = `${sessionId}/session-control`;
    const sessionRecord = await readEnvelope<SessionControlRecord>(sessionPath, sessionIdentity);
    if (sessionRecord) {
      const record = sessionRecord.value;
      if (!record || record.sessionId !== sessionId || typeof record.projectRealPath !== "string") continue;
      const next = relocatePath(record.projectRealPath);
      if (next !== record.projectRealPath) {
        record.projectRealPath = next;
        await files.atomicWrite(sessionPath, files.encode(record, sessionIdentity));
      }
      await sessionRecord.restoreTimes();
    }
    for (const delegation of await children(files.path(sessionId))) {
      if (!delegation.isDirectory() || !identifier.test(delegation.name)) continue;
      const delegationId = delegation.name;
      const controlPath = files.path(sessionId, delegationId, "control.bin");
      const controlIdentity = `${sessionId}/${delegationId}/control`;
      const control = await readEnvelope<StoredControlRecord>(controlPath, controlIdentity);
      if (control && (!control.value || control.value.sessionId !== sessionId ||
          control.value.delegationId !== delegationId ||
          !Number.isSafeInteger(control.value.snapshotGeneration) || control.value.snapshotGeneration < 0)) {
        continue;
      }
      let controlChanged = false;
      for (const file of await children(files.path(sessionId, delegationId))) {
        const match = /^generation-(\d+)\.bin$/.exec(file.name);
        if (!match) continue;
        const generation = Number(match[1]);
        const path = files.path(sessionId, delegationId, file.name);
        const identity = `${sessionId}/${delegationId}/generation-${match[1]}`;
        const snapshot = await readEnvelope<unknown>(path, identity);
        if (!snapshot) continue;
        // 沿用运行时校验，但直接保留原对象；不重新编码消息或过滤扩展字段。
        let checkpoint: ReturnType<typeof validateCheckpoint>;
        try { checkpoint = validateCheckpoint(snapshot.value); }
        catch { await snapshot.restoreTimes(); continue; }
        if (checkpoint.header.sessionId !== sessionId || checkpoint.header.delegationId !== delegationId ||
            checkpoint.execution.generation !== generation) {
          await snapshot.restoreTimes();
          continue;
        }
        let changed = false;
        const project = relocatePath(checkpoint.header.projectRealPath);
        if (project !== checkpoint.header.projectRealPath) {
          checkpoint.header.projectRealPath = project;
          changed = true;
        }
        const definition = checkpoint.config?.definition;
        if (typeof definition?.filePath === "string") {
          const next = relocatePath(definition.filePath);
          if (next !== definition.filePath) { definition.filePath = next; changed = true; }
        }
        // 当前 checkpoint 不持久化 scratch/worktree；媒体引用是相对内容哈希。
        // 消息、工具参数与结果、提示词和摘要均为历史载荷，不能按字段名递归替换。
        if (changed) {
          const bytes = files.encode(checkpoint, identity);
          await files.atomicWrite(path, bytes);
          if (control && control.value.snapshotGeneration === generation) {
            control.value.commitDigest = createHash("sha256").update(bytes).digest("hex");
            controlChanged = true;
          }
        }
        await snapshot.restoreTimes();
      }
      if (control) {
        if (controlChanged) await files.atomicWrite(controlPath, files.encode(control.value, controlIdentity));
        await control.restoreTimes();
      }
    }
  }

  // Rust 主路径不处理此 fork 引导回执；只改附件 ref，不触碰投递状态或幂等标识。
  const receiptsPath = join(newRoot, "queued-steering-receipts.json");
  const receiptsInfo = await optionalStat(receiptsPath);
  if (!receiptsInfo) return;
  if (!receiptsInfo.isFile() || receiptsInfo.isSymbolicLink()) {
    throw new Error("迁移失败：引导回执不是普通文件。");
  }
  const restoreTimes = await preserveTimes(receiptsPath);
  let receipts: unknown;
  try { receipts = JSON.parse(await readFile(receiptsPath, "utf8")); }
  catch { await restoreTimes(); return; }
  if (!Array.isArray(receipts)) { await restoreTimes(); return; }
  let changed = false;
  for (const value of receipts) {
    const receipt = value as QueuedSteeringReceipt;
    if (!receipt || typeof receipt.queuedTurnId !== "string" || typeof receipt.sessionId !== "string" ||
        typeof receipt.messageId !== "string" || typeof receipt.expectedTurnId !== "string" ||
        (receipt.state !== "pending" && receipt.state !== "accepted")) {
      continue;
    }
    for (const attachment of receipt.message?.attachments ?? []) {
      if ((attachment.kind === "file" || attachment.kind === "image") && typeof attachment.ref === "string") {
        const next = relocatePath(attachment.ref);
        if (next !== attachment.ref) { attachment.ref = next; changed = true; }
      }
    }
  }
  if (changed) {
    const receiptFiles = new SubagentSnapshotFiles(newRoot);
    await receiptFiles.atomicWrite(receiptsPath, Buffer.from(`${JSON.stringify(receipts)}\n`, "utf8"));
  }
  await restoreTimes();
}
