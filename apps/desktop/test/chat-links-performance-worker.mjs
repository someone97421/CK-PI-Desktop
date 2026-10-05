import { parentPort } from "node:worker_threads";
import { createChatLinkScanBudget, scanChatLinkCandidates } from "../src/lib/chat-link-scanner.ts";
import { splitChatText } from "../src/lib/chat-links.ts";

function run(source) {
  const startedAt = performance.now();
  const budget = createChatLinkScanBudget();
  const { candidates, stats } = scanChatLinkCandidates(
    source,
    budget,
    () => null,
    () => "accept",
  );
  const segments = splitChatText(source);
  return {
    elapsedMs: performance.now() - startedAt,
    candidateCount: candidates.length,
    workCodeUnits: stats.workCodeUnits,
    reconstructed: segments.map((segment) => segment.text).join("") === source,
  };
}

parentPort.postMessage({ type: "ready" });
parentPort.on("message", ({ sizes }) => {
  const samples = sizes.map((size) => {
    const source = "a".repeat(size);
    const cold = run(source);
    const durations = Array.from({ length: 20 }, () => run(source).elapsedMs).sort((a, b) => a - b);
    return {
      size,
      coldMs: cold.elapsedMs,
      medianMs: (durations[9] + durations[10]) / 2,
      p95Ms: durations[18],
      candidateCount: cold.candidateCount,
      workCodeUnits: cold.workCodeUnits,
      reconstructed: cold.reconstructed,
    };
  });
  parentPort.postMessage({ type: "result", samples });
  parentPort.close();
});
