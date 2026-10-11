import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateSessionTiming,
  loadEarlierModelResponseDuration,
  sumModelResponseDuration,
} from "../src/lib/session-timing.ts";

test("session response duration sums top-level model responses only", () => {
  assert.equal(
    sumModelResponseDuration([
      { role: "assistant", responseDurationMs: 1_250 },
      { role: "assistant", responseDurationMs: 2_000, parentToolCallId: "task-1" },
      { role: "assistant", responseDurationMs: 3_000, nestedParentToolCallId: "call-1" },
      { role: "tool", responseDurationMs: 4_000 },
      { role: "assistant", responseDurationMs: Number.NaN },
      { role: "assistant", responseDurationMs: -50 },
    ]),
    1_250,
  );
});

test("session timing uses elapsed wall time and includes the live model request", () => {
  const messages = [
    { role: "assistant", responseDurationMs: 2_500 },
    { role: "assistant", responseDurationMs: 1_500 },
  ];
  const idle = calculateSessionTiming({
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:10.000Z",
    isRunning: false,
    messages,
    now: Date.parse("2026-10-01T00:00:12.000Z"),
  });
  assert.deepEqual(idle, {
    elapsedMs: 10_000,
    modelResponseMs: 4_000,
    modelResponsePercent: 40,
  });

  const running = calculateSessionTiming({
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:10.000Z",
    isRunning: true,
    messages,
    now: Date.parse("2026-10-01T00:00:12.000Z"),
    activeModelRequestStartedAt: Date.parse("2026-10-01T00:00:09.000Z"),
  });
  assert.deepEqual(running, {
    elapsedMs: 12_000,
    modelResponseMs: 7_000,
    modelResponsePercent: 58,
  });

  const streaming = calculateSessionTiming({
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:10.000Z",
    isRunning: true,
    messages: [
      ...messages,
      {
        role: "assistant",
        status: "streaming",
        createdAt: "2026-10-01T00:00:10.000Z",
      },
    ],
    now: Date.parse("2026-10-01T00:00:12.000Z"),
  });
  assert.equal(streaming?.modelResponseMs, 6_000);
  assert.equal(streaming?.modelResponsePercent, 50);
});

test("earlier response durations load through bounded transcript pages", async () => {
  const pages = new Map([
    [2_500, {
      messages: [{ role: "assistant", responseDurationMs: 1_000 }],
      messageStart: 1_500,
      hasMoreBefore: true,
    }],
    [1_500, {
      messages: [{ role: "assistant", responseDurationMs: 2_000 }],
      messageStart: 500,
      hasMoreBefore: true,
    }],
    [500, {
      messages: [{ role: "assistant", responseDurationMs: 3_000 }],
      messageStart: 0,
      hasMoreBefore: false,
    }],
  ]);
  const reads = [];

  const durationMs = await loadEarlierModelResponseDuration(2_500, async (options) => {
    reads.push(options);
    return pages.get(options.messageBefore) ?? null;
  });

  assert.equal(durationMs, 6_000);
  assert.deepEqual(reads.map((read) => read.messageBefore), [2_500, 1_500, 500]);
  assert.ok(reads.every((read) => read.messageLimit === 1_000));
  assert.ok(reads.every((read) => read.contentLimit === 256));
});

test("earlier timing pages fail visibly when their cursor does not advance", async () => {
  await assert.rejects(
    loadEarlierModelResponseDuration(250, async () => ({
      messages: [],
      messageStart: 250,
      hasMoreBefore: true,
    })),
    /did not advance/,
  );
});
