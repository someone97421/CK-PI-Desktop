import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { getSessionCompactionModel, setSessionCompactionModel } = await import(
  "../electron/main/runtime/session-compaction-models.ts"
);

test("session compaction selection remains isolated and can follow global again", () => {
  const dataDir = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "compaction-models-"));
  try {
    assert.equal(getSessionCompactionModel(dataDir, "first"), null);
    setSessionCompactionModel(dataDir, "first", { providerId: "provider", modelId: "model" });
    assert.deepEqual(getSessionCompactionModel(dataDir, "first"), { providerId: "provider", modelId: "model" });
    assert.equal(getSessionCompactionModel(dataDir, "second"), null);
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "session-compaction-models.json"), "utf8")), {
      first: { providerId: "provider", modelId: "model" },
    });
    setSessionCompactionModel(dataDir, "first", null);
    assert.equal(getSessionCompactionModel(dataDir, "first"), null);
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "session-compaction-models.json"), "utf8")), {});
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
