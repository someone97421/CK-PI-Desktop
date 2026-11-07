import { randomUUID } from "node:crypto";
import type { Api, JsonObject, Model, TranscriptContext } from "@earendil-works/pi-ai";

export function googleRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Keep server tool parts and signatures in their original order for the same model. */
export function prepareGoogleSearchReplay(model: Model<Api>, context: TranscriptContext): {
  context: TranscriptContext;
  payload(payload: unknown): unknown;
} {
  const replays = new Map<string, JsonObject[]>();
  const messages = context.messages.map(message => {
    if (message.role !== "assistant" || message.api !== model.api ||
      message.provider !== model.provider || message.model !== model.id) return message;
    const block = message.content.find(part => part.type === "hostedSearch" &&
      part.phase === "web_search_call" && part.wire?.provider === "google");
    const parts = block?.type === "hostedSearch" && block.phase === "web_search_call"
      ? block.wire?.googleParts : undefined;
    if (!Array.isArray(parts) || !parts.length || !parts.every(part => googleRecord(part))) return message;
    const marker = `google-replay:${randomUUID()}`;
    replays.set(marker, parts as JsonObject[]);
    return { ...message, content: [...message.content, { type: "text" as const, text: marker }] };
  });
  return {
    context: { ...context, messages },
    payload(payload: unknown) {
      const params = googleRecord(payload);
      if (!params || !Array.isArray(params.contents) || !replays.size) return payload;
      return { ...params, contents: params.contents.map(content => {
        const item = googleRecord(content);
        if (item?.role !== "model" || !Array.isArray(item.parts)) return content;
        for (const part of item.parts) {
          const text = googleRecord(part)?.text;
          const original = typeof text === "string" ? replays.get(text) : undefined;
          if (original) {
            const calls = item.parts.map(value => googleRecord(googleRecord(value)?.functionCall)).filter(Boolean);
            let callIndex = 0;
            const parts = original.map(value => {
              const call = googleRecord(value.functionCall);
              if (!call) return value;
              const converted = calls[callIndex++];
              return converted?.id ? { ...value, functionCall: { ...call, id: converted.id } } : value;
            });
            return { ...item, parts };
          }
        }
        return content;
      }) };
    },
  };
}
