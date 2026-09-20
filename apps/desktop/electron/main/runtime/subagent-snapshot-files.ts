import { createDecipheriv, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** 只依赖安全存储的最小接口；主进程注入 Electron safeStorage。 */
export interface SnapshotKeyProtector {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export class LegacySnapshotKeyUnavailableError extends Error {
  constructor() {
    super("旧版加密快照密钥不可用。");
    this.name = "LegacySnapshotKeyUnavailableError";
  }
}

export const SNAPSHOT_FILE_LIMIT = 16 * 1024 * 1024;
const LEGACY_HEADER_BYTES = 4 + 12 + 16;
const LEGACY_MAGIC = Buffer.from("SAC1");
const JSON_FORMAT = "subagent-contexts/v1";

interface PlainSnapshotEnvelope {
  format: typeof JSON_FORMAT;
  identity: string;
  value: unknown;
}

/** 独占目录内的有界快照文件操作。不得向日志传递正文、密钥或解密错误的原始载荷。 */
export class SubagentSnapshotFiles {
  readonly root: string;
  private legacyKey?: Buffer;

  constructor(root: string, private readonly protector: SnapshotKeyProtector) {
    this.root = resolve(root);
  }

  async initialize(): Promise<void> {
    await this.ensureDirectory(this.root);

    // 新快照不依赖安全存储；仅在可用时加载旧 SAC1 文件所需的历史密钥。
    let canDecryptLegacy = false;
    try {
      const backend = process.platform === "linux" ? this.protector.getSelectedStorageBackend?.() : undefined;
      canDecryptLegacy = this.protector.isEncryptionAvailable() && (
        process.platform !== "linux" ||
        ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(backend ?? "")
      );
    } catch {
      return;
    }
    if (!canDecryptLegacy) return;

    let protectedKey: Buffer;
    try {
      protectedKey = await this.readBounded(this.path("key.bin"), 64 * 1024);
    } catch {
      // 缺失、损坏或不可访问的旧密钥只影响旧 SAC1 文件，不阻断普通 JSON 存储。
      return;
    }

    try {
      const decoded = Buffer.from(this.protector.decryptString(protectedKey), "base64");
      if (decoded.length !== 32) {
        decoded.fill(0);
        return;
      }
      this.legacyKey = decoded;
    } catch {
      // 当前系统用户无法解密旧密钥时，仍允许保存和读取新的普通 JSON 快照。
    }
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
  async ensureDirectory(path: string): Promise<void> {
    this.assertWithinRoot(path);
    const inspect = async (current: string): Promise<void> => {
      const parent = dirname(current);
      if (parent !== current) await inspect(parent);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("快照目录不能使用链接或非目录节点。");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(current, { mode: 0o700 });
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
    await this.ensureDirectory(dirname(path));
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
    if (bytes.subarray(0, 4).equals(LEGACY_MAGIC)) {
      return this.decodeLegacy<T>(bytes, identity);
    }

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

  private decodeLegacy<T>(bytes: Buffer, identity: string): T {
    if (!this.legacyKey) throw new LegacySnapshotKeyUnavailableError();
    if (bytes.length < LEGACY_HEADER_BYTES) throw new Error("旧版加密快照格式无效。");
    let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.legacyKey, bytes.subarray(4, 16));
      decipher.setAAD(Buffer.from(`subagent-contexts/v1/${identity}`, "utf8"));
      decipher.setAuthTag(bytes.subarray(16, 32));
      plaintext = Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]);
      return JSON.parse(plaintext.toString("utf8")) as T;
    } catch {
      throw new Error("旧版加密快照认证失败或内容损坏。");
    } finally {
      plaintext?.fill(0);
    }
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

  destroy(): void {
    this.legacyKey?.fill(0);
    this.legacyKey = undefined;
  }
}
