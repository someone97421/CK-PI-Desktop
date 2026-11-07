import { randomUUID } from "node:crypto";
import {
  createAssistantMessageEventStream,
  getCurrentTools,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type HostedSearchContent,
  type JsonObject,
  type TranscriptContext,
  type Model,
  type ProviderStreams,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import { googleRecord as record, prepareGoogleSearchReplay } from "./google-search-replay.js";
import { isThinkingOmitted } from "./thinking-level.js";

const GOOGLE_LEVELS = new Set(["minimal", "low", "medium", "high"]);
export const GOOGLE_SEARCH_TOOL_NAME = "GoogleSearch";

/** Keep saved bindings intact while using only levels understood by the Google adapter. */
export function googleThinkingModel<T extends Model<Api>>(model: T): T {
  if (model.api !== "google-generative-ai") return model;
  const thinkingLevelMap = { ...model.thinkingLevelMap };
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    const mapped = thinkingLevelMap[level];
    if (mapped === null) continue;
    if (typeof mapped === "string" && GOOGLE_LEVELS.has(mapped.toLowerCase())) continue;
    if (mapped !== undefined) {
      thinkingLevelMap[level] = level === "xhigh" || level === "max" ? "high" : level;
    }
  }
  const compat = { ...model.compat };
  if ("forceAdaptiveThinking" in compat) delete compat.forceAdaptiveThinking;
  return { ...model, thinkingLevelMap, compat };
}


/** Google SDK hooks preserve its native fetch, signatures and tool conversion. */
export function withGoogleNativeFeatures(adapter: ProviderStreams): ProviderStreams {
  function wrap(
    model: Model<Api>, context: TranscriptContext, options: StreamOptions | undefined,
    start: (context: TranscriptContext, options: StreamOptions) => AssistantMessageEventStream,
  ): AssistantMessageEventStream {
    const output = createAssistantMessageEventStream();
    const replay = prepareGoogleSearchReplay(model, context);
    const nativeSearch = model.webSearch === true &&
      !getCurrentTools(context.messages).some(tool => tool.name === GOOGLE_SEARCH_TOOL_NAME);
    const googleParts: JsonObject[] = [];
    let hasSearchResult = false;
    const queries = new Set<string>();
    const sources = new Map<string, { url: string; title?: string }>();
    const blockId = `google-search-${randomUUID()}`;
    let entryPoint: string | undefined;
    let revision = 0;
    let publishedRevision = 0;
    let lastMessage: AssistantMessage | undefined;
    const observe = (event: unknown) => {
      if (!nativeSearch) return;
      const candidates = record(event)?.candidates;
      const candidate = record(Array.isArray(candidates) ? candidates[0] : undefined);
      const parts = record(candidate?.content)?.parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          const data = record(part);
          if (!data) continue;
          googleParts.push(JSON.parse(JSON.stringify(data)) as JsonObject);
          if (data.toolCall || data.toolResponse) revision++;
        }
      }
      const metadata = record(candidate?.groundingMetadata);
      if (!metadata) return;
      const before = JSON.stringify([Array.from(queries), Array.from(sources.values()), entryPoint]);
      if (Array.isArray(metadata.webSearchQueries)) {
        for (const query of metadata.webSearchQueries) {
          if (typeof query === "string" && query.trim()) queries.add(query.trim());
        }
      }
      if (Array.isArray(metadata.groundingChunks)) {
        for (const chunk of metadata.groundingChunks) {
          const web = record(record(chunk)?.web);
          if (typeof web?.uri !== "string" || !/^https?:\/\//i.test(web.uri)) continue;
          const title = typeof web.title === "string" && web.title.trim() ? web.title.trim() : undefined;
          const previous = sources.get(web.uri);
          sources.set(web.uri, { url: web.uri, ...(title || previous?.title ? { title: title ?? previous?.title } : {}) });
        }
      }
      const rendered = record(metadata.searchEntryPoint)?.renderedContent;
      if (typeof rendered === "string" && rendered.trim()) entryPoint = rendered;
      if (JSON.stringify([Array.from(queries), Array.from(sources.values()), entryPoint]) !== before) revision++;
      if (queries.size || sources.size || entryPoint) hasSearchResult = true;
    };
    const decorate = (message: AssistantMessage): AssistantMessage => {
      if (!revision) return message;
      const block: HostedSearchContent = {
        type: "hostedSearch", phase: "web_search_call", blockId,
        status: hasSearchResult || message.stopReason === "stop" || message.stopReason === "toolUse"
          ? "completed" : message.stopReason === "error" || message.stopReason === "aborted" ? "failed" : "searching",
        wire: {
          type: "web_search_call", id: blockId, provider: "google",
          googleParts: [...googleParts],
          action: { type: "search", query: Array.from(queries).join("\n"), sources: Array.from(sources.values()) },
          ...(entryPoint ? { searchEntryPoint: entryPoint } : {}),
        },
      };
      const citations = new Map((message.hostedSearchCitations ?? []).map(source => [source.url, source]));
      for (const source of sources.values()) citations.set(source.url, source);
      return { ...message, content: [...message.content, block], hostedSearchCitations: Array.from(citations.values()) };
    };
    const requestOptions: StreamOptions = {
      ...options,
      onPayload: async (payload, requestModel) => {
        const current = replay.payload(payload);
        const params = record(current);
        if (!params) return (await options?.onPayload?.(current, requestModel)) ?? current;
        const config = { ...record(params.config) };
        // Omit leaves the level to the endpoint, but thought parts still need to be requested.
        if (model.reasoning && isThinkingOmitted(model)) config.thinkingConfig = { includeThoughts: true };
        if (nativeSearch) {
          const tools = Array.isArray(config.tools) ? config.tools : [];
          if (!tools.some(tool => record(tool)?.googleSearch !== undefined)) {
            config.tools = [...tools, { googleSearch: {} }];
          }
          if (tools.some(tool => Array.isArray(record(tool)?.functionDeclarations))) {
            config.toolConfig = { ...record(config.toolConfig), includeServerSideToolInvocations: true };
          }
        }
        const prepared = { ...params, config };
        return (await options?.onPayload?.(prepared, requestModel)) ?? prepared;
      },
      onProviderStreamEvent: async (event, requestModel) => {
        observe(event);
        if (lastMessage && revision !== publishedRevision) {
          publishedRevision = revision;
          const partial = decorate(lastMessage);
          output.push({ type: "hosted_search_update", contentIndex: partial.content.length - 1, partial });
        }
        await options?.onProviderStreamEvent?.(event, requestModel);
      },
    };
    void (async () => {
      try {
        for await (const event of start(replay.context, requestOptions)) {
          const raw = "partial" in event ? event.partial : event.type === "done" ? event.message : event.error;
          lastMessage = raw;
          const message = decorate(raw);
          if (revision !== publishedRevision) {
            publishedRevision = revision;
            output.push({ type: "hosted_search_update", contentIndex: message.content.length - 1, partial: message });
          }
          if ("partial" in event) output.push({ ...event, partial: message });
          else if (event.type === "done") output.push({ ...event, message });
          else output.push({ ...event, error: message });
        }
        output.end();
      } catch (error) {
        const reason = options?.signal?.aborted ? "aborted" : "error";
        const failed: AssistantMessage = decorate({
          role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          ...lastMessage,
          stopReason: reason, timestamp: Date.now(), errorMessage: error instanceof Error ? error.message : String(error),
        });
        output.push({ type: "error", reason, error: failed });
        output.end(failed);
      }
    })();
    return output;
  }
  return {
    ...adapter,
    stream(model, context, options) {
      if (model.api !== "google-generative-ai") return adapter.stream(model, context, options);
      const effective = googleThinkingModel(model);
      return wrap(effective, context, options, (nextContext, next) => adapter.stream(effective, nextContext, next));
    },
    streamSimple(model, context, options) {
      if (model.api !== "google-generative-ai") return adapter.streamSimple(model, context, options);
      const effective = googleThinkingModel(model);
      return wrap(effective, context, options, (nextContext, next) => adapter.streamSimple(effective, nextContext, { ...options, ...next }));
    },
  };
}
