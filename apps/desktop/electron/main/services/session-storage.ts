import { lstat, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { SessionScratchCleanupResult, SessionStorageUsage } from "@pi-desktop/shared";

export const SCRATCH_RETENTION_MS = 72 * 60 * 60 * 1000;
const ACTIVITY_FILE = ".pi-scratch-activity";
const RETAINED_NAMES = new Set(["pasted", "tool-output", "delegations", ACTIVITY_FILE]);
const activityWrites = new Map<string, Promise<void>>();
const activityTimes = new Map<string, number>();

function validId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

// 只在已有 scratch 中记录活动，避免为没有临时文件的会话创建空目录。
export async function noteSessionStorageActivity(dataDir: string, id: string): Promise<void> {
  if (!validId(id)) return;
  const root = join(dataDir, "scratch", id);
  activityTimes.set(root, Date.now());
  const previous = activityWrites.get(root) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    try {
      if (!await ownedPath(dataDir, root)) return;
      const marker = join(root, ACTIVITY_FILE);
      try {
        if ((await lstat(marker)).isSymbolicLink()) return;
      } catch (error) { if (!missing(error)) throw error; }
      await writeFile(marker, "", "utf8");
    } catch (error) { if (!missing(error)) throw error; }
  });
  activityWrites.set(root, pending);
  try { await pending; } finally {
    if (activityWrites.get(root) === pending) activityWrites.delete(root);
  }
}

// 每一层都检查，既不跟随 scratch 根链接，也不跟随树内 junction/symlink。
async function ownedPath(dataDir: string, path: string): Promise<boolean> {
  const rel = relative(dataDir, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) return false;
  let current = dataDir;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) return false;
  }
  return true;
}

type FileEntry = { path: string; bytes: number; mtime: number; ctime: number; ino: number; dev: number };
type Tree = { bytes: number; latest: number; partial: boolean; files: FileEntry[]; directories: string[] };

async function scanTree(dataDir: string, root: string, skip?: (name: string) => boolean): Promise<Tree> {
  const tree: Tree = { bytes: 0, latest: 0, partial: false, files: [], directories: [] };
  const visit = async (path: string, top: boolean): Promise<void> => {
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) { tree.partial = true; return; }
      tree.latest = Math.max(tree.latest, stat.mtimeMs, stat.birthtimeMs);
      if (stat.isDirectory()) {
        tree.directories.push(path);
        for (const entry of await readdir(path, { withFileTypes: true })) {
          if (top && skip?.(entry.name.toLowerCase())) continue;
          await visit(join(path, entry.name), false);
        }
      } else if (stat.isFile()) {
        tree.bytes += stat.size;
        tree.files.push({ path, bytes: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, ino: stat.ino, dev: stat.dev });
      }
    } catch (error) { if (!missing(error)) tree.partial = true; }
  };
  try {
    if (await ownedPath(dataDir, root)) await visit(root, true);
    else tree.partial = true;
  } catch (error) { if (!missing(error)) tree.partial = true; }
  return tree;
}

export type StorageSession = { id: string; updatedAt?: string; lastUserMessageAt?: string };
type Dependencies = {
  dataDir: string;
  listSessions: () => Promise<StorageSession[]>;
  getSession: (id: string) => Promise<StorageSession>;
  isBusy: (id: string) => Promise<boolean>;
  acquire: (id: string) => Promise<() => void>;
  available: () => boolean;
  log: (message: string, data?: unknown) => void;
};

export class SessionStorageService {
  private sweeping = false;
  private timer?: ReturnType<typeof setInterval>;
  private initial?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly busySessions = new Set<string>();

  constructor(private readonly deps: Dependencies) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    // 启动后让宿主先完成初始化；之后每小时补扫，包括上次退出期间到期的文件。
    this.initial = setTimeout(() => void this.sweep(), 30_000);
    this.initial.unref();
    this.timer = setInterval(() => void this.sweep(), 60 * 60 * 1000);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.initial);
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private scratch(id: string): string {
    if (!validId(id)) throw new Error("Invalid local session id");
    return join(this.deps.dataDir, "scratch", id);
  }

  private async temporary(id: string): Promise<Tree> {
    return scanTree(this.deps.dataDir, this.scratch(id), (name) => RETAINED_NAMES.has(name));
  }

  private async busy(id: string): Promise<boolean> {
    const busy = await this.deps.isBusy(id);
    if (busy) this.busySessions.add(id);
    else if (this.busySessions.delete(id)) {
      // 首次观察到实际空闲时重新计时，取消收尾也获得完整保留期。
      await noteSessionStorageActivity(this.deps.dataDir, id);
    }
    return busy;
  }

  async usage(id: string): Promise<SessionStorageUsage> {
    this.scratch(id);
    await this.deps.getSession(id);
    const temporary = await this.temporary(id);
    const retained: Tree[] = [];
    for (const name of RETAINED_NAMES) {
      retained.push(await scanTree(this.deps.dataDir, join(this.scratch(id), name)));
    }
    for (const path of [
      join(this.deps.dataDir, "visualizations", id),
      join(this.deps.dataDir, "review-changes", id),
      join(this.deps.dataDir, "subagent-contexts", "v1", id),
    ]) retained.push(await scanTree(this.deps.dataDir, path));
    // transcript、revision、inflight 及其索引/临时落盘文件均使用 <id>. 前缀。
    const transcripts = join(this.deps.dataDir, "sessions");
    let partial = temporary.partial;
    try {
      if (!await ownedPath(this.deps.dataDir, transcripts)) partial = true;
      else for (const entry of await readdir(transcripts)) {
        if (entry.startsWith(`${id}.`)) retained.push(await scanTree(this.deps.dataDir, join(transcripts, entry)));
      }
    } catch (error) { if (!missing(error)) partial = true; }
    const retainedBytes = retained.reduce((sum, tree) => sum + tree.bytes, 0);
    return {
      totalBytes: temporary.bytes + retainedBytes,
      temporaryBytes: temporary.bytes,
      retainedBytes,
      busy: await this.busy(id),
      partial: partial || retained.some((tree) => tree.partial),
    };
  }

  async clean(id: string, automatic = false): Promise<SessionScratchCleanupResult | null> {
    const root = this.scratch(id);
    const release = await this.deps.acquire(id);
    try {
      if (this.stopped || !this.deps.available()) throw new Error("Session storage is unavailable");
      const session = await this.deps.getSession(id);
      if (await this.busy(id)) {
        await noteSessionStorageActivity(this.deps.dataDir, id);
        if (automatic) return null;
        throw Object.assign(new Error("Cannot clean files while the session is running"), { errorCode: "AGENT_BUSY" });
      }
      await activityWrites.get(root);
      const tree = await this.temporary(id);
      let lastActivity = Math.max(activityTimes.get(root) ?? 0, tree.latest);
      for (const timestamp of [session.updatedAt, session.lastUserMessageAt]) {
        const value = Date.parse(timestamp ?? "");
        if (Number.isFinite(value)) lastActivity = Math.max(lastActivity, value);
      }
      try {
        const marker = await lstat(join(root, ACTIVITY_FILE));
        lastActivity = Math.max(lastActivity, marker.mtimeMs);
      } catch (error) { if (!missing(error)) throw error; }
      if (automatic && (tree.partial || !lastActivity || Date.now() - lastActivity < SCRATCH_RETENTION_MS)) return null;
      // 文件树扫描期间可能收到运行状态变化；真正删除前再次核对。
      if (await this.busy(id)) {
        if (automatic) return null;
        throw Object.assign(new Error("Cannot clean files while the session is running"), { errorCode: "AGENT_BUSY" });
      }
      let freedBytes = 0;
      let failedEntries = tree.partial ? 1 : 0;
      for (const file of tree.files) {
        if (this.stopped || !this.deps.available()) { failedEntries++; break; }
        try {
          if (!await ownedPath(this.deps.dataDir, file.path)) { failedEntries++; continue; }
          const current = await lstat(file.path);
          if (!current.isFile() || current.size !== file.bytes || current.mtimeMs !== file.mtime || current.ctimeMs !== file.ctime || current.ino !== file.ino || current.dev !== file.dev) {
            failedEntries++;
            continue;
          }
          await unlink(file.path);
          freedBytes += file.bytes;
        } catch (error) { if (!missing(error)) failedEntries++; }
      }
      for (const directory of tree.directories.reverse()) {
        if (directory === root || this.stopped) continue;
        try {
          if (await ownedPath(this.deps.dataDir, directory)) await rmdir(directory);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") failedEntries++;
        }
      }
      this.deps.log("session scratch cleaned", { sessionId: id, automatic, freedBytes, failedEntries });
      return { freedBytes, failedEntries, usage: await this.usage(id) };
    } finally { release(); }
  }

  async sweep(): Promise<void> {
    if (this.sweeping || this.stopped || !this.deps.available()) return;
    this.sweeping = true;
    try {
      const sessions = await this.deps.listSessions();
      for (const session of sessions) {
        if (this.stopped || !this.deps.available()) break;
        if (!validId(session.id)) continue;
        try { await this.clean(session.id, true); }
        catch (error) { this.deps.log("session scratch cleanup deferred", { sessionId: session.id, error: String(error) }); }
      }
    } catch (error) { this.deps.log("session scratch sweep deferred", { error: String(error) }); }
    finally { this.sweeping = false; }
  }
}
