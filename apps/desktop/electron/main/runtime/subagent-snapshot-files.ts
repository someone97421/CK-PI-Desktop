import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const SNAPSHOT_FILE_LIMIT = 16 * 1024 * 1024;
const JSON_FORMAT = "subagent-contexts/v1";

interface PlainSnapshotEnvelope {
  format: typeof JSON_FORMAT;
  identity: string;
  value: unknown;
}

/** 独占目录内的有界快照文件操作。不得向日志传递正文或敏感载荷。 */
export class SubagentSnapshotFiles {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async initialize(): Promise<void> {
    await this.ensureDirectory(this.root);
  }

  path(...parts: string[]): string {
    for (const part of parts) {
      if (!part || part === "." || part === ".." || /[\\/\x00]/.test(part) || isAbsolute(part)) {
        throw new Error("快照路径标识无效。");
      }
    }
    const path = resolve(this.root, ...parts);
    this.assertWithinRoot(path);
    return path;
  }

  private assertWithinRoot(path: string): void {
    const rel = relative(this.root, resolve(path));
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("快照路径越界。");
  }

  /** 检查根目录的每一层，包含首次创建之前的祖先目录。 */
  async ensureDirectory(path: string, create = true): Promise<void> {
    this.assertWithinRoot(path);
    const inspect = async (current: string): Promise<void> => {
      const parent = dirname(current);
      if (parent !== current) await inspect(parent);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("快照目录不能使用链接或非目录节点。");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!create) throw error;
        try { await mkdir(current, { mode: 0o700 }); }
        catch (createError) {
          if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError;
          const info = await lstat(current);
          if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("快照目录不能使用链接或非目录节点。");
        }
      }
    };
    await inspect(resolve(path));
    const actual = await realpath(path);
    if (resolve(actual).toLowerCase() !== resolve(path).toLowerCase() && process.platform === "win32") {
      throw new Error("快照目录真实路径不匹配。");
    }
    if (process.platform !== "win32" && resolve(actual) !== resolve(path)) throw new Error("快照目录真实路径不匹配。");
  }

  async readBounded(path: string, limit = SNAPSHOT_FILE_LIMIT): Promise<Buffer> {
    this.assertWithinRoot(path);
    await this.ensureDirectory(dirname(path), false);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error("快照文件类型或大小无效。");
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > limit || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error("快照读取期间文件发生变化。");
      const bytes = Buffer.alloc(opened.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > opened.size) throw new Error("快照读取期间文件大小发生变化。");
      return bytes.subarray(0, offset);
    } finally {
      await handle.close();
    }
  }

  encode(value: unknown, identity: string, limit = SNAPSHOT_FILE_LIMIT): Buffer {
    const envelope: PlainSnapshotEnvelope = { format: JSON_FORMAT, identity, value };
    const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
    if (bytes.length > limit) throw new Error("快照超过大小限制。");
    return bytes;
  }

  decode<T>(bytes: Buffer, identity: string): T {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("快照 JSON 格式无效。");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("快照 JSON 格式无效。");
    }
    const envelope = parsed as Partial<PlainSnapshotEnvelope>;
    if (envelope.format !== JSON_FORMAT || envelope.identity !== identity || !("value" in envelope)) {
      throw new Error("快照格式或身份不匹配。");
    }
    return envelope.value as T;
  }

  /** 同卷 rename 覆盖目标；失败时绝不先删除旧 control。 */
  async atomicWrite(path: string, bytes: Buffer): Promise<void> {
    this.assertWithinRoot(path);
    await this.ensureDirectory(dirname(path));
    try {
      const existing = await lstat(path);
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("快照目标不是普通文件。");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
      // Windows 不支持目录 fsync；这里只承诺进程崩溃一致性，不承诺所有设备断电耐久性。
      if (process.platform !== "win32") {
        const directory = await open(dirname(path), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }

}
