import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { HighlightService } from "../src/lib/shiki.ts";

function createNodeWorker() {
  const entry = new URL("../src/lib/shiki.worker.ts", import.meta.url).href;
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.postMessage = (data) => parentPort.postMessage(data);
    import(${JSON.stringify(entry)}).then(() => {
      parentPort.on('message', (data) => globalThis.onmessage({ data }));
    });
  `, { eval: true });
  const adapter = {
    onmessage: null, onerror: null,
    postMessage: (data) => worker.postMessage(data),
    terminate: () => { void worker.terminate(); },
  };
  worker.on("message", (data) => adapter.onmessage?.({ data }));
  worker.on("error", (error) => adapter.onerror?.(error));
  return adapter;
}

function highlight(service, owner, code, lang = "typescript") {
  return new Promise((resolve) => service.request(owner, code, lang, "one-dark-pro", resolve));
}

test("真实 Worker 保留增量语法状态和浅深主题，结果可克隆", { timeout: 15_000 }, async () => {
  const service = new HighlightService(createNodeWorker);
  try {
    const first = await highlight(service, "code", "const x = 1;\n/* open");
    const second = await highlight(service, "code", "const x = 1;\n/* open\ninside */");
    assert.ok(first?.[0].some((token) => token.color));
    assert.equal(second[2].map((token) => token.content).join(""), "inside */");
    const complete = await highlight(service, "fresh", "const x = 1;\n/* open\ninside */");
    assert.deepEqual(second, complete);
    const light = await new Promise((resolve) => service.request("code", "const x = 1;", "typescript", "one-light", resolve));
    assert.notEqual(light[0][0].color, first[0][0].color);
    service.release("code");
  } finally { service.dispose(); }
});

test("超时终止 Worker、记住失败内容且允许后续请求恢复", { timeout: 5000 }, async () => {
  let created = 0;
  let terminated = 0;
  const workers = [];
  const service = new HighlightService(() => {
    created++;
    const worker = {
      onmessage: null, onerror: null,
      postMessage(data) {
        if (data.type !== "highlight") return;
        queueMicrotask(() => {
          worker.onmessage?.({ data: { type: "loaded", id: data.id } });
          if (data.code !== "hang") worker.onmessage?.({ data: { type: "result", id: data.id, tokens: [[{ content: data.code }]] } });
        });
      },
      terminate() { terminated++; },
    };
    workers.push(worker);
    return worker;
  }, 20, 100);
  try {
    const stuck = highlight(service, "stuck", "hang");
    const next = highlight(service, "next", "ok");
    assert.equal(await stuck, null);
    assert.equal((await next)[0][0].content, "ok");
    assert.equal(terminated, 1);
    assert.equal(created, 2);
    assert.equal(await highlight(service, "remounted", "hang"), null);
    assert.equal(created, 2);
    assert.equal(workers[0].onmessage, null);
  } finally { service.dispose(); }
});

test("流式请求只保留最新等待项，取消的结果不会交付", async () => {
  const sent = [];
  const worker = {
    onmessage: null, onerror: null,
    postMessage(data) { sent.push(data); }, terminate() {},
  };
  const service = new HighlightService(() => worker);
  const results = [];
  try {
    const cancel = service.request("code", "first", "go", "one-dark-pro", () => results.push("first"));
    cancel();
    service.request("code", "second", "go", "one-dark-pro", () => results.push("second"));
    service.request("code", "third", "go", "one-dark-pro", () => results.push("third"));
    worker.onmessage({ data: { type: "result", id: sent[0].id, tokens: [] } });
    await new Promise(queueMicrotask);
    assert.deepEqual(sent.map((data) => data.code), ["first", "third"]);
    worker.onmessage({ data: { type: "result", id: sent[0].id, tokens: [] } });
    assert.deepEqual(results, []);
    worker.onmessage({ data: { type: "result", id: sent[1].id, tokens: [] } });
    assert.deepEqual(results, ["third"]);
  } finally { service.dispose(); }
});

test("加载超时与 Worker 启动失败均回退为纯文本", { timeout: 5000 }, async () => {
  let terminated = 0;
  const loading = new HighlightService(() => ({ onmessage: null, onerror: null, postMessage() {}, terminate() { terminated++; } }), 20, 20);
  const broken = new HighlightService(() => { throw new Error("unavailable"); });
  try {
    assert.equal(await highlight(loading, "a", "first"), null);
    assert.equal(terminated, 1);
    assert.equal(await highlight(loading, "b", "second"), null);
    assert.equal(await highlight(broken, "a", "value"), null);
    assert.equal(await highlight(broken, "b", "next"), null);
  } finally { loading.dispose(); broken.dispose(); }
});
