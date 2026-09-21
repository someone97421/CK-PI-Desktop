import { readAppSource, readStoreSource, readTranscriptSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workPanelSource = await readFile(
  new URL("../src/components/workpanel/WorkPanel.tsx", import.meta.url),
  "utf8",
);
const appSource = await readAppSource();
const transcriptSource = await readTranscriptSource();
const storeSource = await readStoreSource();


test("a topology node toggles a session-scoped side-panel selection", () => {
  assert.match(transcriptSource, /const toggleSubagentPanel = useAppStore\(\(s\) => s\.toggleSubagentPanel\)/);
  assert.match(transcriptSource, /const panelSelectionId =/);
  assert.match(transcriptSource, /toggleSubagentPanel\(panelSelectionId\)/);
  assert.match(transcriptSource, /aria-controls=\{panelOpen \? "subagent-panel" : undefined\}/);
  assert.match(transcriptSource, /variant !== "topology" && open/);
  assert.match(transcriptSource, /variant !== "topology" && open && hasDetails/);
  assert.match(storeSource, /subagentPanel: SubagentPanelSelection \| null/);
  assert.match(storeSource, /toggleSubagentPanel:\s*\(delegationId\) => \{/);
  assert.match(
    storeSource,
    /state\.subagentPanel\?\.sessionId === sessionId[\s\S]*?state\.subagentPanel\.delegationId === id[\s\S]*?set\(\{ subagentPanel: null \}\)/,
  );
  assert.match(storeSource, /set\(\{ subagentPanel: \{ sessionId, delegationId: id \} \}\)/);
  assert.match(storeSource, /closeSubagentPanel: \(\) => set\(\{ subagentPanel: null \}\)/);
  assert.match(storeSource, /if \(state\.subagentPanel\) \{/);
  assert.match(storeSource, /state\.closeSubagentPanel\(\)/);
  assert.match(storeSource, /if \(get\(\)\.workPanelOpen\) get\(\)\.collapseWorkPanel\(\)/);
});

test("the work-panel dock hosts subagent details without creating a resource tab", () => {
  assert.match(workPanelSource, /subagentPanel\?: SubagentPanelSelection \| null/);
  assert.match(workPanelSource, /onCloseSubagentPanel\?: \(\) => void/);
  assert.match(workPanelSource, /\{subagentPanel \? \(/);
  assert.match(workPanelSource, /<SubagentPanel selection=\{subagentPanel\} \/>/);
  assert.match(workPanelSource, /!subagentPanel && activeTab\?\.kind === "review"/);
  assert.match(workPanelSource, /subagentPanel && onCloseSubagentPanel/);
  assert.match(appSource, /const subagentPanelOpen = Boolean\(/);
  assert.match(appSource, /page === "chat"/);
  assert.match(appSource, /page !== "chat" \|\| subagentPanel\.sessionId !== activeSessionId/);
  assert.match(appSource, /workPanelOpen \|\| subagentPanelOpen/);
  assert.match(appSource, /subagentPanel=\{subagentPanelOpen \? subagentPanel : null\}/);
  assert.doesNotMatch(workPanelSource, /setContextOpen/);
});

const panelSource = await readFile(
  new URL("../src/components/workpanel/SubagentPanel.tsx", import.meta.url), "utf8",
);
const detailSource = await readFile(
  new URL("../src/features/chat/transcript/SubagentDetail.tsx", import.meta.url), "utf8",
);
const workPanelCss = await readFile(
  new URL("../src/styles/work-panel.css", import.meta.url), "utf8",
);

test("宿主子代理窗口展示实时过程、任务卡片和失败原因", () => {
  assert.match(panelSource, /<SubagentDetail/);
  assert.doesNotMatch(panelSource, /PluginViewTab|local\.subagent-observer/);
  assert.match(panelSource, /buildTranscriptEntries\(messages\)/);
  assert.match(panelSource, /useTranscriptView\(selection\.sessionId\)/);
  assert.match(panelSource, /collectDelegationFailures\(selected\.turnActivityItems\)/);
  assert.match(panelSource, /delegationFailures=\{delegationFailures\}/);
  assert.match(detailSource, /className="subagent-detail-hero"/);
  assert.match(detailSource, /className="subagent-detail-task-card"/);
  assert.match(detailSource, /aria-controls=\{taskBodyId\}/);
  assert.match(detailSource, /<SubagentSupervision/);
  assert.match(detailSource, /<SubagentRunRows/);
  assert.match(detailSource, /scrollable=\{false\}/);
  assert.match(detailSource, /variant="dock"/);
  assert.match(detailSource, /failure && outcome !== "completed" && outcome !== "running"/);
  assert.match(detailSource, /data-testid="subagent-failure"/);
  assert.match(workPanelCss, /-webkit-line-clamp: 4/);
});

test("宿主子代理窗口保持单一滚动区、固定身份栏和过程时间线", () => {
  assert.match(panelSource, /useFollowScroll\(\)/);
  assert.match(panelSource, /onClick=\{jumpToLatest\}/);
  assert.match(panelSource, /role="log"/);
  assert.match(workPanelCss, /\.subagent-panel-scroll \{[^}]*overflow-y: auto/);
  assert.match(workPanelCss, /\.subagent-detail-hero\s*\{[\s\S]*?position:\s*sticky;/);
  assert.match(workPanelCss, /\.subagent-detail > \.subagent-run \.subagent-run-rows\s*\{[\s\S]*?border-left:\s*1px solid var\(--ds-border-subtle\);/);
});
