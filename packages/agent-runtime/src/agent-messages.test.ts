import { describe, expect, it } from "vitest";
import { toJsonObject, toJsonValue } from "./agent-messages.js";

describe("agent message JSON projections", () => {
  it("keeps JSON objects and rejects readonly arrays as object maps", () => {
    const values: readonly unknown[] = Object.freeze([{ nested: "value" }]);

    expect(toJsonObject({ details: values })).toEqual({ details: [{ nested: "value" }] });
    expect(toJsonObject(values)).toEqual({});
    expect(toJsonValue(values)).toEqual([{ nested: "value" }]);
  });
});
