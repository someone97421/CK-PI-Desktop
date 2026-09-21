import { describe, expect, it } from "vitest";
import { isPluginInlineNode, validateManifest } from "./index.js";

const base = { schemaVersion: 1, id: "demo.inline", name: "内嵌视图", version: "1.0.0", main: "main.js" };

describe("内嵌视图贡献协议", () => {
  it("接受原位置的贡献声明，拒绝重复 ID 和未支持的位置", () => {
    const view = { id: "supervision", slot: "subagent.supervision" };
    expect(validateManifest({ ...base, contributes: { inlineViews: [view] } }).ok).toBe(true);
    expect(validateManifest({ ...base, contributes: { inlineViews: [view, view] } }).ok).toBe(false);
    expect(validateManifest({ ...base, contributes: { inlineViews: [{ ...view, slot: "window" }] } }).ok).toBe(false);
    expect(validateManifest({ ...base, contributes: { inlineViews: {} } }).ok).toBe(false);
  });

  it("接受纯文本和声明式动作，不接受可执行标签或错误属性类型", () => {
    expect(isPluginInlineNode(null)).toBe(true);
    expect(isPluginInlineNode({ kind: "column", children: [
      { kind: "text", text: "<script>只作为文字</script>" },
      { kind: "action", text: "停止", action: "stop", icon: "stop", disabled: false },
    ] })).toBe(true);
    expect(isPluginInlineNode({ kind: "script", text: "alert(1)" })).toBe(false);
    expect(isPluginInlineNode({ kind: "action", text: "停止" })).toBe(false);
    expect(isPluginInlineNode({ kind: "text", text: { html: "内容" } })).toBe(false);
    expect(isPluginInlineNode({ kind: "column", children: "错误" })).toBe(false);
  });
});
