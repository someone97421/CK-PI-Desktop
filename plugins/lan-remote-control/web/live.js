import { applyMessageUpdate } from "../../../packages/shared/src/message-stream.ts";

export function mergeLiveEvent(messages, tools, frame) {
  const event = frame?.event || frame;
  const envelope = event?.payload;
  const raw = envelope?.event || envelope;
  if (event?.kind !== "agent.event" || !raw?.type) return false;
  const metadata = {
    ...(envelope?.parentToolCallId ? { parentToolCallId: envelope.parentToolCallId } : {}),
    ...(envelope?.agentName ? { agentName: envelope.agentName } : {}),
  };
  const upsert = (message) => {
    if (!message?.id) return;
    message = { ...metadata, ...message };
    const index = messages.findIndex((item) => item.id === message.id);
    if (index < 0) messages.push(message);
    else messages[index] = { ...messages[index], ...message };
  };
  switch (raw.type) {
    case "message_start":
    case "message_end":
      if (raw.replacesMessageId)
        messages.splice(
          0,
          messages.length,
          ...messages.filter((m) => m.id !== raw.replacesMessageId),
        );
      upsert(raw.precedingAssistant);
      upsert(raw.message);
      return true;
    case "message_update":
      upsert(
        applyMessageUpdate(
          messages.find((m) => m.id === raw.message.id),
          raw,
        ),
      );
      return true;
    case "user_message_persisted":
      messages.splice(
        0,
        messages.length,
        ...messages.filter((m) => m.id !== raw.optimisticMessageId),
      );
      upsert(raw.message);
      return true;
    case "tool_start":
    case "tool_update":
    case "tool_end": {
      const tool = tools.get(raw.toolCallId) || { id: raw.toolCallId };
      const latest = [...messages].reverse().find((m) => !m.parentToolCallId);
      Object.assign(tool, {
        createdAt: tool.createdAt || new Date(envelope?.ts || Date.now()).toISOString(),
        taskId: tool.taskId || latest?.taskId || latest?.task?.id,
        ...metadata,
      }, raw, { running: raw.type !== "tool_end" });
      tools.set(raw.toolCallId, tool);
      return true;
    }
    default:
      return false;
  }
}
