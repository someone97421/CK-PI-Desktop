export function mergeSnapshot(previous, response, { reset = false } = {}) {
  const page = response.messages || {};
  const rows = new Map((reset ? [] : previous).map((row) => [row.id, row]));
  for (const row of page.items || []) rows.set(row.id, row);
  const tools = new Map();
  for (const item of [
    ...(response.snapshot?.items || []),
    ...(response.snapshot?.activeItems || []),
  ]) {
    const content = item.content;
    if (content?.role && content.id) rows.set(content.id, {
      ...rows.get(content.id),
      ...(item.parentToolCallId ? { parentToolCallId: item.parentToolCallId } : {}),
      ...(item.agentName ? { agentName: item.agentName } : {}),
      ...content,
    });
    else if (
      item.itemType === "tool" ||
      item.type === "tool" ||
      content?.toolCallId
    ) {
      const id = content?.toolCallId || item.id;
      tools.set(id, { createdAt: item.createdAt, parentToolCallId: item.parentToolCallId,
        agentName: item.agentName, ...content, id, running: item.status === "streaming" });
    }
  }
  return { messages: [...rows.values()], tools };
}

export function assertQueueDraftAvailable(draftId) {
  if (draftId)
    throw new Error("请先发送或清空当前队列草稿，再编辑另一条队列消息。");
}
