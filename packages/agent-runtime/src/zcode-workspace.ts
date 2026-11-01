import { Buffer } from "node:buffer";
import type { RuntimeProviderConfig } from "./provider-binding.js";

export type ZcodeWorkspaceContext = { sessionId: string; workspacePath?: string; remote?: boolean };

export function zcodeWorkspaceProvider(
  provider: RuntimeProviderConfig,
  context: ZcodeWorkspaceContext,
): RuntimeProviderConfig {
  if (provider.id !== "plugin:local.zcode-pool:zcode-start-plan") return provider;
  const endpoint = new URL(provider.baseUrl ?? "");
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
    throw new Error("ZCode Pool 工作目录仅支持本机桥接端点");
  }
  if (context.remote) throw new Error("ZCode Pool 暂不支持远程项目工作目录");
  if (!context.workspacePath || !context.sessionId) throw new Error("ZCode Pool 缺少会话工作目录");
  const value = Buffer.from(JSON.stringify({
    version: 1,
    sessionId: context.sessionId,
    path: context.workspacePath,
  }), "utf8").toString("base64url");
  return {
    ...provider,
    headers: {
      ...provider.headers,
      "x-pi-zcode-workspace": value,
    },
  };
}
