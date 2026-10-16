import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

async function loadSource(name, transform = (source) => source) {
  const source = transform(await readFile(new URL(`../electron/main/storage/${name}.ts`, import.meta.url), "utf8"));
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}
const { dataDirectoryConfigPath, readConfiguredDataDirectory } = await loadSource("legacy", (source) =>
  source.replace(/import \{ APP_SLUG \} from "@pi-desktop\/shared";/, 'const APP_SLUG = "this-is-a-agent";'));
const { readStoragePreferences, writeStoragePreferences, STORAGE_PREFERENCE_FILE } = await loadSource("preferences");

async function fixture(t) {
  const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "data-directory-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "legacy-data");
  const appData = join(root, "appdata");
  const anchor = join(appData, "this-is-a-agent");
  await mkdir(data);
  await mkdir(anchor, { recursive: true });
  return { root, data, appData, anchor };
}

test("旧 fork 配置仍从独立应用锚点读取，不移动业务数据", async (t) => {
  const { data, appData, anchor } = await fixture(t);
  const file = dataDirectoryConfigPath(appData);
  assert.equal(file, join(anchor, "data-directory.json"));
  assert.equal(readConfiguredDataDirectory(appData), undefined);
  await writeFile(file, JSON.stringify({ dataDir: data }));
  await writeFile(join(data, "pi.sqlite"), "保留旧数据库");
  assert.equal(readConfiguredDataDirectory(appData), data);
  const defaults = { data: readConfiguredDataDirectory(appData), browser: join(anchor, "chromium") };
  const pointer = join(anchor, STORAGE_PREFERENCE_FILE);
  const preferences = readStoragePreferences(pointer, defaults);
  assert.deepEqual(preferences, { version: 1, roots: defaults, backups: [] });
  writeStoragePreferences(pointer, preferences);
  assert.deepEqual(readStoragePreferences(pointer, defaults), preferences);
  assert.equal(await readFile(join(data, "pi.sqlite"), "utf8"), "保留旧数据库");
  assert.equal(await readFile(file, "utf8"), JSON.stringify({ dataDir: data }));
});

test("旧 fork 配置拒绝无效或不可用目录", async (t) => {
  const { appData, root } = await fixture(t);
  const file = dataDirectoryConfigPath(appData);
  for (const dataDir of [null, "relative-directory"]) {
    await writeFile(file, JSON.stringify({ dataDir }));
    assert.throws(() => readConfiguredDataDirectory(appData), /配置无效/);
  }
  await writeFile(file, JSON.stringify({ dataDir: join(root, "missing") }));
  assert.throws(() => readConfiguredDataDirectory(appData), { code: "ENOENT" });
});
