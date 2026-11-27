import { useMemo } from "react";
import { SubagentPresenceBar } from "../../../components/SubagentPresenceBar";
import { projectSubagentPresence } from "../../../lib/subagent-presence";
import { EMPTY_TRANSCRIPT } from "../../../lib/transcript-reading";
import { useAppStore } from "../../../stores/app-store";
import { SubagentStrip } from "./SubagentStrip";

export function ComposerSubagents({ sessionId }: { sessionId: string }) {
  const messages = useAppStore((state) => state.activeSessionId === sessionId ? state.messages : EMPTY_TRANSCRIPT);
  const running = useAppStore((state) => state.runningSessions[sessionId] === true);
  const items = useMemo(() => projectSubagentPresence(messages, running), [messages, running]);
  if (!items.length) return <SubagentStrip sessionId={sessionId} />;
  return <SubagentPresenceBar sessionId={sessionId} items={items} onOpen={(item) => {
    const state = useAppStore.getState();
    if (state.activeSessionId === sessionId) state.openSubagentTab(item.id, item.agent);
  }} />;
}
