import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { app } from "electron";
import { isAbsolute, resolve } from "node:path";

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
    if (process.platform !== "win32") return;
    const enabled = settings?.temporaryWorkspaceContextMenu === true;
    contextMenuOperation = contextMenuOperation.catch(() => undefined).then(async () => {
      if (enabled) await installContextMenu(log);
      else await removeContextMenu();
    });
    await contextMenuOperation;
  };

  return { enqueueFromCommandLine, takePending, applyContextMenu };
}

export function initialTemporaryWorkspaceCommandLine(): string | null {
  return parseTemporaryWorkspaceCommandLine(process.argv);
}
