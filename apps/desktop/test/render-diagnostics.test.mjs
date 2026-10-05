import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

test("development diagnostics retain bounded content-free phase samples", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    mode: "test",
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const diagnostics = await server.ssrLoadModule("/src/lib/render-diagnostics.ts");
    diagnostics.clearRenderDiagnosticSamples();
    for (let index = 0; index < 100; index += 1) {
      const finish = diagnostics.beginRenderDiagnostic("chat-link-scan", {
        sourceLength: 50_000,
        inputNodeCount: 4,
      });
      finish({ workCodeUnits: 100_000, reason: index === 99 ? "scan-budget" : undefined });
    }
    const samples = diagnostics.readRenderDiagnosticSamples();
    assert.equal(samples.length, 128);
    assert.equal(samples.at(-1).reason, "scan-budget");
    assert.ok(samples.every((sample) => sample.stage === "chat-link-scan"));
    assert.doesNotMatch(JSON.stringify(samples), /secret|workspace|payload/);
  } finally {
    await server.close();
  }
});
