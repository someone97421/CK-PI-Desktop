/**
 * Test for applySubagentPreset - the helper the editor relies on for
 * preset/template application (issue #60). Model-pin mapping is covered by the
 * dedicated subagent-models tests.
 *
 * We test by re-implementing the same logic against the source string so this
 * stays a source-contract test (no React, no Node imports of the .tsx file).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const editorSource = await readFile(
  new URL("../src/components/settings/SubagentEditorSheet.tsx", import.meta.url),
  "utf8",
);
const presetSource = await readFile(
  new URL("../../../packages/shared/src/subagent-presets.ts", import.meta.url),
  "utf8",
);

test("applySubagentPreset replaces only the template-owned fields", () => {
  const m = editorSource.match(
    /export function applySubagentPreset\([\s\S]+?\n\}/,
  );
  assert.ok(m, "applySubagentPreset not found");
  const fn = m[0];
  // The preset overwrites: name, description, tools (cloned) and body.
  assert.match(fn, /name: preset\.name/);
  assert.match(fn, /description: preset\.description/);
  assert.match(fn, /tools: \[\.\.\.preset\.tools\]/);
  assert.match(fn, /inheritTools: false/);
  // The preset does NOT overwrite: id (slug), model, thinkingLevel, scope,
  // enabled — these survive a reroll.
  assert.doesNotMatch(fn, /id: preset/);
  assert.doesNotMatch(fn, /model: preset/);
  assert.doesNotMatch(fn, /thinkingLevel: preset/);
  assert.doesNotMatch(fn, /scope: preset/);
  assert.doesNotMatch(fn, /enabled: preset/);
});

test("resetSubagentTemplate clears a selected preset without dropping model choices", () => {
  const m = editorSource.match(
    /export function resetSubagentTemplate\([\s\S]+?\n\}/,
  );
  assert.ok(m, "resetSubagentTemplate not found");
  const fn = m[0];
  assert.match(fn, /name: ""/);
  assert.match(fn, /description: ""/);
  assert.match(fn, /tools: \[\.\.\.DEFAULT_SUBAGENT_TOOLS\]/);
  assert.match(fn, /body: ""/);
  assert.doesNotMatch(fn, /model:/);
  assert.doesNotMatch(fn, /thinkingLevel:/);
  assert.doesNotMatch(fn, /scope:/);
  assert.match(editorSource, /setDraft\(resetSubagentTemplate\(draft\)\)/);
});

test("preset ids and builtin document ids agree", () => {
  // 设置模板与运行时内置目录保持一致。
  const presetIds = [
    ...presetSource.matchAll(
      /^\s+id: "([^"]+)",$/gm,
    ),
  ].map((m) => m[1]);
  assert.deepEqual(presetIds, [
    "explorer",
    "code-reviewer",
    "worker",
    "ui-designer",
    "native-media-analyst",
    "advisor",
  ]);
});

test("preset tools match the runtime builtin documents", () => {
  // 检查探索、执行与界面角色的工具边界。
  assert.match(presetSource, /id: "explorer"[\s\S]*?tools: \["Read", "Glob", "Grep", "Bash"\]/);
  assert.match(presetSource, /id: "code-reviewer"[\s\S]*?tools: \["Read", "Glob", "Grep"\]/);
  assert.match(presetSource, /id: "worker"[\s\S]*?tools: \["Read", "Glob", "Grep", "Edit", "Write", "Bash"\]/);
  assert.match(presetSource, /id: "ui-designer"[\s\S]*?tools: \["Read", "Glob", "Grep", "BrowserPreview", "Bash", "Edit", "Write"\]/);
});

test("preset bodies mirror the runtime markdown frontmatter bodies", () => {
  // The shared preset catalog embeds the body verbatim from the runtime docs
  // so the editor pre-fills the same system prompt the sidecar will run. We
  // spot-check the leading sentence of each prompt rather than full text so a
  // typo in the prose still fails.
  const bodies = [...presetSource.matchAll(/body:\s*\n?\s*`([^`]+)`/g)].map(
    (m) => m[1],
  );
  // explorer
  assert.match(bodies[0], /Explorer/);
  assert.match(bodies[0], /codebase navigation specialist/);
  // code-reviewer
  assert.match(bodies[1], /Review only what the task names/);
  // worker
  assert.match(bodies[2], /general-purpose implementation and repair agent/);
  // ui-designer
  assert.match(bodies[3], /UI designer/);
  assert.match(bodies[3], /design contract/);
  // native-media-analyst
  assert.match(bodies[4], /native audio\/video understanding/);
  // advisor
  assert.match(bodies[5], /independent technical advice/);
});

test("the removed turn cap leaves no trace in the editor or the presets", () => {
  // ADR 0253 removed the delegate turn limit: neither the editor helpers nor
  // the preset catalog may still declare one.
  assert.doesNotMatch(presetSource, /maxTurns/);
  assert.doesNotMatch(editorSource, /maxTurns/);
});

test("inherit grant helpers keep the inherit token out of the checkbox list", () => {
  assert.match(editorSource, /export function splitSubagentToolGrant/);
  assert.match(editorSource, /export function mergeSubagentToolGrant/);
  assert.match(editorSource, /inheritTools: grant\.inheritTools/);
  assert.match(editorSource, /SUBAGENT_INHERIT_TOKEN/);
});
