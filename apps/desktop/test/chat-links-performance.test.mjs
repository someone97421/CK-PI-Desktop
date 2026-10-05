import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { CHAT_LINK_SCAN_LIMITS } from "../src/lib/chat-link-scanner.ts";

function nextWorkerMessage(worker, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`scanner worker exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    worker.once("message", (value) => {
      clearTimeout(deadline);
      resolve(value);
    });
    worker.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        clearTimeout(deadline);
        reject(new Error(`scanner worker exited with code ${code}`));
      }
    });
  });
}

test("production scanner stays bounded on oversized plain text in an isolated worker", { timeout: 15_000 }, async () => {
  const sizes = [5_000, 10_000, 30_000, 60_000, 100_000, 1_000_000];
  const spawnedAt = performance.now();
  const worker = new Worker(new URL("./chat-links-performance-worker.mjs", import.meta.url));
  const ready = await nextWorkerMessage(worker, 10_000);
  assert.equal(ready.type, "ready");
  const workerWarmStartMs = performance.now() - spawnedAt;

  const startedAt = performance.now();
  worker.postMessage({ sizes });
  const { samples } = await nextWorkerMessage(worker, 10_000);
  const totalMs = performance.now() - startedAt;

  assert.equal(samples.length, sizes.length);
  for (const sample of samples) {
    assert.equal(sample.reconstructed, true, `source reconstruction at ${sample.size}`);
    assert.equal(sample.candidateCount, 0);
    assert.ok(
      sample.workCodeUnits <= CHAT_LINK_SCAN_LIMITS.maxScanWorkCodeUnits,
      `scan work at ${sample.size}: ${sample.workCodeUnits}`,
    );
    assert.ok(
      sample.workCodeUnits <= sample.size * 2,
      `pre-budget scan work grew beyond the linear ceiling at ${sample.size}`,
    );
  }
  assert.ok(samples.find((sample) => sample.size === 30_000).p95Ms <= 10);
  assert.ok(samples.find((sample) => sample.size === 100_000).p95Ms <= 25);
  console.info("SCANNER_BENCHMARK", JSON.stringify({ workerWarmStartMs, totalMs, samples }));
});
