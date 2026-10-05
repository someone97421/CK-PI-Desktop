import assert from "node:assert/strict";
import test from "node:test";
import { loadRecentModels, rememberModelInList, saveRecentModels } from "../src/lib/recent-models.ts";
import { availableRecentModels, inheritedSessionModelBinding, pinnedSessionModelBinding } from "../src/lib/session-model.ts";

const ref = (providerId, modelId) => ({ providerId, modelId });
const providers = [
  { id: "a", enabled: true, authKind: "none", models: [{ id: "one" }, { id: "two" }, { id: "image" }] },
  { id: "b", enabled: true, authKind: "api_key", hasSecret: true, models: [{ id: "one" }] },
];
const settings = { defaultProviderId: "a", defaultModelId: "one", imageGenerationModels: [ref("a", "image")] };

test("recent selection restores after reload and deduplicates exact provider/model pairs", () => {
  const old = globalThis.localStorage;
  const data = new Map();
  globalThis.localStorage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  try {
    let list = [];
    for (const model of [ref("a", "one"), ref("b", "one"), ref("a", "two"), ref("a", "ONE")]) {
      list = rememberModelInList(list, model);
    }
    saveRecentModels(list);
    const restored = loadRecentModels();
    assert.deepEqual(restored, [ref("a", "ONE"), ref("a", "two"), ref("b", "one")]);
    assert.deepEqual(inheritedSessionModelBinding({ providers, settings, recentModels: restored }), ref("a", "one"));
  } finally { globalThis.localStorage = old; }
});

test("new chat inherits the default model and existing chats retain their own binding", () => {
  const recentModels = [ref("b", "one"), ref("a", "two")];
  assert.deepEqual(inheritedSessionModelBinding({ providers, settings, recentModels }), ref("a", "one"));
  assert.deepEqual(inheritedSessionModelBinding({ providers, settings, recentModels, draft: ref("a", "two") }), ref("a", "two"));
  assert.deepEqual(pinnedSessionModelBinding({ providers, settings, recentModels, session: ref("a", "one") }), ref("a", "one"));
});

test("deleted, disabled, unauthenticated and image models are skipped in the recent menu", () => {
  const recentModels = [ref("missing", "one"), ref("a", "removed"), ref("a", "image"), ref("b", "one"), ref("a", "two")];
  for (const unavailable of [{ enabled: false }, { hasSecret: false }]) {
    const current = [providers[0], { ...providers[1], ...unavailable }];
    assert.deepEqual(availableRecentModels(recentModels, current, settings), [ref("a", "two")]);
    assert.deepEqual(inheritedSessionModelBinding({ providers: current, settings, recentModels }), ref("a", "one"));
  }
});

test("first run preserves configured defaults without choosing a recent model", () => {
  assert.deepEqual(inheritedSessionModelBinding({ providers, settings }), ref("a", "one"));
  assert.deepEqual(inheritedSessionModelBinding({ providers, settings: { defaultProviderId: "missing", defaultModelId: "gone" } }), ref("missing", "gone"));
  assert.deepEqual(inheritedSessionModelBinding({ providers: [] }), {});
  assert.deepEqual(inheritedSessionModelBinding({ providers, recentModels: [ref("a", "image")],
    settings: { ...settings, imageGenerationModels: [], imageGeneration: ref("a", "image") },
  }), ref("a", "one"));
  assert.deepEqual(inheritedSessionModelBinding({ providers, settings, draft: { providerId: "b" } }), ref("b", "one"));
});

test("corrupt local preferences are ignored and history remains bounded", () => {
  const old = globalThis.localStorage;
  try {
    globalThis.localStorage = { getItem: () => '{broken' };
    assert.deepEqual(loadRecentModels(), []);
    globalThis.localStorage = { getItem: () => JSON.stringify([null, {}, ref("a", "one"), ref("a", "one"), ref("", "two")]) };
    assert.deepEqual(loadRecentModels(), [ref("a", "one")]);
    let history = [];
    for (let i = 0; i < 30; i++) history = rememberModelInList(history, ref("a", String(i)));
    assert.equal(history.length, 20);
    assert.equal(history[0].modelId, "29");
  } finally { globalThis.localStorage = old; }
});
