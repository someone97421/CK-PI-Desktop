import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getModuleDirectory } from "./module-path";

/** 文档随应用打包，只有可读取的会话副本路径进入主代理上下文。 */
export async function prepareConfigurationGuide(input: {
  scratchDir: string;
  dataDir: string;
  projectPath?: string;
  workspaceRoot: string;
}): Promise<string> {
  const moduleDir = getModuleDirectory(import.meta.url);
  const fileName = "configuration.md";
  const candidates = [
    join(process.resourcesPath || "", "agent-docs", fileName),
    join(moduleDir, "../../resources/agent-docs", fileName),
    join(moduleDir, "../../../resources/agent-docs", fileName),
  ];
  const sourcePath = candidates.find((candidate) => existsSync(candidate));
  if (!sourcePath) throw new Error("缺少内置配置参考文档");
  const source = await readFile(sourcePath, "utf8");
  const agentsRoot = resolve(process.env.PI_DESKTOP_AGENTS_DIR?.trim() || join(homedir(), ".agents"));
  const paths = [
    ["全局指令文件", join(homedir(), ".pi", "agent", "AGENTS.md")],
    ["全局能力目录", agentsRoot],
    ["项目配置根目录", input.projectPath || "无（仅加载全局配置）"],
    ["实际工作目录", input.workspaceRoot],
    ["业务数据目录", input.dataDir],
  ];
  const context = [
    "## 本次会话路径",
    "",
    ...paths.map(([label, path]) => `- ${label}：\`${path}\``),
    "",
  ].join("\n");
  const content = `${context}\n${source}`;
  const directory = join(input.scratchDir, "pi-desktop-reference");
  const target = join(directory, fileName);
  await mkdir(directory, { recursive: true });
  // 被临时文件清理后自动重建；内容相同时不重写，保持会话副本稳定。
  const previous = await readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (previous !== content) await writeFile(target, content, "utf8");
  return target;
}
