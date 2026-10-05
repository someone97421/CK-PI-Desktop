import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("editing an MCP server can set or clear its timeout override", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const { draftFromRecord, draftToInput, mcpDraftError } = await server.ssrLoadModule(
      "/src/components/extensions/McpEditorSheet.tsx",
    );
    const record = {
      id: "slow-server",
      label: "Slow server",
      transport: "stdio",
      command: "npx",
      enabled: true,
      timeoutSeconds: 45,
    };

    const edited = draftFromRecord(record);
    assert.equal(edited.timeoutSeconds, "45");
    edited.timeoutSeconds = "";
    assert.equal(mcpDraftError(edited), null);
    assert.equal(draftToInput(edited).timeoutSeconds, null);

    edited.timeoutSeconds = "90";
    assert.equal(draftToInput(edited).timeoutSeconds, 90);
    edited.timeoutSeconds = "601";
    assert.equal(mcpDraftError(edited), "extensions.mcp.errorTimeoutRange");
  } finally {
    await server.close();
  }
});
