import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isMediaReference, mediaReferenceBlock, toolResultText, type MediaReference } from "@pi-desktop/shared";

/** 与普通附件共用内容寻址存储；先写文件，成功后才返回可持久化的引用。 */
export class MediaStore {
  constructor(readonly root = join(process.env.PI_DESKTOP_DATA_DIR || join(homedir(), ".pi-desktop"), "attachments")) {}

  private async finish(temp: string, hash: string, size: number, mimeType: string): Promise<MediaReference> {
    const target = join(this.root, hash);
    // 完整临时文件原子替换同一内容，避免读到半写入的 blob。
    await rename(temp, target);
    return { ref: `attachments/${hash}`, mimeType, size };
  }

  async putFile(path: string, mimeType: string, maxBytes: number, signal?: AbortSignal): Promise<MediaReference> {
    await mkdir(this.root, { recursive: true });
    const temp = join(this.root, `.media-${randomUUID()}.tmp`);
    const hash = createHash("sha256");
    let size = 0;
    try {
      await pipeline(createReadStream(path), new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > maxBytes) return callback(new Error("媒体读取期间体积超过请求预算"));
          hash.update(chunk);
          callback(null, chunk);
        },
      }), createWriteStream(temp, { flags: "wx" }), { signal });
      signal?.throwIfAborted();
      return await this.finish(temp, hash.digest("hex"), size, mimeType);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  async putBase64(data: string, mimeType: string): Promise<MediaReference> {
    const normalized = data.replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) {
      throw new Error("媒体数据不是有效的 Base64，保留原消息以便恢复");
    }
    const bytes = Buffer.from(normalized, "base64");
    const hash = createHash("sha256").update(bytes).digest("hex");
    await mkdir(this.root, { recursive: true });
    const target = join(this.root, hash);
    try {
      if ((await stat(target)).size === bytes.length &&
          createHash("sha256").update(await readFile(target)).digest("hex") === hash) {
        return { ref: `attachments/${hash}`, mimeType, size: bytes.length };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temp = join(this.root, `.media-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, bytes, { flag: "wx" });
      return await this.finish(temp, hash, bytes.length, mimeType);
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  async read(ref: MediaReference, signal?: AbortSignal): Promise<string> {
    if (!isMediaReference(ref)) throw new Error("无效的媒体文件引用");
    const root = await realpath(this.root);
    const path = await realpath(join(root, ref.ref.slice("attachments/".length)));
    if (dirname(path) !== root || !(await stat(path)).isFile()) throw new Error("媒体文件不在附件目录内");
    if ((await stat(path)).size !== ref.size) throw new Error(`媒体文件大小已变化：${ref.ref}`);
    const bytes = await readFile(path, { signal });
    if (bytes.length !== ref.size || createHash("sha256").update(bytes).digest("hex") !== ref.ref.slice(12)) {
      throw new Error(`媒体文件校验失败：${ref.ref}`);
    }
    return bytes.toString("base64");
  }

  /** 旧内联记录仍可读取；转换只处理协议中的媒体块，保持普通文本和工具数据。 */
  async externalize<T>(value: T): Promise<T> {
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if ((record.type === "image" || record.type === "audio") &&
        typeof record.data === "string" && typeof record.mimeType === "string" &&
        /^(image|audio|video)\//i.test(record.mimeType)) {
      return mediaReferenceBlock(await this.putBase64(record.data, record.mimeType)) as T;
    }
    let changed = false;
    const result: Record<string, unknown> = {};
    // 顺序落盘，避免多段大视频同时解码造成内存尖峰。
    for (const [key, item] of Object.entries(value)) {
      const next = await this.externalize(item);
      result[key] = next;
      changed ||= next !== item;
    }
    if (!changed) return value;
    if (Array.isArray(value)) return Object.values(result) as T;
    if (record.role === "tool" && result.toolResult !== undefined) result.content = toolResultText(result.toolResult);
    return result as T;
  }
}

export const mediaStore = new MediaStore();
