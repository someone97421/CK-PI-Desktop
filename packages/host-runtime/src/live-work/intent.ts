export type LiveWorkIntent =
  | { kind: "conversation" }
  | { kind: "clarify"; question: string }
  | { kind: "new-task"; relationToActive: "independent" | "unspecified"; explicitRepeat: boolean }
  | { kind: "steer-current" }
  | { kind: "queue-task" }
  | { kind: "query-status"; operationRef?: string }
  | { kind: "query-result"; operationRef?: string }
  | { kind: "query-queue" }
  | { kind: "stop-current"; urgency: "graceful" | "immediate" }
  | { kind: "cancel-queued"; operationRef: string }
  | { kind: "list-projects"; query?: string }
  | { kind: "list-sessions"; query?: string }
  | { kind: "open-session"; selectionRef: string }
  | { kind: "create-session"; projectRef?: string; title?: string }
  | { kind: "speech-only"; automaticAnnouncements: "normal" | "silent" };

const MAX_SHORT_TEXT_BYTES = 512;

/** Strict runtime validator for one-shot model output. Unknown fields fail closed. */
export function parseLiveWorkIntent(value: unknown): LiveWorkIntent | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  const keys = Object.keys(value);
  const exact = (allowed: string[]) => keys.every((key) => allowed.includes(key));
  const shortText = (item: unknown): item is string =>
    typeof item === "string" && item.trim().length > 0 && new TextEncoder().encode(item).byteLength <= MAX_SHORT_TEXT_BYTES;

  switch (value.kind) {
    case "conversation":
    case "query-queue":
    case "steer-current":
      return exact(["kind"]) ? { kind: value.kind } : null;
    case "clarify":
      return exact(["kind", "question"]) && shortText(value.question) ? { kind: "clarify", question: value.question.trim() } : null;
    case "new-task":
      return exact(["kind", "relationToActive", "explicitRepeat"]) &&
        (value.relationToActive === "independent" || value.relationToActive === "unspecified") &&
        typeof value.explicitRepeat === "boolean"
        ? { kind: "new-task", relationToActive: value.relationToActive, explicitRepeat: value.explicitRepeat }
        : null;
    case "queue-task":
      return exact(["kind"]) ? { kind: "queue-task" } : null;
    case "query-status":
    case "query-result":
      return exact(["kind", "operationRef"]) && (value.operationRef === undefined || shortText(value.operationRef))
        ? { kind: value.kind, ...(typeof value.operationRef === "string" ? { operationRef: value.operationRef.trim() } : {}) }
        : null;
    case "stop-current":
      return exact(["kind", "urgency"]) && (value.urgency === "graceful" || value.urgency === "immediate")
        ? { kind: "stop-current", urgency: value.urgency }
        : null;
    case "cancel-queued":
      return exact(["kind", "operationRef"]) && shortText(value.operationRef)
        ? { kind: "cancel-queued", operationRef: value.operationRef.trim() }
        : null;
    case "list-projects":
    case "list-sessions":
      return exact(["kind", "query"]) && (value.query === undefined || shortText(value.query))
        ? { kind: value.kind, ...(typeof value.query === "string" ? { query: value.query.trim() } : {}) }
        : null;
    case "open-session":
      return exact(["kind", "selectionRef"]) && shortText(value.selectionRef)
        ? { kind: "open-session", selectionRef: value.selectionRef.trim() }
        : null;
    case "create-session":
      return exact(["kind", "projectRef", "title"]) &&
        (value.projectRef === undefined || shortText(value.projectRef)) &&
        (value.title === undefined || shortText(value.title))
        ? {
            kind: "create-session",
            ...(typeof value.projectRef === "string" ? { projectRef: value.projectRef.trim() } : {}),
            ...(typeof value.title === "string" ? { title: value.title.trim() } : {}),
          }
        : null;
    case "speech-only":
      return exact(["kind", "automaticAnnouncements"]) &&
        (value.automaticAnnouncements === "normal" || value.automaticAnnouncements === "silent")
        ? { kind: "speech-only", automaticAnnouncements: value.automaticAnnouncements }
        : null;
    default:
      return null;
  }
}

export const LIVE_WORK_INTENT_SCHEMA = {
  oneOf: [
    { type: "object", properties: { kind: { const: "conversation" } }, required: ["kind"], additionalProperties: false },
    { type: "object", properties: { kind: { const: "clarify" }, question: { type: "string", maxLength: 512 } }, required: ["kind", "question"], additionalProperties: false },
    { type: "object", properties: { kind: { const: "new-task" }, relationToActive: { enum: ["independent", "unspecified"] }, explicitRepeat: { type: "boolean" } }, required: ["kind", "relationToActive", "explicitRepeat"], additionalProperties: false },
    { type: "object", properties: { kind: { const: "steer-current" } }, required: ["kind"], additionalProperties: false },
    { type: "object", properties: { kind: { const: "queue-task" } }, required: ["kind"], additionalProperties: false },
    { type: "object", properties: { kind: { enum: ["query-status", "query-result"] }, operationRef: { type: "string", maxLength: 512 } }, required: ["kind"], additionalProperties: false },
    { type: "object", properties: { kind: { const: "query-queue" } }, required: ["kind"], additionalProperties: false },
    { type: "object", properties: { kind: { const: "stop-current" }, urgency: { enum: ["graceful", "immediate"] } }, required: ["kind", "urgency"], additionalProperties: false },
    { type: "object", properties: { kind: { const: "cancel-queued" }, operationRef: { type: "string", maxLength: 512 } }, required: ["kind", "operationRef"], additionalProperties: false },
    { type: "object", properties: { kind: { enum: ["list-projects", "list-sessions"] }, query: { type: "string", maxLength: 512 } }, required: ["kind"], additionalProperties: false },
    { type: "object", properties: { kind: { const: "open-session" }, selectionRef: { type: "string", maxLength: 512 } }, required: ["kind", "selectionRef"], additionalProperties: false },
    { type: "object", properties: { kind: { const: "create-session" }, projectRef: { type: "string", maxLength: 512 }, title: { type: "string", maxLength: 512 } }, required: ["kind"], additionalProperties: false },
    { type: "object", properties: { kind: { const: "speech-only" }, automaticAnnouncements: { enum: ["normal", "silent"] } }, required: ["kind", "automaticAnnouncements"], additionalProperties: false },
  ],
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
