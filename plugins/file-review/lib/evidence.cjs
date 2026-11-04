'use strict';

const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.trim();
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const ROOTS = ['workspace', 'scratch', 'external', 'visualization'];

function reviewFromMessage(message) {
  if (message.role !== 'tool' || message.toolStatus !== 'success'
    || !['Write', 'Edit'].includes(message.toolName)) return null;
  const details = message.toolResult?.details;
  const review = details?.review;
  if (!ROOTS.includes(details?.root) || !isRecord(review) || review.version !== 1
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

function summarize(entries) {
  const files = new Set();
  let additions = 0;
  let deletions = 0;
  for (const entry of entries) {
    files.add(entry.path);
    additions += entry.additions;
    deletions += entry.deletions;
  }
  return { fileCount: files.size, changeCount: entries.length, additions, deletions };
}

module.exports = { collect, summarize };
