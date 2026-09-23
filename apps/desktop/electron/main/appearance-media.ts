import { promises as fs, readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { nativeImage } from "electron";
import {
  APPEARANCE_MEDIA_KINDS,
  APPEARANCE_MEDIA_SCHEME,
  type AppearanceMediaAsset,
  type AppearanceMediaExport,
  type AppearanceMediaExportAsset,
  type AppearanceMediaKind,
  type AppearanceMediaMimeType,
  type AppearanceMediaState,
} from "@pi-desktop/shared";

const STORE_DIRECTORY = "appearance-media";
const MANIFEST_FILE = "manifest.json";

const EXTENSIONS: Record<AppearanceMediaMimeType, string> = {
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

type ManifestAsset = {
  fileName: string;
  mimeType: AppearanceMediaMimeType;
  originalName: string;
};
type Manifest = {
  version: 1;
  assets: Partial<Record<AppearanceMediaKind, ManifestAsset>>;
};

const emptyManifest = (): Manifest => ({ version: 1, assets: {} });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function sniffMimeType(bytes: Uint8Array): AppearanceMediaMimeType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  const ascii = (start: number, end: number) => Buffer.from(bytes.subarray(start, end)).toString("ascii");
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && ascii(4, 8) === "ftyp") return "video/mp4";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  return null;
}

function validateBytes(kind: AppearanceMediaKind, bytes: Uint8Array): AppearanceMediaMimeType {
  const mimeType = sniffMimeType(bytes);
  if (!mimeType || (kind === "icon" && mimeType !== "image/png")) {
    throw new Error(kind === "icon" ? "图标必须是有效的 PNG 文件" : "主页媒体必须是有效的 PNG、GIF、WebP、MP4 或 WebM 文件");
  }
  if (kind === "icon" && nativeImage.createFromBuffer(Buffer.from(bytes)).isEmpty()) {
    throw new Error("图标必须是有效的 PNG 文件");
  }
  return mimeType;
}

function cleanOriginalName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const name = basename(value.trim()).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
  return name || fallback;
}

function isManifestAsset(value: unknown, kind: AppearanceMediaKind): value is ManifestAsset {
  if (!isRecord(value)) return false;
  if (typeof value.fileName !== "string" || typeof value.mimeType !== "string" || typeof value.originalName !== "string") return false;
  const extension = EXTENSIONS[value.mimeType as AppearanceMediaMimeType];
  return Boolean(extension && (kind !== "icon" || value.mimeType === "image/png") &&
    new RegExp(`^${kind}-[a-f0-9-]{36}\\.${extension}$`).test(value.fileName));
}

export function appearanceMediaDirectory(dataDir: string): string {
  return join(dataDir, STORE_DIRECTORY);
}

/** The only disk paths the appearance-media protocol is allowed to expose. */
export function resolveAppearanceMediaProtocolPath(dataDir: string, fileName: string): string | null {
  if (!/^(?:icon-[a-f0-9-]{36}\.png|home-[a-f0-9-]{36}\.(?:png|gif|webp|mp4|webm))$/.test(fileName)) return null;
  return join(appearanceMediaDirectory(dataDir), fileName);
}

/** 启动窗口和托盘也以已提交清单为准。 */
export function readAppearanceIconPath(dataDir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(appearanceMediaDirectory(dataDir), MANIFEST_FILE), "utf8"));
    if (!isRecord(manifest) || manifest.version !== 1 || !isRecord(manifest.assets) || !isManifestAsset(manifest.assets.icon, "icon")) return null;
    const path = join(appearanceMediaDirectory(dataDir), manifest.assets.icon.fileName);
    return existsSync(path) ? path : null;
  } catch { return null; }
}

export class AppearanceMediaStore {
  readonly directory: string;
  readonly manifestPath: string;

  private queue: Promise<unknown> = Promise.resolve();

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => undefined);
    return result;
  }
  constructor(dataDir: string, private readonly onChanged?: (state: AppearanceMediaState) => void) {
    this.directory = appearanceMediaDirectory(dataDir);
    this.manifestPath = join(this.directory, MANIFEST_FILE);
  }

  private async readManifest(): Promise<Manifest> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.manifestPath, "utf8"));
      if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.assets)) return emptyManifest();
      const manifest = emptyManifest();
      for (const kind of APPEARANCE_MEDIA_KINDS) {
        const asset = parsed.assets[kind];
        if (isManifestAsset(asset, kind)) manifest.assets[kind] = asset;
      }
      return manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return emptyManifest();
      throw error;
    }
  }

  private async writeManifest(manifest: Manifest): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.manifest-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, this.manifestPath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async assetState(kind: AppearanceMediaKind, asset: ManifestAsset | undefined): Promise<AppearanceMediaAsset | null> {
    if (!asset) return null;
    const path = join(this.directory, asset.fileName);
    try {
      const stat = await fs.stat(path);
      if (!stat.isFile() || stat.size <= 0) return null;
      return {
        kind,
        mimeType: asset.mimeType,
        originalName: asset.originalName,
        url: `${APPEARANCE_MEDIA_SCHEME}://local/${asset.fileName}?v=${Math.trunc(stat.mtimeMs)}`,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async getState(): Promise<AppearanceMediaState> {
    return this.serialize(() => this.readState());
  }

  private async readState(): Promise<AppearanceMediaState> {
    const manifest = await this.readManifest();
    const [icon, home] = await Promise.all([
      this.assetState("icon", manifest.assets.icon),
      this.assetState("home", manifest.assets.home),
    ]);
    return { icon, home };
  }

  private async publishState(): Promise<AppearanceMediaState> {
    const state = await this.readState();
    this.onChanged?.(state);
    return state;
  }

  async getPath(kind: AppearanceMediaKind): Promise<string | null> {
    return this.serialize(async () => {
      const manifest = await this.readManifest();
      const state = await this.assetState(kind, manifest.assets[kind]);
      return state ? join(this.directory, manifest.assets[kind]!.fileName) : null;
    });
  }

  async replaceFromPath(kind: AppearanceMediaKind, sourcePath: string): Promise<AppearanceMediaState> {
    const bytes = await fs.readFile(sourcePath);
    return this.replaceBytes(kind, bytes, basename(sourcePath));
  }

  async replaceBytes(kind: AppearanceMediaKind, bytes: Uint8Array, originalName: string): Promise<AppearanceMediaState> {
    return this.serialize(async () => {
      const mimeType = validateBytes(kind, bytes);
      const fileName = `${kind}-${randomUUID()}.${EXTENSIONS[mimeType]}`;
      const manifest = await this.readManifest();
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const destination = join(this.directory, fileName);
      const previous = manifest.assets[kind]?.fileName;
      try {
        await fs.writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
        manifest.assets[kind] = { fileName, mimeType, originalName: cleanOriginalName(originalName, fileName) };
        await this.writeManifest(manifest);
      } catch (error) {
        await fs.rm(destination, { force: true }).catch(() => undefined);
        throw error;
      }
      // 清单提交后清理失败不应把成功保存报告为失败。
      if (previous) await fs.rm(join(this.directory, previous), { force: true }).catch(() => undefined);
      return this.publishState();
    });
  }

  async reset(kind: AppearanceMediaKind): Promise<AppearanceMediaState> {
    return this.serialize(async () => {
      const manifest = await this.readManifest();
      const previous = manifest.assets[kind];
      delete manifest.assets[kind];
      await this.writeManifest(manifest);
      if (previous) await fs.rm(join(this.directory, previous.fileName), { force: true }).catch(() => undefined);
      return this.publishState();
    });
  }

  async exportMedia(): Promise<AppearanceMediaExport> {
    return this.serialize(() => this.readExport());
  }

  private async readExport(): Promise<AppearanceMediaExport> {
    const manifest = await this.readManifest();
    const exported: AppearanceMediaExport = {};
    for (const kind of APPEARANCE_MEDIA_KINDS) {
      const asset = manifest.assets[kind];
      if (!asset || !(await this.assetState(kind, asset))) {
        exported[kind] = null;
        continue;
      }
      const bytes = await fs.readFile(join(this.directory, asset.fileName));
      exported[kind] = {
        mimeType: asset.mimeType,
        originalName: asset.originalName,
        dataBase64: bytes.toString("base64"),
      };
    }
    return exported;
  }

  parseExportAsset(kind: AppearanceMediaKind, value: unknown): AppearanceMediaExportAsset | null | undefined {
    if (value === null) return null;
    if (!isRecord(value) || typeof value.mimeType !== "string" || typeof value.dataBase64 !== "string") return undefined;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value.dataBase64) || value.dataBase64.length % 4 !== 0) return undefined;
    const bytes = Buffer.from(value.dataBase64, "base64");
    try {
      const mimeType = validateBytes(kind, bytes);
      if (mimeType !== value.mimeType) return undefined;
      return {
        mimeType,
        originalName: cleanOriginalName(value.originalName, `${kind}.${EXTENSIONS[mimeType]}`),
        dataBase64: value.dataBase64,
      };
    } catch {
      return undefined;
    }
  }

  async importAsset(kind: AppearanceMediaKind, asset: AppearanceMediaExportAsset | null): Promise<AppearanceMediaState> {
    if (asset === null) return this.reset(kind);
    return this.replaceBytes(kind, Buffer.from(asset.dataBase64, "base64"), asset.originalName);
  }
}
