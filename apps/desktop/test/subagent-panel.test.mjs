import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { readStoreModule } from "./helpers/source-contracts.mjs";

const readSource = (path) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
const [
  workPanelSource, tabSource, detailSource, composerSource, stripSource, tabsSource, workPanelCss,
  stopSource, messagesCss, workPanelStore, readingRuntime, turnPartsSource,
] = await Promise.all([
  readSource("components/workpanel/WorkPanel.tsx"),
  readSource("components/workpanel/SubagentTranscriptTab.tsx"),
  readSource("features/chat/transcript/SubagentDetail.tsx"),
  readSource("components/workpanel/SubagentGuideComposer.tsx"),
  readSource("features/chat/composer/SubagentStrip.tsx"),
  readSource("lib/work-panel-tabs.ts"),
  readSource("styles/work-panel.css"),
  readSource("features/chat/transcript/SubagentStopButton.tsx"),
  readSource("styles/messages.css"),
  readStoreModule("slices/work-panel-slice.ts"),
  readStoreModule("runtime/transcript-reading-runtime.ts"),
  readSource("features/chat/transcript/AssistantTurnParts.tsx"),
]);

test("普通子代理标签与搜索定位共用会话页", async () => {
  await assert.rejects(access(new URL("../src/components/workpanel/SubagentPanel.tsx", import.meta.url)), { code: "ENOENT" });
  assert.doesNotMatch(workPanelSource, /from ["']\.\/SubagentPanel["']/);
  assert.match(workPanelSource, /<SubagentTranscriptTab\s+delegationId=\{activeTab\.resource \?\? ""\}\s*\/>/);
  assert.match(workPanelSource, /<SubagentTranscriptTab\s+delegationId=\{subagentPanel\.delegationId\}\s+selection=\{subagentPanel\}\s*\/>/);
  assert.match(tabSource, /function SubagentTranscriptTab\(\{\s*delegationId,\s*selection\s*\}/);
  assert.match(tabSource, /selection\?\.sessionId\s*\?\?\s*(?:activeSessionId|sessionId)/);
});

test("输入区胶囊打开同一委派标签，重复打开只激活已有资源", () => {
  assert.match(stripSource, /if \(state\.activeSessionId === sessionId\)\s*state\.openSubagentTab\(delegationIdForMessage\(message\), message\.agentName\)/);
  assert.match(stripSource, /data-subagent-trigger=\{id\}\s+onClick=\{onOpen\}/);
  assert.doesNotMatch(stripSource, /toggleSubagentPanel/);
  assert.match(workPanelStore, /openSubagentTab: \(delegationId, agentName\) => \{[\s\S]*?const id = delegationId\.trim\(\);[\s\S]*?openWorkPanelTab\(subagentWorkPanelTab\(id, agentName/);
  assert.match(tabsSource, /id: `subagent:\$\{delegationId\}`,\s*kind: "subagent",\s*resource: delegationId/);
  assert.match(workPanelStore, /openWorkPanelTabForSession: \(sessionId, tab\) => \{[\s\S]*?openWorkPanelTabState\(/);
  const openTab = tabsSource.slice(tabsSource.indexOf("export function openWorkPanelTabState"), tabsSource.indexOf("export function replaceWorkPanelTabState"));
  assert.match(openTab, /state\.tabs\.findIndex\(\(item\) => item\.id === tab\.id\)/);
  assert.match(openTab, /if \(index === -1\) \{\s*return \{ tabs: \[\.\.\.state\.tabs, tab\], activeTabId: tab\.id \}/);
  assert.match(openTab, /tabs\[index\] = tab;\s*return \{ tabs, activeTabId: tab\.id \}/);
});

test("嵌套搜索按所属会话、请求和子代理消息定位", () => {
  assert.match(readingRuntime, /subagentPanel: \{\s*sessionId,\s*delegationId: delegationIdForMessage\(parent\),\s*searchRequestId: focus\.requestId/);
  assert.match(tabSource, /const searchTarget = focus && \(!selection \|\| focus\.requestId === selection\.searchRequestId\)\s*&& result\?\.turns\.some\(\(turn\) => turn\.messages\.some\(\(\{ id \}\) => id === focus\.messageId\)\)\s*\? focus : null;/);
  assert.match(tabSource, /useTranscriptSearchFocus\(\{\s*target: searchTarget,\s*source: searchTarget \? messages\.find\(\(\{ id \}\) => id === searchTarget\.messageId\)\?\.content[\s\S]*?onNavigate: releaseFollow/);
  assert.match(tabSource, /<TranscriptSearchContext\.Provider value=\{searchTarget\}>/);
  assert.match(tabSource, /if \(searchTarget\) \{\s*initialPositionSet\.current = true;\s*return;/);
});

test("统一会话页保留任务、消息、滚动及历史读取反馈", () => {
  assert.match(tabSource, /data-testid="subagent-transcript-tab"/);
  assert.match(tabSource, /buildSubagentTranscript\(messages, delegationId\)/);
  assert.match(tabSource, /className="message-row user"/);
  assert.match(tabSource, /className="message-row assistant assistant-turn"/);
  assert.match(tabSource, /<AssistantTurnBody entry=\{turn.reply\}/);
  assert.match(turnPartsSource, /data-message-id=\{message\.id\}/);
  assert.match(turnPartsSource, /<AssistantErrorMessage message=\{message\}/);
  assert.match(tabSource, /<SubagentFailureCard outcome=\{turnOutcome\} failure=\{failure\}/);
  assert.match(tabSource, /<SubagentSupervision message=\{selected\.call\}/);
  assert.match(tabSource, /onClick=\{transcript\.retryHistory\}/);
  assert.match(tabSource, /useFollowScroll\(\)/);
  assert.match(tabSource, /onClick=\{jumpToLatest\}/);
  assert.equal(tabSource.match(/data-scroll-owner="follow"/g)?.length, 1);
  assert.match(tabSource, /role="log"/);
  assert.match(workPanelCss, /\.subagent-transcript-scroll\s*\{[^}]*overflow(?:-y:\s*auto|:\s*hidden auto)/);
});

test("统一会话页按当前执行提供引导、模型展示和停止入口", () => {
  assert.match(tabSource, /<SubagentDetail\s+message=\{selected\.call\}/);
  assert.match(detailSource, /\[delegateModelId\(message\), delegateThinkingLevel\(message\)\]/);
  assert.match(tabSource, /<SubagentGuideComposer[\s\S]*?sessionId=\{execution\.sessionId\}[\s\S]*?delegationId=\{execution\.delegationId\}[\s\S]*?execution=\{execution\.execution\}/);
  assert.match(composerSource, /localToolsAllowed && running && !stopping && sessionId && delegationId && execution/);
  assert.match(composerSource, /<Textarea[\s\S]*?disabled=\{!canGuide\}/);
  assert.match(composerSource, /api\.guideSubagent\(request\)/);
  assert.match(composerSource, /<SubagentStopButton sessionId=\{sessionId\} delegationId=\{delegationId\} execution=\{execution\}/);
  assert.match(stopSource, /className=\{`stop-btn subagent-stop-button/);
  assert.match(stopSource, /tooltip=\{label\}/);
  assert.match(stopSource, /ariaLabel=\{label\}/);
  assert.doesNotMatch(stopSource, /<Button/);
  assert.match(messagesCss, /\.subagent-topology-node-actions > \.subagent-stop-button[\s\S]*?top:\s*8px/);
  assert.match(messagesCss, /padding-right:\s*42px/);
});
