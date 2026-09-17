/**
 * Host gateway attachment import (LAN remote control plugin, stage 2).
 *
 * The remote-control plugin receives uploads from a paired browser and must
 * hand them to the host without ever learning or forging a filesystem path the
 * browser chose. This module is the controlled bridge: bytes in, a
 * host-managed reference out.
 *
 * The reference is an absolute path inside the session's own scratch
 * directory, obtained from the host (`session/getScratchPath`) rather than
 * derived here. `preparePromptAttachments` already accepts that root for
 * `agent/prompt` and the Host queue, and `fs/readImageDataUrl` / `fs/read`
 * already accept it for preview, so no persistence format, permission check or
 * containment rule is widened by this module.
 *
 * Only the plugin gateway may call it: the operation it backs is marked
 * `pluginOnly` and never appears on the external MCP surface.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, lstat, realpath, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { McpControlOperation } from "./mcp-control";
import { stripWinLongPrefix } from "./path-utils";

/**
 * Plugin-only gateway operation behind {@link createGatewayAttachmentImporter}.
 *
 * It is deliberately not part of `CONTROL_OPERATION_SPECS`: it has no renderer
 * IPC channel, so it cannot appear in the external MCP catalog, and only an
 * authenticated plugin context can reach it through `pi.desktop.invoke`.
 */
export const GATEWAY_ATTACHMENT_OPERATIONS: McpControlOperation[] = [{
  id: "attachments/import",
  channel: "internal:gateway-attachment",
  description: "Stage plugin-supplied bytes as a host-managed session attachment reference.",
  risk: "write",
  argumentShape: ["{sessionId,name,mimeType,kind?,size?,dataBase64}"],
  pluginOnly: true,
}];

/** Matches the plugin upload cap and the shared inline-image bound. */
export const MAX_GATEWAY_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Bounded per-session staging so one device cannot fill the scratch root. */
export const MAX_GATEWAY_ATTACHMENTS_PER_SESSION = 100;
/** Directory created by this module inside the session scratch root. */
export const GATEWAY_ATTACHMENT_DIR = "lan-remote";

const ALLOWED_MIME_TYPES = new Set([
  "application/json",
  "application/pdf",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/markdown",
  "text/plain",
]);

const IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

type IpcInvoke = (channel: string, args: readonly unknown[]) => Promise<unknown>;

export type GatewayAttachmentInput = {
  sessionId: unknown;
  name: unknown;
  mimeType?: unknown;
  kind?: unknown;
  size?: unknown;
  dataBase64?: unknown;
};

export type GatewayAttachmentRef = {
  ref: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  sha256: string;
};

export type GatewayAttachmentImporter = (input: McpControlAttachmentInvokeInput) => Promise<GatewayAttachmentRef>;

/** Shape shared with the operation gateway; kept structural to avoid a cycle. */
export type McpControlAttachmentInvokeInput = {
  operation: string;
  args?: readonly unknown[];
  confirm?: boolean;
  source?: "mcp" | "plugin";
};

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** Matches the gateway error contract: `errorCode` first, then `code`. */
function safeSessionId(value: unknown): string {
  const sessionId = typeof value === "string" ? value.trim() : "";
  if (!sessionId || sessionId.length > 256) {
    fail("INVALID_PARAMS", "sessionId must be a non-empty string of at most 256 characters");
  }
  if (/[\u0000-\u001f\u007f]/.test(sessionId) || sessionId.includes("/") || sessionId.includes("\\")) {
    fail("INVALID_PARAMS", "sessionId must not contain path separators or control characters");
  }
  return sessionId;
}

function safeName(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const withoutControls = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  const tail = withoutControls.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  const collapsed = tail.replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/^\.+/, "").trim();
  return (collapsed || "attachment").slice(0, 100);
}

function safeMimeType(value: unknown, name: string): string {
  const declared = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (declared) {
    if (!ALLOWED_MIME_TYPES.has(declared)) {
      fail("INVALID_PARAMS", `unsupported attachment type: ${declared}`);
    }
    return declared;
  }
  fail("INVALID_PARAMS", "attachment mime type is required");
}

function safeKind(value: unknown, mimeType: string): "image" | "file" {
  const kind = value === "image" || value === "file" ? value : undefined;
  const inferred: "image" | "file" = IMAGE_MIME_TYPES.has(mimeType) ? "image" : "file";
  if (kind === "image" && inferred !== "image") {
    fail("INVALID_PARAMS", "attachment kind does not match its mime type");
  }
  return inferred;
}

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== "string" || !value.trim()) {
    fail("INVALID_PARAMS", "dataBase64 must be a non-empty base64 string");
  }
  if (value.length > Math.ceil(MAX_GATEWAY_ATTACHMENT_BYTES / 3) * 4) {
    fail("INVALID_PARAMS", "attachment payload is too large");
  }
  const normalized = value.replace(/\s+/g, "");
  if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    fail("INVALID_PARAMS", "dataBase64 is not valid base64");
  }
  const bytes = Buffer.from(normalized, "base64");
  if (!bytes.length) fail("INVALID_PARAMS", "attachment payload is empty");
  if (bytes.length > MAX_GATEWAY_ATTACHMENT_BYTES) {
    fail("INVALID_PARAMS", `attachment exceeds ${MAX_GATEWAY_ATTACHMENT_BYTES} bytes`);
  }
  return bytes;
}

function startsWith(bytes: Buffer, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

const SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  "image/png": (bytes) => startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (bytes) => startsWith(bytes, [0xff, 0xd8, 0xff]),
  "image/gif": (bytes) => bytes.subarray(0, 6).toString("latin1") === "GIF87a" ||
    bytes.subarray(0, 6).toString("latin1") === "GIF89a",
  "image/webp": (bytes) =>
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP",
  "application/pdf": (bytes) => bytes.subarray(0, 5).toString("latin1") === "%PDF-",
};

function assertMagicMatches(bytes: Buffer, mimeType: string): void {
  const check = SIGNATURES[mimeType];
  if (check && !check(bytes)) {
    fail("INVALID_PARAMS", `attachment bytes do not match ${mimeType}`);
  }
  if (mimeType === "text/plain" || mimeType === "text/markdown" || mimeType === "text/csv" || mimeType === "application/json") {
    if (bytes.includes(0)) fail("INVALID_PARAMS", "text attachment contains binary data");
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { fail("INVALID_PARAMS", "text attachment must be UTF-8"); }
  }
}

/** The scratch root is host-owned; only absolute, sanitized paths are accepted. */
function normalizeScratchPath(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || !isAbsolute(raw)) {
    fail("INTERNAL", "host returned an invalid session scratch path");
  }
  const normalized = resolve(stripWinLongPrefix(raw));
  const segments = normalized.split(sep).filter(Boolean);
  if (segments.some((segment) => segment === "..")) {
    fail("INTERNAL", "host returned an invalid session scratch path");
  }
  return normalized;
}

async function existingFileCount(directory: string): Promise<number> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).length;
  } catch {
    return 0;
  }
}

export function createGatewayAttachmentImporter(options: {
  channels: Readonly<Record<string, string>>;
  invoke: IpcInvoke;
}): { import: GatewayAttachmentImporter } {
  let pending = Promise.resolve();
  const importAttachment: GatewayAttachmentImporter = async (input) => {
      const args = input.args?.[0];
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        fail("INVALID_PARAMS", "one attachment import object is required");
      }
      const request = args as GatewayAttachmentInput;
      const sessionId = safeSessionId(request.sessionId);
      const name = safeName(request.name);
      const mimeType = safeMimeType(request.mimeType, name);
      const kind = safeKind(request.kind, mimeType);
      const bytes = decodeBase64(request.dataBase64);
      if (request.size !== undefined) {
        const declared = typeof request.size === "number" && Number.isFinite(request.size) ? request.size : NaN;
        if (!Number.isInteger(declared) || declared !== bytes.length) {
          fail("INVALID_PARAMS", "declared size does not match the attachment bytes");
        }
      }
      assertMagicMatches(bytes, mimeType);

      const existingSession = await options.invoke(options.channels.sessionGet, [{ id: sessionId, messageLimit: 1 }]) as { session?: unknown };
      if (!existingSession?.session) fail("NOT_FOUND", "session does not exist");
      const scratchChannel = options.channels.sessionGetScratchPath;
      if (!scratchChannel) {
        fail("UNSUPPORTED", "host api not available: session/getScratchPath");
      }
      const scratchResult = (await options.invoke(scratchChannel, [{ sessionId }])) as
        | { path?: unknown }
        | null;
      const scratchPath = normalizeScratchPath(scratchResult?.path);
      await mkdir(scratchPath, { recursive: true });
      const scratchRoot = await realpath(scratchPath);
      const directory = join(scratchRoot, GATEWAY_ATTACHMENT_DIR);
      await mkdir(directory, { recursive: true });
      if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) {
        fail("PERMISSION_DENIED", "attachment directory must not be a symbolic link");
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const target = join(directory, `${sha256}-${name}`);
      async function verifyExisting(): Promise<void> {
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes.length) fail("PERMISSION_DENIED", "attachment target is invalid");
        const existing = await readFile(target);
        if (createHash("sha256").update(existing).digest("hex") !== sha256) fail("PERMISSION_DENIED", "attachment content mismatch");
      }
      try {
        if (await existingFileCount(directory) >= MAX_GATEWAY_ATTACHMENTS_PER_SESSION) {
          await verifyExisting();
        } else {
          await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
        }
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") throw error;
        await verifyExisting();
      }
      return { ref: target, name, mimeType, size: bytes.length, kind, sha256 };
  };
  return { import: (input) => {
    const task = pending.then(() => importAttachment(input));
    pending = task.then(() => undefined, () => undefined);
    return task;
  }};
}
