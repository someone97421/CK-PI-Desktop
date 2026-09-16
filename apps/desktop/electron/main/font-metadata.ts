import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { FontFaceMetadata, FontMetadata } from "@pi-desktop/shared";
import { localFontPath, readFontMetadata } from "./font-metadata-parser";
import fontsCss from "../../src/styles/fonts.css?raw";
import geistPath from "../../src/assets/fonts/geist.woff2?asset";
import interPath from "../../src/assets/fonts/inter.woff2?asset";
import notoPath from "../../src/assets/fonts/noto-sans-sc.woff2?asset";
import wenkaiPath from "../../src/assets/fonts/lxgw-wenkai.woff2?asset";

const run = promisify(execFile);
const TTL = 60_000;
const TIMEOUT = 20_000;
const MAX_FILES = 8000;
const key = (family: string) => family.normalize("NFC").toLowerCase();
const bundledPaths: Record<string, string> = {
  "geist.woff2": geistPath, "inter.woff2": interPath,
  "noto-sans-sc.woff2": notoPath, "lxgw-wenkai.woff2": wenkaiPath,
};
const bundled = new Map<string, { path: string; min: number; max: number }>();
for (const match of fontsCss.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
  const family = match[1].match(/font-family:\s*"([^"]+)"/)?.[1];
  const filename = match[1].match(/url\("\.\.\/assets\/fonts\/([^"]+)"\)/)?.[1];
  const weights = match[1].match(/font-weight:\s*(\d+)(?:\s+(\d+))?\s*;/);
  if (family && filename && weights && bundledPaths[filename]) {
    bundled.set(key(family), { path: bundledPaths[filename], min: Number(weights[1]), max: Number(weights[2] ?? weights[1]) });
  }
}

async function systemFontPaths(signal: AbortSignal): Promise<string[]> {
  const options = { timeout: 12_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal };
  let paths: string[] = [];
  if (process.platform === "win32") {
    // Fixed script, no renderer input. Registry covers per-user installs and VF
    // files which older WPF/GDI family enumeration may not expose as typefaces.
    const script = `
      [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
      $roots = @('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts')
      $paths = foreach ($root in $roots) {
        if (Test-Path -LiteralPath $root) {
          $item = Get-Item -LiteralPath $root
          foreach ($name in $item.GetValueNames()) {
            $value = $item.GetValue($name)
            if ($value -is [string] -and $value) {
              if ([IO.Path]::IsPathRooted($value)) { $value }
              elseif ($root.StartsWith('HKCU:')) { Join-Path $env:LOCALAPPDATA ('Microsoft\\Windows\\Fonts\\' + $value) }
              else { Join-Path $env:WINDIR ('Fonts\\' + $value) }
            }
          }
        }
      }
      ConvertTo-Json -Compress -InputObject @($paths)
    `;
    try {
      const { stdout } = await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], options);
      const values: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ""));
      if (Array.isArray(values)) paths = values.filter((value): value is string => typeof value === "string");
    } catch {
      signal.throwIfAborted();
    }
    for (const directory of [process.env.WINDIR && join(process.env.WINDIR, "Fonts"), process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts")]) {
      if (!directory) continue;
      const localDirectory = localFontPath(directory);
      if (!localDirectory) continue;
      for (const entry of await readdir(localDirectory, { withFileTypes: true }).catch(() => [])) {
        if (entry.isFile()) paths.push(join(localDirectory, entry.name));
      }
    }
  } else if (process.platform === "linux") {
    const { stdout } = await run("fc-list", ["-f", "%{file}\n"], options);
    paths = stdout.split("\n");
  } else if (process.platform === "darwin") {
    try {
      const script = 'ObjC.import("CoreText"); const urls = ObjC.castRefToObject($.CTFontManagerCopyAvailableFontURLs()); const paths = []; for (let i = 0; i < urls.count; i++) paths.push(ObjC.unwrap(urls.objectAtIndex(i).absoluteString)); paths.join("\\n")';
      const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", script], options);
      paths = stdout.trim().split("\n").filter((line) => line.startsWith("file:")).map((line) => fileURLToPath(line));
    } catch {
      signal.throwIfAborted();
    }
    // Traversal is bounded and never follows directory symlinks.
    const directories = ["/System/Library/Fonts", "/Library/Fonts", join(homedir(), "Library/Fonts")];
    for (let i = 0; i < directories.length && i < 128; i++) {
      signal.throwIfAborted();
      for (const entry of await readdir(directories[i], { withFileTypes: true }).catch(() => [])) {
        const path = join(directories[i], entry.name);
        if (entry.isDirectory()) directories.push(path);
        else if (entry.isFile()) paths.push(path);
      }
    }
  }
  return [...new Set(paths.map((path) => localFontPath(path.trim())).filter((path): path is string =>
    path !== undefined && /\.(ttf|otf|ttc|otc|woff2)$/i.test(path),
  ))];
}

let systemIndex: { at: number; faces: Map<string, FontFaceMetadata[]> } | undefined;
let indexPending: Promise<Map<string, FontFaceMetadata[]>> | undefined;
async function loadSystemIndex(): Promise<Map<string, FontFaceMetadata[]>> {
  if (systemIndex && Date.now() - systemIndex.at < TTL) return systemIndex.faces;
  if (indexPending) return indexPending;
  indexPending = (async () => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("Font discovery timed out")); }, TIMEOUT);
    });
    const work = async () => {
      const paths = await systemFontPaths(controller.signal);
      if (paths.length > MAX_FILES) throw new Error("Too many font files");
      const faces = new Map<string, FontFaceMetadata[]>();
      let cursor = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (cursor < paths.length) {
          controller.signal.throwIfAborted();
          const path = paths[cursor++];
          const parsed = await readFontMetadata(path, controller.signal).catch(() => []);
          for (const { families, ...face } of parsed) {
            for (const family of families) {
              const name = key(family);
              const entries = faces.get(name) ?? [];
              if (entries.length < 256 && !entries.some((entry) => JSON.stringify(entry) === JSON.stringify(face))) entries.push(face);
              faces.set(name, entries);
            }
          }
        }
      }));
      return faces;
    };
    try {
      const faces = await Promise.race([work(), timeout]);
      systemIndex = { at: Date.now(), faces };
      return faces;
    } finally {
      clearTimeout(timer!);
      controller.abort();
    }
  })().finally(() => { indexPending = undefined; });
  return indexPending;
}

const cache = new Map<string, { at: number; metadata: FontMetadata }>();
const pending = new Map<string, Promise<FontMetadata>>();

/** Accepts only a family name; never accepts a path or passes input to a shell. */
export async function getFontMetadata(input: unknown): Promise<FontMetadata> {
  if (typeof input !== "string" || !input.trim() || input.length > 256 || /[\u0000-\u001f\u007f]/.test(input)) throw new Error("Invalid font family");
  const family = input.trim();
  const name = key(family);
  const stored = cache.get(name);
  if (stored && Date.now() - stored.at < TTL) return stored.metadata;
  const existing = pending.get(name);
  if (existing) return existing;
  if (pending.size >= 64) return { family, source: "system", status: "unavailable", faces: [] };
  const asset = bundled.get(name);
  const unavailable: FontMetadata = { family, source: asset ? "bundled" : "system", status: "unavailable", faces: [] };
  let timer: ReturnType<typeof setTimeout>;
  const work = async (): Promise<FontMetadata> => {
    let faces: FontFaceMetadata[] = [];
    try {
      if (asset) {
        const parsed = await readFontMetadata(asset.path, AbortSignal.timeout(TIMEOUT));
        faces = parsed.map(({ families: _families, ...face }) => {
          if (face.wght) {
            const min = Math.max(asset.min, face.wght.min);
            const max = Math.min(asset.max, face.wght.max);
            if (min > max) throw new Error("CSS and font weights disagree");
            const normal = Math.min(max, Math.max(min, face.wght.default));
            return { ...face, weight: normal, wght: { min, max, default: normal } };
          }
          if (face.weight < asset.min || face.weight > asset.max) throw new Error("CSS and font weights disagree");
          return face;
        });
      } else {
        faces = (await loadSystemIndex()).get(name) ?? [];
      }
    } catch {
      // Unknown metadata must never be presented as a fabricated static face.
    }
    return { ...unavailable, status: faces.length ? "known" : "unavailable", faces };
  };
  const task = Promise.race([
    work(),
    new Promise<FontMetadata>((resolve) => { timer = setTimeout(() => resolve(unavailable), TIMEOUT + 1000); }),
  ]).then((metadata) => {
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    cache.set(name, { at: Date.now(), metadata });
    return metadata;
  }).finally(() => { clearTimeout(timer!); pending.delete(name); });
  pending.set(name, task);
  return task;
}
