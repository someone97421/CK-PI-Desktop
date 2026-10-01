import { Type } from "@earendil-works/pi-ai";

export const todoWriteDescription =
  "Replace the current session's task checklist in display order. Use it to track multi-step implementation work. Keep items concise and statuses accurate, with at most one item in_progress. The host truncates content beyond 500 Unicode characters with a warning.";

export const todoWriteParameters = {
  todos: Type.Array(
    Type.Object({
      // The host owns normalization and reports any truncation to the model.
      content: Type.String({ minLength: 1 }),
      status: Type.Union([
        Type.Literal("pending"),
        Type.Literal("in_progress"),
        Type.Literal("completed"),
        Type.Literal("cancelled"),
      ]),
      priority: Type.Optional(
        Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
      ),
    }),
    { maxItems: 50 },
  ),
};
