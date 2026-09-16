import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../electron/main/application-identity.ts", import.meta.url), "utf8");
const moduleSource = source.replace(/import \{ APP_LEGACY_LOCK_NAME, APP_NAME, APP_SLUG \} from "@pi-desktop\/shared";/,
  'const APP_LEGACY_LOCK_NAME = "PI-Desktop", APP_NAME = "这是一个助手", APP_SLUG = "this-is-a-agent";');
const js = ts.transpileModule(moduleSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { configureApplicationIdentity } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

function fakeApp(appData, allowed = true) {
  const paths = { appData }; const calls = []; let name;
  return {
    paths, calls,
    getPath: (key) => paths[key],
    setPath: (key, value) => { paths[key] = value; },
    setName: (value) => { name = value; },
    setAppLogsPath: (value) => { paths.logs = value; },
    requestSingleInstanceLock: () => { calls.push({ name, userData: paths.userData }); return allowed; },
    getName: () => name,
  };
}

test("默认业务目录沿用原版互斥，同时把新版 Chromium 数据放到独立目录", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-identity-"));
  try {
    const appData = join(home, "appdata"); const app = fakeApp(appData);
    const result = configureApplicationIdentity(app, { home, dataDir: "" });
    assert.equal(result.dataDir, join(home, ".pi-desktop"));
    assert.equal(result.hasSingleInstanceLock, true);
    assert.deepEqual(app.calls, [{ name: "PI-Desktop", userData: join(appData, "PI-Desktop") }]);
    assert.equal(app.getName(), "这是一个助手");
    assert.equal(app.paths.userData, join(appData, "this-is-a-agent"));
    assert.equal(app.paths.sessionData, join(app.paths.userData, "chromium"));
    assert.equal(app.paths.crashDumps, join(app.paths.userData, "Crashpad"));
    const duplicate = configureApplicationIdentity(fakeApp(appData, false), { home, dataDir: result.dataDir });
    assert.equal(duplicate.hasSingleInstanceLock, false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("自定义目录与其路径别名使用同一把锁，不同目录使用不同锁", async () => {
  const home = await mkdtemp(join(tmpdir(), "agent-identity-"));
  try {
    const dataDir = join(home, "shared"); const alias = join(home, "alias");
    await mkdir(dataDir);
    await symlink(dataDir, alias, process.platform === "win32" ? "junction" : "dir");
    const appData = join(home, "appdata");
    const a = fakeApp(appData); const b = fakeApp(appData); const c = fakeApp(appData);
    configureApplicationIdentity(a, { home, dataDir });
    configureApplicationIdentity(b, { home, dataDir: alias });
    configureApplicationIdentity(c, { home, dataDir: join(home, "other") });
    assert.equal(a.calls[0].userData, b.calls[0].userData);
    assert.equal(a.paths.userData, b.paths.userData);
    assert.notEqual(a.calls[0].userData, c.calls[0].userData);
    assert.notEqual(a.paths.userData, c.paths.userData);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("未获得锁时，入口在持久化初始化前立即退出", async () => {
  const main = await readFile(new URL("../electron/main/index.ts", import.meta.url), "utf8");
  const guard = main.indexOf("configureApplicationIdentity(app)");
  const exit = main.indexOf("app.exit(0)", guard);
  assert.ok(guard > 0 && exit > guard);
  assert.ok(exit < main.indexOf("new Logger("));
  assert.ok(exit < main.indexOf("new PersistenceOutbox("));
});
