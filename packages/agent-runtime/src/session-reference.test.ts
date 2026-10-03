import { describe, expect, it } from "vitest";
import { sessionReferenceBlock } from "./runtime.js";

describe("session reference blocks", () => {
  it("quotes a referenced conversation with its identity", () => {
    const block = sessionReferenceBlock({
      path: "6f1d2c3b-4a59-4e7f-8a90-b1c2d3e4f506",
      name: "Nightly dependency check",
      kind: "session",
      text: "user: check the lockfile\nassistant: two advisories",
    });
    expect(block).toContain('name="Nightly dependency check"');
    expect(block).toContain('session="6f1d2c3b-4a59-4e7f-8a90-b1c2d3e4f506"');
    expect(block).toContain("user: check the lockfile");
    expect(block?.endsWith("</session_reference>")).toBe(true);
  });

  it("escapes a title that would break the block", () => {
    const block = sessionReferenceBlock({
      path: "abc",
      name: 'a "quoted" <title>',
      kind: "session",
      text: "user: hi",
    });
    expect(block).toContain('name="a &quot;quoted&quot; &lt;title&gt;"');
    expect(block?.startsWith('<session_reference name="')).toBe(true);
  });

  it("ignores every other attachment kind and empty text", () => {
    expect(sessionReferenceBlock({ path: "a.ts", name: "a.ts", kind: "file" })).toBeNull();
    expect(sessionReferenceBlock({ path: "pic.png", name: "pic.png", kind: "image", data: "x" })).toBeNull();
    expect(sessionReferenceBlock({ path: "abc", name: "Empty", kind: "session", text: "   " })).toBeNull();
  });
});
