import type { AgentTool } from "@earendil-works/pi-agent-core";
import { normalizeContext } from "@earendil-works/pi-ai";
import { hostedSearchFromMessage } from "@pi-desktop/shared";
import { Type } from "typebox";
import { classifyAgentError } from "./agent-errors.js";
import { GOOGLE_SEARCH_TOOL_NAME } from "./google-native-features.js";
import { buildProviderModel, createProviderModels, type RuntimeProviderConfig } from "./provider-binding.js";

export { GOOGLE_SEARCH_TOOL_NAME } from "./google-native-features.js";

/** A separate grounding request avoids gateways that cannot mix native and function tools. */
export function createGoogleSearchTool(provider: RuntimeProviderConfig): AgentTool | undefined {
  if (provider.extensionAgentKey || provider.modelConfig?.webSearch !== true) return undefined;
  const model = buildProviderModel(provider);
  if (model.api !== "google-generative-ai" || model.webSearch !== true) return undefined;
  const models = createProviderModels(provider, model);
  const failure = (cause: unknown, aborted: boolean) => {
    const error = classifyAgentError(cause);
    const message = provider.apiKey ? error.message.replaceAll(provider.apiKey, "[redacted]") : error.message;
    return {
      content: [{ type: "text" as const, text: aborted ? "Google Search 请求已取消或超时。" : `Google Search 请求失败：${message}` }],
      details: { errorCode: aborted ? "GOOGLE_SEARCH_ABORTED" : "GOOGLE_SEARCH_REQUEST_FAILED", causeCode: error.code, providerStatus: error.details?.providerStatus },
      isError: true,
    };
  };
  return {
    name: GOOGLE_SEARCH_TOOL_NAME,
    label: "Google Search",
    description: "Search the web through Google Search grounding using the current Gemini provider. Use for current information and source verification. Returns a grounded answer and source URLs.",
    parameters: Type.Object({
      query: Type.String({ description: "The question or search query to verify." }),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      const query = params && typeof params === "object" && "query" in params && typeof params.query === "string"
        ? params.query.trim() : "";
      if (!query) return {
        content: [{ type: "text", text: "GoogleSearch 需要非空的查询问题。" }],
        details: { errorCode: "GOOGLE_SEARCH_INVALID_QUERY" }, isError: true,
      };
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000);
      try {
        requestSignal.throwIfAborted();
        const result = await models.streamSimple(model, normalizeContext({
          messages: [{ role: "user", content: query, timestamp: Date.now() }],
        }), { signal: requestSignal, maxTokens: Math.min(model.maxTokens, 4096) }).result();
        const usage = result.usage;
        if (result.stopReason === "error" || result.stopReason === "aborted" || requestSignal.aborted) {
          const failed = failure(result, requestSignal.aborted || result.stopReason === "aborted");
          return { ...failed, details: { ...failed.details, usage } };
        }
        const search = hostedSearchFromMessage({ content: result.content, citations: result.hostedSearchCitations });
        const sources = [...new Map(search?.rounds.flatMap(round => round.sources ?? []).map(source => [source.url, source]) ?? []).values()];
        if (!sources.length) return {
          content: [{ type: "text", text: "提供商未返回可核验的 Google 搜索来源，本次检索未成功。" }],
          details: { errorCode: "GOOGLE_SEARCH_NOT_GROUNDED", usage }, isError: true,
        };
        const answer = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        const queries = search?.rounds.map(round => round.query).filter(Boolean) ?? [];
        const truncated = result.stopReason === "length";
        return {
          content: [{ type: "text", text: JSON.stringify({ answer, sources, queries, truncated }, null, 2) }],
          details: { sources, queries, truncated, usage },
        };
      } catch (error) {
        return failure(error, requestSignal.aborted);
      }
    },
  };
}
