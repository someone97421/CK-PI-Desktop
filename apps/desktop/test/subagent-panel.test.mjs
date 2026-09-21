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
  assert.match(workPanelSource, /<SubagentPanel selection=\{subagentPanel\} blocked=\{exiting \|\| panelBlocked \|\| blockingOverlayActive\} \/>/);
  assert.match(workPanelSource, /!subagentPanel && activeTab\?\.kind === "review"/);
  assert.match(workPanelSource, /subagentPanel && onCloseSubagentPanel/);
  assert.match(appSource, /const subagentPanelOpen = Boolean\(/);
  assert.match(appSource, /page === "chat"/);
  assert.match(appSource, /page !== "chat" \|\| subagentPanel\.sessionId !== activeSessionId/);
  assert.match(appSource, /workPanelOpen \|\| subagentPanelOpen/);
  assert.match(appSource, /subagentPanel=\{subagentPanelOpen \? subagentPanel : null\}/);
  assert.doesNotMatch(workPanelSource, /setContextOpen/);
});
