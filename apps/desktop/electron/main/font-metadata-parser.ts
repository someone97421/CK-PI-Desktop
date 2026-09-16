import { open } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { brotliDecompress } from "node:zlib";
import { promisify } from "node:util";
import type { FontFaceMetadata } from "@pi-desktop/shared";

const decompress = promisify(brotliDecompress);
const MAX_FILE = 128 * 1024 * 1024;
const MAX_TABLE = 1024 * 1024;
const wanted = new Set(["name", "OS/2", "fvar", "head"]);
type Tables = Map<string, Buffer>;
export type ParsedFontFace = FontFaceMetadata & { families: string[] };

function slice(data: Buffer, offset: number, length: number): Buffer {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > data.length) {
    throw new Error("Invalid font bounds");
  }
  return data.subarray(offset, offset + length);
}

/** Only metadata tables are interpreted, never glyph programs or outlines. */
export function parseFontTables(tables: Tables): ParsedFontFace {
  const name = tables.get("name");
  const os2 = tables.get("OS/2");
  if (!name || !os2 || os2.length < 64 || name.length < 6) throw new Error("Missing font metadata");
  const count = name.readUInt16BE(2);
  const strings = name.readUInt16BE(4);
  if (count > 4096 || strings < 6 + count * 12) throw new Error("Invalid name table");
  slice(name, 6, count * 12);
  const names = new Map<number, { value: string; rank: number }[]>();
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12;
    const platform = name.readUInt16BE(at);
    const encoding = name.readUInt16BE(at + 2);
    const language = name.readUInt16BE(at + 4);
    const id = name.readUInt16BE(at + 6);
    if (![1, 2, 16, 17, 21, 22].includes(id)) continue;
    const raw = slice(name, strings + name.readUInt16BE(at + 10), name.readUInt16BE(at + 8));
    if (raw.length > 2048) continue;
    let value: string;
    if (platform === 0 || (platform === 3 && [0, 1, 10].includes(encoding))) {
      if (raw.length % 2) continue;
      value = new TextDecoder("utf-16be", { fatal: true }).decode(raw);
    } else if (platform === 1 && encoding === 0) {
      value = new TextDecoder("macintosh").decode(raw);
    } else continue;
    value = value.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
    if (!value) continue;
    const entries = names.get(id) ?? [];
    entries.push({ value, rank: language === 0x409 ? 0 : platform === 0 ? 1 : platform === 3 ? 2 : 3 });
    names.set(id, entries);
  }
  const best = (id: number) => names.get(id)?.sort((a, b) => a.rank - b.rank)[0]?.value;
  const families = [...new Set([1, 16, 21].flatMap((id) => names.get(id)?.map((entry) => entry.value) ?? []))];
  const faceName = best(17) ?? best(22) ?? best(2);
  const weight = os2.readUInt16BE(4);
  const width = os2.readUInt16BE(6);
  if (!families.length || !faceName || weight < 1 || weight > 1000 || width < 1 || width > 9) throw new Error("Invalid font metadata");
  const selection = os2.readUInt16BE(62);
  const head = tables.get("head");
  const italic = Boolean(selection & 0x201) || Boolean(head && head.length >= 46 && (head.readUInt16BE(44) & 2));
  const face: ParsedFontFace = { families, name: faceName, weight, width, style: italic ? "italic" : "normal", variable: false };
  const fvar = tables.get("fvar");
  if (!fvar) return face;
  if (fvar.length < 16 || fvar.readUInt16BE(0) !== 1) throw new Error("Invalid fvar table");
  const axisOffset = fvar.readUInt16BE(4);
  const axisCount = fvar.readUInt16BE(8);
  const axisSize = fvar.readUInt16BE(10);
  const instanceCount = fvar.readUInt16BE(12);
  const instanceSize = fvar.readUInt16BE(14);
  if (axisOffset < 16 || axisCount > 64 || axisSize < 20 || instanceCount > 4096 || (instanceCount && instanceSize < 4 + axisCount * 4)) throw new Error("Invalid fvar records");
  slice(fvar, axisOffset, axisCount * axisSize + instanceCount * instanceSize);
  face.variable = axisCount > 0;
  const tags = new Set<string>();
  for (let i = 0; i < axisCount; i++) {
    const at = axisOffset + i * axisSize;
    const tag = fvar.toString("ascii", at, at + 4);
    if (tags.has(tag)) throw new Error("Duplicate variation axis");
    tags.add(tag);
    const min = fvar.readInt32BE(at + 4) / 65536;
    const normal = fvar.readInt32BE(at + 8) / 65536;
    const max = fvar.readInt32BE(at + 12) / 65536;
    if (min > normal || normal > max) throw new Error("Invalid variation range");
    if (tag === "wght") {
      if (min < 1 || max > 1000) throw new Error("Invalid CSS weight axis");
      face.wght = { min, max, default: normal };
      face.weight = normal;
    }
  }
  return face;
}

const woffTags = [
  "cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT",
  "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB", "EBSC", "JSTF", "MATH",
  "CBDT", "CBLC", "COLR", "CPAL", "SVG ", "sbix", "acnt", "avar", "bdat", "bloc", "bsln", "cvar", "fdsc", "feat", "fmtx", "fvar",
  "gvar", "hsty", "just", "lcar", "mort", "morx", "opbd", "prop", "trak", "Zapf", "Silf", "Glat", "Gloc", "Feat", "Sill",
];

/** WOFF2 metadata uses the null transform. Outlines do not need reconstruction. */
export async function parseWoff2Metadata(data: Buffer): Promise<ParsedFontFace[]> {
  slice(data, 0, 48);
  if (data.toString("ascii", 0, 4) !== "wOF2" || data.toString("ascii", 4, 8) === "ttcf" || data.readUInt32BE(8) !== data.length) throw new Error("Unsupported WOFF2");
  const count = data.readUInt16BE(12);
  if (!count || count > 256) throw new Error("Invalid WOFF2 directory");
  let at = 48;
  const base128 = () => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = slice(data, at++, 1)[0];
      if ((!i && byte === 128) || value > 0x1ffffff) throw new Error("Invalid base128");
      value = value * 128 + (byte & 127);
      if (!(byte & 128)) return value;
    }
    throw new Error("Invalid base128");
  };
  const directory: { tag: string; offset: number; length: number }[] = [];
  let size = 0;
  for (let i = 0; i < count; i++) {
    const flags = slice(data, at++, 1)[0];
    const index = flags & 63;
    const tag = index === 63 ? slice(data, at, 4).toString("ascii") : woffTags[index];
    if (index === 63) at += 4;
    const version = flags >> 6;
    const glyph = tag === "glyf" || tag === "loca";
    if (glyph ? version !== 0 && version !== 3 : version !== 0 && !(tag === "hmtx" && version === 1)) throw new Error("Unsupported WOFF2 transform");
    const original = base128();
    const transformed = glyph ? version !== 3 : version !== 0;
    const length = transformed ? base128() : original;
    if (wanted.has(tag) && length > MAX_TABLE) throw new Error("Oversized metadata table");
    if (directory.some((entry) => entry.tag === tag)) throw new Error("Duplicate WOFF2 table");
    directory.push({ tag, offset: size, length });
    size += length;
    if (size > MAX_FILE) throw new Error("Oversized WOFF2");
  }
  const decoded = await decompress(slice(data, at, data.readUInt32BE(20)), { maxOutputLength: MAX_FILE });
  if (decoded.length !== size) throw new Error("Invalid WOFF2 data size");
  return [parseFontTables(new Map(directory.filter((entry) => wanted.has(entry.tag)).map((entry) => [entry.tag, slice(decoded, entry.offset, entry.length)])))];
}

/** No filesystem access: reject UNC and device namespaces before opening a font. */
export function localFontPath(path: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!path || /[\u0000-\u001f\u007f]/.test(path)) return undefined;
  const windowsPath = path.replace(/\//g, "\\");
  if (windowsPath.startsWith("\\\\")) return undefined;
  if (platform === "win32") {
    // Only ordinary drive-absolute paths. This also rejects \??\, drive-relative
    // paths, ADS and all extended/device spellings, including slash variants.
    if (!/^[a-z]:\\/i.test(windowsPath) || /[:*?"<>|]/.test(windowsPath.slice(2))) return undefined;
    const normalized = win32.normalize(windowsPath);
    if (normalized.slice(3).split("\\").some((part) => /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(part.trimEnd()))) return undefined;
    return normalized;
  }
  return posix.isAbsolute(path) ? posix.normalize(path) : undefined;
}

/** Read bounded metadata only for SFNT/TTC; large CJK outlines stay on disk. */
export async function readFontMetadata(path: string, signal?: AbortSignal): Promise<ParsedFontFace[]> {
  signal?.throwIfAborted();
  const localPath = localFontPath(path);
  if (!localPath) throw new Error("Non-local font path");
  const file = await open(localPath, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FILE || stat.size < 12) throw new Error("Unsupported font file");
    const read = async (offset: number, length: number, limit = MAX_TABLE) => {
      signal?.throwIfAborted();
      if (offset < 0 || length < 0 || length > limit || offset + length > stat.size) throw new Error("Invalid font bounds");
      const buffer = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        signal?.throwIfAborted();
        const { bytesRead } = await file.read(buffer, done, length - done, offset + done);
        if (!bytesRead) throw new Error("Truncated font");
        done += bytesRead;
      }
      return buffer;
    };
    const header = await read(0, 12);
    if (header.toString("ascii", 0, 4) === "wOF2") {
      return await parseWoff2Metadata(await read(0, stat.size, MAX_FILE));
    }
    let offsets = [0];
    if (header.toString("ascii", 0, 4) === "ttcf") {
      const count = header.readUInt32BE(8);
      if (!count || count > 256) throw new Error("Invalid font collection");
      const entries = await read(12, count * 4);
      offsets = Array.from({ length: count }, (_, i) => entries.readUInt32BE(i * 4));
    }
    const faces: ParsedFontFace[] = [];
    for (const offset of offsets) {
      const sfnt = await read(offset, 12);
      if (![0x00010000, 0x4f54544f, 0x74727565].includes(sfnt.readUInt32BE(0))) throw new Error("Unsupported SFNT");
      const count = sfnt.readUInt16BE(4);
      if (!count || count > 256) throw new Error("Invalid SFNT directory");
      const directory = await read(offset + 12, count * 16);
      const tables: Tables = new Map();
      for (let i = 0; i < count; i++) {
        const at = i * 16;
        const tag = directory.toString("ascii", at, at + 4);
        if (!wanted.has(tag)) continue;
        if (tables.has(tag)) throw new Error("Duplicate font table");
        tables.set(tag, await read(directory.readUInt32BE(at + 8), directory.readUInt32BE(at + 12)));
      }
      faces.push(parseFontTables(tables));
    }
    return faces;
  } finally {
    await file.close();
  }
}
