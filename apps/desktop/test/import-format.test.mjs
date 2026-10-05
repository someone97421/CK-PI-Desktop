import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { register } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { externalMcpDisplayMeta } = await import(
  "../src/features/settings/imports/import-format.ts"
);

test("MCP candidate metadata never exposes URL credentials or query values", () => {
  const meta = externalMcpDisplayMeta({
    source: "claude-code",
    sourcePath: "/config/mcp.json",
    id: "remote",
    rawKey: "remote",
    transport: "http",
    url: "https://user:secret@example.test:8443/path?token=private#fragment",
    warnings: [],
  });

  assert.equal(meta, "example.test:8443");
  assert.doesNotMatch(meta, /user|secret|private|path|fragment/);
});

test("MCP candidate metadata prefers safe description or command text", () => {
  const base = {
    source: "claude-code",
    sourcePath: "/config/mcp.json",
    id: "local",
    rawKey: "local",
    transport: "stdio",
    warnings: [],
  };

  assert.equal(externalMcpDisplayMeta({ ...base, description: "Local tools" }), "Local tools");
  assert.equal(externalMcpDisplayMeta({ ...base, command: "node" }), "node");
});
