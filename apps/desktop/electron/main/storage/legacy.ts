import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { APP_SLUG } from "@pi-desktop/shared";

export function dataDirectoryConfigPath(appData: string): string {
  return join(appData, APP_SLUG, "data-directory.json");
}
/** 仅在尚无 storage-location.json 时读取旧 fork 的目录指针，不移动现有数据。 */
export function readConfiguredDataDirectory(appData: string): string | undefined {
  let text: string;
  try { text = readFileSync(dataDirectoryConfigPath(appData), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const config = JSON.parse(text) as { dataDir?: unknown };
  if (!config || typeof config.dataDir !== "string" || !isAbsolute(config.dataDir)) {
    throw new Error("数据存储位置配置无效，请检查 data-directory.json");
  }
  if (!statSync(config.dataDir).isDirectory()) throw new Error(`数据存储位置不是目录：${config.dataDir}`);
  return config.dataDir;
}
