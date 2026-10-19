'use strict';

const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.trim();
const count = (value) => Number.isSafeInteger(value) && value >= 0;

function reviewFromMessage(message) {
  if (message.role !== 'tool' || message.toolStatus !== 'success'
    || !['Write', 'Edit'].includes(message.toolName)) return null;
  const details = message.toolResult?.details;
  const review = details?.review;
  if (details?.root !== 'workspace' || !isRecord(review) || review.version !== 1
    || !['snapshotId', 'messageId', 'path'].every((key) => nonempty(review[key]))
    || !['write', 'edit', 'delete'].includes(review.operation)
    || !['added', 'modified', 'deleted'].includes(review.status)
    || !['active', 'rolledBack'].includes(review.state)
    || !count(review.additions) || !count(review.deletions)) return null;
  return {
    version: 1, snapshotId: review.snapshotId, messageId: review.messageId,
    sourceMessageId: message.id, path: review.path, operation: review.operation,
    status: review.status, state: review.state, additions: review.additions,
    deletions: review.deletions, reversible: review.reversible === true,
    binary: review.binary === true, truncated: review.truncated === true,
    hunks: Array.isArray(review.hunks) ? review.hunks.filter((hunk) =>
      isRecord(hunk) && nonempty(hunk.header) && Array.isArray(hunk.lines)).map((hunk) => ({
      header: hunk.header,
      lines: hunk.lines.filter((line) => isRecord(line)
        && ['add', 'del', 'context'].includes(line.type) && typeof line.text === 'string')
        .map(({ type, text }) => ({ type, text })),
    })) : [],
  };
}

function collect(messages, entries, missing) {
  for (const message of messages) {
    const review = reviewFromMessage(message);
    if (review) entries.set(review.snapshotId, review);
    else if (message.role === 'tool' && message.toolStatus === 'success'
      && ['Write', 'Edit'].includes(message.toolName)) missing.add(message.id);
  }
}

function select(data, ids) {
  const selected = ids ? new Set(ids) : null;
  const entries = data.entries.filter((entry) => !selected || selected.has(entry.sourceMessageId));
  return { entries, missingEvidence: data.missing.some((id) => !selected || selected.has(id)) };
}

function summarize(data) {
  const grouped = new Map();
  let additions = 0;
  let deletions = 0;
  let rolledBackCount = 0;
  for (const entry of data.entries) {
    grouped.set(entry.path, (grouped.get(entry.path) || 0) + 1);
    additions += entry.additions;
    deletions += entry.deletions;
    if (entry.state === 'rolledBack') rolledBackCount += 1;
  }
  return {
    fileCount: grouped.size, changeCount: data.entries.length, additions, deletions,
    rolledBackCount, missingEvidence: data.missingEvidence,
    files: [...grouped].slice(0, 12).map(([path, changes]) => ({ path: path.slice(0, 320), changes })),
  };
}

module.exports = { collect, select, summarize };
