import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { ErrorCodes, FILE_LINES_ADD_CHANNEL, IPC, parseFileLineReference, normalizeProjectPath } from "@pi-desktop/shared";
import { canUseFileLineView, fileLinePathInProject } from "./file-line-reference";
import type { HostProcess } from "./host-process";
import type { PluginPanelHost } from "./plugin-panel-host";
import type { PluginRuntime } from "./plugin-runtime";
import { resolveSessionWorkspace } from "./runtime/session-workspace";

const types = new Map([
  [".html", "text/html; charset=utf-8"], [".htm", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"], [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"], [".json", "application/json"], [".wasm", "application/wasm"],
  [".svg", "image/svg+xml"], [".png", "image/png"], [".jpeg", "image/jpeg"], [".jpg", "image/jpeg"],
  [".gif", "image/gif"], [".webp", "image/webp"], [".ico", "image/x-icon"], [".avif", "image/avif"],
  [".woff", "font/woff"], [".woff2", "font/woff2"], [".ttf", "font/ttf"], [".otf", "font/otf"],
]);

function unavailable(): never {
  throw Object.assign(new Error("Plugin view or asset is unavailable"), { errorCode: ErrorCodes.NOT_FOUND });
}

function safePath(path: unknown): path is string {
  return typeof path === "string" && path.length <= 4096 && !/[\\:\0?#]/.test(path) &&
    path.split("/").every((part) => part && !part.startsWith(".") && !/[. ]$/.test(part));
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !/^\.\.[/\\]/.test(child) && !isAbsolute(child);
}

function isBackendPath(path: string): boolean {
  return path.split("/").some((part) => /^(?:node_modules|(?:server|backend|private|secrets)(?:\.[^.]+)?|manifest\.json|package(?:-lock)?\.json)$/i.test(part));
}

const rootAssetDirectories = new Set(["assets", "static"]);

function entryReferencesAsset(html: string, requested: string): boolean {
  const tags = /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes)(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>[\s\S]*?(?:<\/\1\s*>|$)|<([a-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  const extension = extname(requested).toLowerCase();
  for (const [, rawTag, rawAttrs, tag, attrs] of html.matchAll(tags)) {
    const name = (rawTag ?? tag)?.toLowerCase();
    if (name !== "script" && name !== "link") continue;
    const attributes = new Map<string, string>();
    for (const [, key, quoted, singleQuoted, bare] of (rawAttrs ?? attrs).matchAll(/([^\s/=<>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      if (!attributes.has(key.toLowerCase())) attributes.set(key.toLowerCase(), quoted ?? singleQuoted ?? bare ?? "");
    }
    const rel = attributes.get("rel")?.toLowerCase().split(/\s+/) ?? [];
    const preloadKind = rel.includes("preload") ? attributes.get("as")?.toLowerCase() : undefined;
    const script = name === "script" || rel.includes("modulepreload") || preloadKind === "script";
    const style = name === "link" && (rel.includes("stylesheet") || preloadKind === "style");
    if (!(script && (extension === ".js" || extension === ".mjs")) && !(style && extension === ".css")) continue;
    const url = attributes.get(name === "script" ? "src" : "href");
    if (!url) continue;
    const pathname = url.trim().split(/[?#]/, 1)[0].replace(/^(?:\.\/)+/, "");
    try {
      const segments = pathname.split("/").map(decodeURIComponent);
      if (segments.every((segment) => safePath(segment) && !segment.includes("/")) && segments.join("/") === requested) return true;
    } catch {
      // Invalid URL escapes cannot match an asset path.
    }
  }
  return false;
}

async function viewAsset(root: string, entry: string, requested: unknown, main: string) {
  if (!safePath(entry) || !safePath(requested) || isBackendPath(requested)) unavailable();
  const contentType = types.get(extname(requested).toLowerCase());
  if (!contentType) unavailable();
  try {
    const pluginRoot = await realpath(root);
    const entryFile = resolve(pluginRoot, entry);
    const assetRoot = dirname(entryFile);
    const file = resolve(pluginRoot, requested);
    if (file !== entryFile) {
      if (!inside(assetRoot, file)) unavailable();
      if (assetRoot === pluginRoot && !rootAssetDirectories.has(requested.split("/", 1)[0])) {
        const html = await readFile(entryFile, "utf8");
        if (!entryReferencesAsset(html, requested)) unavailable();
      }
    }
    const canonical = await realpath(file);
    if (!inside(pluginRoot, canonical) || relative(file, canonical) !== "" ||
      relative(canonical, resolve(pluginRoot, main)) === "" ||
      (file !== entryFile && !inside(assetRoot, canonical)) || !(await stat(canonical)).isFile()) unavailable();
    return { path: canonical, contentType };
  } catch {
    return unavailable();
  }
}

export async function remotePluginViewSession(host: HostProcess, sessionId: string) {
  if (typeof sessionId !== "string" || !sessionId || sessionId.startsWith("remote:")) unavailable();
  const result = await host.call<{ session?: {
    projectPath?: string | null; remoteWorkspace?: unknown; temporaryWorkspacePath?: string | null; worktree?: unknown;
  } }>(
    "session.get", { id: sessionId, messageLimit: 1, contentLimit: 1 },
  );
  const session = result.session;
  if (!session || session.remoteWorkspace || session.projectPath?.startsWith("remote-project:")) unavailable();
  return session;
}

export function createRemotePluginViewHandler({ plugins, pluginPanels, getHost, pluginActiveInProject }: {
  plugins: PluginRuntime;
  pluginPanels: PluginPanelHost;
  getHost: () => HostProcess | null;
  pluginActiveInProject: (pluginId: string, projectPath: string | null) => boolean;
}) {
  return async (request: unknown) => {
    const { op, pluginId, viewId, sessionId, path, channel, payload } = (request ?? {}) as Record<string, unknown>;
    if ((op !== "open" && op !== "asset" && op !== "invoke") ||
      typeof pluginId !== "string" || typeof viewId !== "string" ||
      typeof sessionId !== "string") unavailable();
    const host = getHost();
    if (!host) throw Object.assign(new Error("Host unavailable"), { errorCode: ErrorCodes.HOST_UNAVAILABLE });
    const session = await remotePluginViewSession(host, sessionId);
    const projectPath = session.projectPath ?? null;
    const loaded = plugins.getLoaded(pluginId);
    const view = loaded?.manifest.contributes?.views?.find((item) => item.id === viewId);
    const check = () => {
      if (!loaded || plugins.getLoaded(pluginId) !== loaded || loaded.disposing || !loaded.permissions.has("ui.view") ||
        getHost() !== host || !pluginActiveInProject(pluginId, projectPath)) unavailable();
    };
    if (!loaded || !view || !/\.html?$/i.test(view.entry)) unavailable();
    check();
    const entry = await viewAsset(loaded.path, view.entry, view.entry, loaded.manifest.main);
    check();
    const composerFileLines = pluginId === "pi.file-manager" && viewId === "manager" && !!projectPath && canUseFileLineView(loaded);
    if (op === "open") return { entry: view.entry, capabilities: { composerFileLines } };
    if (op === "asset") {
      const asset = path === view.entry ? entry : await viewAsset(loaded.path, view.entry, path, loaded.manifest.main);
      const body = (await readFile(asset.path)).toString("base64");
      check();
      return { contentType: asset.contentType, body };
    }
    if (typeof channel !== "string" || !channel || channel.length > 160) unavailable();
    const workspace = await resolveSessionWorkspace(host, sessionId, session);
    if (!isAbsolute(workspace.path)) unavailable();
    check();
    if (channel === FILE_LINES_ADD_CHANNEL) {
      const reference = parseFileLineReference(payload);
      if (!composerFileLines || !reference ||
        !projectPath || normalizeProjectPath(reference.workspace) !== normalizeProjectPath(workspace.path) ||
        !fileLinePathInProject(reference.path, workspace.path)) unavailable();
      return { ok: true, reference };
    }
    return pluginPanels.invokeRemoteView(pluginId, channel, payload, {
      sessionId, projectPath, workspacePath: workspace.path,
    });
  };
}

export function publishRemotePluginViewEvent(
  plugins: Pick<PluginRuntime, "publishIpcEvent">,
  pluginId: string,
  event: string,
  payload: unknown,
  sessionId?: string,
  viewId?: string,
): void {
  plugins.publishIpcEvent(IPC.event.remotePluginViewEvent, {
    pluginId, event, payload, ...(sessionId ? { sessionId } : {}), ...(viewId ? { viewId } : {}),
  });
}
