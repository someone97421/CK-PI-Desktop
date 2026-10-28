import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { app } from "electron";
import { isAbsolute, join, resolve } from "node:path";

const execFileAsync = promisify(execFile);

export const TEMPORARY_WORKSPACE_ARGUMENT = "--temporary-workspace";
export const TEMPORARY_WORKSPACE_CONTEXT_MENU_SETTING = "temporaryWorkspaceContextMenu";
export const TEMPORARY_WORKSPACE_CONTEXT_MENU_KEY =
  "this-is-a-agent-temporary-workspace";
const TEMPORARY_WORKSPACE_LABEL = "在此处开启临时会话";

const REGISTRY_ROOT = "HKCU\\Software\\Classes";

type TemporaryWorkspaceSettings = {
  temporaryWorkspaceContextMenu?: unknown;
};

export type TemporaryWorkspaceRuntime = {
  enqueueFromCommandLine: (commandLine: readonly string[], additionalData?: unknown) => void;
  takePending: () => { workspacePaths: string[] };
  applyContextMenu: (settings?: TemporaryWorkspaceSettings | null) => Promise<void>;
};

type TemporaryWorkspaceRuntimeOptions = {
  onPending: (workspacePath: string) => void;
  log: (message: string, data?: unknown) => void;
};

function normalizeWorkspacePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("--")) return null;
  // Explorer supplies an absolute path. Resolving relative values keeps the
  // handoff deterministic for manual launches without changing normal input.
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(process.cwd(), trimmed);
}

export function parseTemporaryWorkspaceCommandLine(
  commandLine: readonly string[],
): string | null {
  for (let index = 0; index < commandLine.length; index += 1) {
    const argument = commandLine[index];
    if (argument === TEMPORARY_WORKSPACE_ARGUMENT) {
      return normalizeWorkspacePath(commandLine[index + 1]);
    }
    if (argument.startsWith(`${TEMPORARY_WORKSPACE_ARGUMENT}=`)) {
      return normalizeWorkspacePath(argument.slice(TEMPORARY_WORKSPACE_ARGUMENT.length + 1));
    }
  }
  return null;
}

function registryKey(scope: "Directory\\shell" | "Directory\\Background\\shell"): string {
  return `${REGISTRY_ROOT}\\${scope}\\${TEMPORARY_WORKSPACE_CONTEXT_MENU_KEY}`;
}

function quoteWindowsCommandArgument(value: string): string {
  return `"${value.replaceAll("\"", '\\\"')}"`;
}

async function runReg(args: string[]): Promise<void> {
  await execFileAsync("reg.exe", args, { windowsHide: true, windowsVerbatimArguments: false });
}

async function deleteRegistryKey(key: string): Promise<void> {
  const registryPath = key.replace(/^HKCU\\/, "Registry::HKEY_CURRENT_USER\\");
  const command = `$ErrorActionPreference = 'Stop'; $path = '${registryPath}'; if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true });
}

async function writeRegistryValue(key: string, name: string, value: string): Promise<void> {
  const valueName = name ? ["/v", name] : ["/ve"];
  await runReg(["ADD", key, ...valueName, "/t", "REG_SZ", "/d", value, "/f"]);
}

function contextMenuCommand(executablePath: string, workspaceToken: "%1" | "%V"): string {
  const executable = quoteWindowsCommandArgument(executablePath);
  // In development, Electron needs the app path as its first argument. Packaged
  // installers and portable builds launch the executable directly.
  const appArgument = app.isPackaged ? "" : ` ${quoteWindowsCommandArgument(app.getAppPath())}`;
  // 追加 \\. 避免盘符根目录的末尾反斜杠转义命令行闭引号。
  return `${executable}${appArgument} ${TEMPORARY_WORKSPACE_ARGUMENT}=${quoteWindowsCommandArgument(`${workspaceToken}\\.`)}`;
}

async function installContextMenu(log: TemporaryWorkspaceRuntimeOptions["log"]): Promise<void> {
  const executablePath = process.env.PORTABLE_EXECUTABLE_FILE?.trim() || process.execPath;
  const directoryKey = registryKey("Directory\\shell");
  const backgroundKey = registryKey("Directory\\Background\\shell");
  try {
    await writeRegistryValue(directoryKey, "MUIVerb", TEMPORARY_WORKSPACE_LABEL);
    await writeRegistryValue(directoryKey, "Icon", `${quoteWindowsCommandArgument(executablePath)},0`);
    await writeRegistryValue(
      `${directoryKey}\\command`,
      "",
      contextMenuCommand(executablePath, "%1"),
    );
    await writeRegistryValue(backgroundKey, "MUIVerb", TEMPORARY_WORKSPACE_LABEL);
    await writeRegistryValue(backgroundKey, "Icon", `${quoteWindowsCommandArgument(executablePath)},0`);
    await writeRegistryValue(
      `${backgroundKey}\\command`,
      "",
      contextMenuCommand(executablePath, "%V"),
    );
  } catch (error) {
    // Avoid leaving a half-written verb visible after a failed registry write.
    try {
      await deleteRegistryKey(directoryKey);
      await deleteRegistryKey(backgroundKey);
    } catch {
      // Preserve the original registration error for Settings.
    }
    log("Windows Explorer context menu registration failed", String(error));
    throw error;
  }
}

async function removeContextMenu(): Promise<void> {
  await Promise.all([
    deleteRegistryKey(registryKey("Directory\\shell")),
    deleteRegistryKey(registryKey("Directory\\Background\\shell")),
  ]);
}

// macOS：以 Finder 快速操作（Services workflow）提供同一入口，经 open -n 交给单实例通路。
const MAC_SERVICE_NAME = `${TEMPORARY_WORKSPACE_LABEL}.workflow`;

function macServicePath(): string {
  return join(homedir(), "Library", "Services", MAC_SERVICE_NAME);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function macLaunchCommand(): string {
  const argument = `${TEMPORARY_WORKSPACE_ARGUMENT}="$dir"`;
  if (app.isPackaged) {
    const bundle = resolve(process.execPath, "..", "..", "..");
    return `/usr/bin/open -n -a ${shellQuote(bundle)} --args ${argument}`;
  }
  return `${shellQuote(process.execPath)} ${shellQuote(app.getAppPath())} ${argument} >/dev/null 2>&1 &`;
}

export function macServiceScript(launchCommand: string): string {
  return [
    "for item in \"$@\"; do",
    "  if [ -d \"$item\" ]; then dir=\"$item\"; else dir=\"$(dirname \"$item\")\"; fi",
    `  ${launchCommand}`,
    "done",
  ].join("\n");
}

const PLIST_HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">`;

export function macServiceInfoPlist(): string {
  return `${PLIST_HEADER}
<dict>
\t<key>NSServices</key>
\t<array>
\t\t<dict>
\t\t\t<key>NSMenuItem</key>
\t\t\t<dict>
\t\t\t\t<key>default</key>
\t\t\t\t<string>${xmlEscape(TEMPORARY_WORKSPACE_LABEL)}</string>
\t\t\t</dict>
\t\t\t<key>NSMessage</key>
\t\t\t<string>runWorkflowAsService</string>
\t\t\t<key>NSRequiredContext</key>
\t\t\t<dict>
\t\t\t\t<key>NSApplicationIdentifier</key>
\t\t\t\t<string>com.apple.finder</string>
\t\t\t</dict>
\t\t\t<key>NSSendFileTypes</key>
\t\t\t<array>
\t\t\t\t<string>public.folder</string>
\t\t\t</array>
\t\t</dict>
\t</array>
</dict>
</plist>
`;
}

export function macServiceDocument(script: string): string {
  return `${PLIST_HEADER}
<dict>
\t<key>AMApplicationBuild</key>
\t<string>523</string>
\t<key>AMApplicationVersion</key>
\t<string>2.10</string>
\t<key>AMDocumentVersion</key>
\t<string>2</string>
\t<key>actions</key>
\t<array>
\t\t<dict>
\t\t\t<key>action</key>
\t\t\t<dict>
\t\t\t\t<key>AMAccepts</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>Container</key>
\t\t\t\t\t<string>List</string>
\t\t\t\t\t<key>Optional</key>
\t\t\t\t\t<true/>
\t\t\t\t\t<key>Types</key>
\t\t\t\t\t<array>
\t\t\t\t\t\t<string>com.apple.cocoa.string</string>
\t\t\t\t\t</array>
\t\t\t\t</dict>
\t\t\t\t<key>AMActionVersion</key>
\t\t\t\t<string>2.0.3</string>
\t\t\t\t<key>AMApplication</key>
\t\t\t\t<array>
\t\t\t\t\t<string>Automator</string>
\t\t\t\t</array>
\t\t\t\t<key>AMParameterProperties</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>COMMAND_STRING</key>
\t\t\t\t\t<dict/>
\t\t\t\t\t<key>CheckedForUserDefaultShell</key>
\t\t\t\t\t<dict/>
\t\t\t\t\t<key>inputMethod</key>
\t\t\t\t\t<dict/>
\t\t\t\t\t<key>shell</key>
\t\t\t\t\t<dict/>
\t\t\t\t\t<key>source</key>
\t\t\t\t\t<dict/>
\t\t\t\t</dict>
\t\t\t\t<key>AMProvides</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>Container</key>
\t\t\t\t\t<string>List</string>
\t\t\t\t\t<key>Types</key>
\t\t\t\t\t<array>
\t\t\t\t\t\t<string>com.apple.cocoa.string</string>
\t\t\t\t\t</array>
\t\t\t\t</dict>
\t\t\t\t<key>ActionBundlePath</key>
\t\t\t\t<string>/System/Library/Automator/Run Shell Script.action</string>
\t\t\t\t<key>ActionName</key>
\t\t\t\t<string>Run Shell Script</string>
\t\t\t\t<key>ActionParameters</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>COMMAND_STRING</key>
\t\t\t\t\t<string>${xmlEscape(script)}</string>
\t\t\t\t\t<key>CheckedForUserDefaultShell</key>
\t\t\t\t\t<true/>
\t\t\t\t\t<key>inputMethod</key>
\t\t\t\t\t<integer>1</integer>
\t\t\t\t\t<key>shell</key>
\t\t\t\t\t<string>/bin/bash</string>
\t\t\t\t\t<key>source</key>
\t\t\t\t\t<string></string>
\t\t\t\t</dict>
\t\t\t\t<key>BundleIdentifier</key>
\t\t\t\t<string>com.apple.RunShellScript</string>
\t\t\t\t<key>CFBundleVersion</key>
\t\t\t\t<string>2.0.3</string>
\t\t\t\t<key>CanShowSelectedItemsWhenRun</key>
\t\t\t\t<false/>
\t\t\t\t<key>CanShowWhenRun</key>
\t\t\t\t<true/>
\t\t\t\t<key>Category</key>
\t\t\t\t<array>
\t\t\t\t\t<string>AMCategoryUtilities</string>
\t\t\t\t</array>
\t\t\t\t<key>Class Name</key>
\t\t\t\t<string>RunShellScriptAction</string>
\t\t\t\t<key>InputUUID</key>
\t\t\t\t<string>8E1A5A3C-6B0D-4C55-9C0E-2F3B7A1D4E01</string>
\t\t\t\t<key>OutputUUID</key>
\t\t\t\t<string>8E1A5A3C-6B0D-4C55-9C0E-2F3B7A1D4E02</string>
\t\t\t\t<key>UUID</key>
\t\t\t\t<string>8E1A5A3C-6B0D-4C55-9C0E-2F3B7A1D4E03</string>
\t\t\t\t<key>UnlocalizedApplications</key>
\t\t\t\t<array>
\t\t\t\t\t<string>Automator</string>
\t\t\t\t</array>
\t\t\t\t<key>isViewVisible</key>
\t\t\t\t<true/>
\t\t\t</dict>
\t\t\t<key>isViewVisible</key>
\t\t\t<true/>
\t\t</dict>
\t</array>
\t<key>connectors</key>
\t<dict/>
\t<key>workflowMetaData</key>
\t<dict>
\t\t<key>serviceApplicationBundleID</key>
\t\t<string>com.apple.finder</string>
\t\t<key>serviceInputTypeIdentifier</key>
\t\t<string>com.apple.Automator.fileSystemObject.folder</string>
\t\t<key>serviceOutputTypeIdentifier</key>
\t\t<string>com.apple.Automator.nothing</string>
\t\t<key>serviceProcessesInput</key>
\t\t<integer>0</integer>
\t\t<key>workflowTypeIdentifier</key>
\t\t<string>com.apple.Automator.servicesMenu</string>
\t</dict>
</dict>
</plist>
`;
}

async function refreshMacServices(): Promise<void> {
  await execFileAsync("/System/Library/CoreServices/pbs", ["-update"]).catch(() => undefined);
}

async function writeIfChanged(path: string, content: string): Promise<boolean> {
  const current = await readFile(path, "utf8").catch(() => null);
  if (current === content) return false;
  await writeFile(path, content, "utf8");
  return true;
}

async function installMacService(log: TemporaryWorkspaceRuntimeOptions["log"]): Promise<void> {
  const contents = join(macServicePath(), "Contents");
  try {
    await mkdir(contents, { recursive: true });
    const infoChanged = await writeIfChanged(join(contents, "Info.plist"), macServiceInfoPlist());
    const documentChanged = await writeIfChanged(
      join(contents, "document.wflow"),
      macServiceDocument(macServiceScript(macLaunchCommand())),
    );
    if (infoChanged || documentChanged) await refreshMacServices();
  } catch (error) {
    await rm(macServicePath(), { recursive: true, force: true }).catch(() => undefined);
    log("macOS Finder quick action registration failed", String(error));
    throw error;
  }
}

async function removeMacService(): Promise<void> {
  const path = macServicePath();
  const existed = await readFile(join(path, "Contents", "Info.plist"), "utf8").then(() => true, () => false);
  await rm(path, { recursive: true, force: true });
  if (existed) await refreshMacServices();
}

export function createTemporaryWorkspaceRuntime({
  onPending,
  log,
}: TemporaryWorkspaceRuntimeOptions): TemporaryWorkspaceRuntime {
  const pending: string[] = [];
  let rendererReady = false;
  let contextMenuOperation: Promise<void> = Promise.resolve();

  const enqueueFromCommandLine = (commandLine: readonly string[], additionalData?: unknown) => {
    const suppliedPath = additionalData && typeof additionalData === "object"
      ? (additionalData as { temporaryWorkspacePath?: unknown }).temporaryWorkspacePath
      : undefined;
    const workspacePath = normalizeWorkspacePath(suppliedPath)
      ?? parseTemporaryWorkspaceCommandLine(commandLine);
    if (!workspacePath) return;
    pending.push(workspacePath);
    if (rendererReady) onPending(workspacePath);
  };

  const takePending = () => {
    rendererReady = true;
    const workspacePaths = [...pending];
    pending.length = 0;
    return { workspacePaths };
  };

  const applyContextMenu = async (
    settings?: TemporaryWorkspaceSettings | null,
  ): Promise<void> => {
    if (process.platform !== "win32" && process.platform !== "darwin") return;
    const enabled = settings?.temporaryWorkspaceContextMenu !== false;
    contextMenuOperation = contextMenuOperation.catch(() => undefined).then(async () => {
      if (process.platform === "darwin") {
        if (enabled) await installMacService(log);
        else await removeMacService();
      } else if (enabled) await installContextMenu(log);
      else await removeContextMenu();
    });
    await contextMenuOperation;
  };

  return { enqueueFromCommandLine, takePending, applyContextMenu };
}

export function initialTemporaryWorkspaceCommandLine(): string | null {
  return parseTemporaryWorkspaceCommandLine(process.argv);
}
