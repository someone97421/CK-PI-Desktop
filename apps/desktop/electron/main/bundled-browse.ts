import { statSync } from "node:fs";
import { join } from "node:path";
import { getModuleDirectory } from "./module-path.ts";

export function bundledBrowseExecutable(): string {
  const executable = process.platform === "win32" ? "browse.exe" : "browse";
  const development = join(getModuleDirectory(import.meta.url), "../../resources/browse", executable);
  const packaged = process.resourcesPath ? join(process.resourcesPath, "browse", executable) : undefined;
  const candidates = process.defaultApp || !packaged ? [development] : [packaged, development];
  return candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  }) ?? candidates[0]!;
}
