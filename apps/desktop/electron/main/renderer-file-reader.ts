import { open } from "node:fs/promises";
import { basename } from "node:path";
import type { FsChatRefResolveResult } from "@pi-desktop/shared";

export type RendererFileRequest = { path: string; sessionId?: string };
export type RendererFileContent = { path: string; name: string; body: string };

export function createRendererFileReader(deps: {
  isRemote: (sessionId?: string) => Promise<boolean>;
  resolve: (input: RendererFileRequest) => Promise<FsChatRefResolveResult>;
}) {
  return async (input: RendererFileRequest): Promise<RendererFileContent> => {
    if (!input || typeof input.path !== "string" || !input.path.trim() || input.path.length > 32768 ||
        (input.sessionId !== undefined && (typeof input.sessionId !== "string" || !input.sessionId))) {
      throw Object.assign(new Error("文件路径或会话无效"), { code: "INVALID_PARAMS" });
    }
    if (await deps.isRemote(input.sessionId)) {
      throw Object.assign(new Error("此远程工作区尚不支持完整文件预览和下载"), { code: "UNSUPPORTED" });
    }
    const { match } = await deps.resolve(input);
    if (!match || match.target === "directory") {
      throw Object.assign(new Error("文件不存在或目标不是普通文件"), { code: "NOT_FOUND" });
    }
    const file = await open(match.absolutePath, "r");
    try {
      if (!(await file.stat()).isFile()) throw Object.assign(new Error("目标不是普通文件"), { code: "INVALID_PARAMS" });
      const body = (await file.readFile()).toString("base64");
      return { path: match.absolutePath, name: basename(match.absolutePath), body };
    } finally {
      await file.close();
    }
  };
}
