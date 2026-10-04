import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../electron/main/data-directory.ts", import.meta.url), "utf8");
const moduleSource = source
  .replace(/import \{ app, dialog, shell \} from "electron";/, "const app = {}, dialog = {}, shell = {};")
  .replace(/import \{ APP_SLUG \} from "@pi-desktop\/shared";/, 'const APP_SLUG = "this-is-a-agent";')
  .replace(/import \{ resolveLocale \} from "@pi-desktop\/i18n";/, 'const resolveLocale = () => "zh-CN";');
const js = ts.transpileModule(moduleSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { migrateDataDirectory, readConfiguredDataDirectory, saveConfiguredDataDirectory } =
  await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

async function fixture(t) {
  const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "data-directory-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const target = join(root, "target");
  const appData = join(root, "appdata");
  await mkdir(source);
  await mkdir(target);
  await writeFile(join(source, "pi.sqlite"), "示例数据库内容");
  await mkdir(join(source, "attachments"));
  await writeFile(join(source, "attachments", "sample.bin"), Buffer.from([0, 1, 254, 255]));
  await saveConfiguredDataDirectory(appData, source);
  return { root, source, target, appData };
}

test("迁移到已选择的空目录成功，保留原数据并保存新位置", async (t) => {
  const { root, source, target, appData } = await fixture(t);
  await migrateDataDirectory(source, target, appData);
  assert.equal(await readFile(join(target, "pi.sqlite"), "utf8"), "示例数据库内容");
  assert.deepEqual(await readFile(join(target, "attachments", "sample.bin")), Buffer.from([0, 1, 254, 255]));
  assert.equal(await readFile(join(source, "pi.sqlite"), "utf8"), "示例数据库内容");
  assert.deepEqual(await readFile(join(source, "attachments", "sample.bin")), Buffer.from([0, 1, 254, 255]));
  assert.equal(readConfiguredDataDirectory(appData), await realpath(target));
  assert.ok(!(await readdir(root)).some((name) => name.includes("-migration-")));
});

test("目标包含文件时拒绝迁移，保留目标文件与原启动配置", async (t) => {
  const { root, source, target, appData } = await fixture(t);
  await writeFile(join(target, "existing.txt"), "用户已有文件");
  await assert.rejects(migrateDataDirectory(source, target, appData), /空目录/);
  assert.equal(await readFile(join(target, "existing.txt"), "utf8"), "用户已有文件");
  assert.equal(readConfiguredDataDirectory(appData), source);
  assert.equal(await readFile(join(source, "pi.sqlite"), "utf8"), "示例数据库内容");
  assert.ok(!(await readdir(root)).some((name) => name.includes("-migration-")));
});

test("保存位置失败时保留原数据与原启动配置，并清理临时容器", async (t) => {
  const { root, source, target, appData } = await fixture(t);
  const configPath = join(appData, "this-is-a-agent", "data-directory.json");
  // 把写入所需的临时文件路径占为目录，确定性触发保存失败。
  await mkdir(`${configPath}.${process.pid}.tmp`);
  await assert.rejects(migrateDataDirectory(source, target, appData));
  assert.equal(readConfiguredDataDirectory(appData), source);
  assert.equal(await readFile(join(source, "pi.sqlite"), "utf8"), "示例数据库内容");
  assert.equal(await readFile(join(target, "pi.sqlite"), "utf8"), "示例数据库内容");
  assert.ok(!(await readdir(root)).some((name) => name.includes("-migration-")));
});
