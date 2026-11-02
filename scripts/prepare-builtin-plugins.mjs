import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BUILTIN_PLUGIN_SOURCES = [
  {
    id: "net.aiuo.session-title", directory: "session-title",
    assets: ["panel", "package.json", "LICENSE", "UPSTREAM.md"], browserEntries: [],
  },
  {
    id: "local.lan-remote-control", directory: "lan-remote-control",
    assets: ["web", "panel", "README.md"], browserEntries: ["web/app.js", "panel/app.js"],
  },
  {
    id: "local.codex-pet", directory: "codex-pet",
    assets: ["ui", "shared", "pets", "README.md"], browserEntries: [],
  },
];

export async function prepareBuiltinPlugins(root) {
  const require = createRequire(join(root, "plugins/lan-remote-control/package.json"));
  const { build } = require("esbuild");
  const scratch = process.env.PI_SCRATCH_DIR || tmpdir();
  await mkdir(scratch, { recursive: true });
  const staging = await mkdtemp(join(scratch, "builtin-plugins-"));
  try {
    for (const plugin of BUILTIN_PLUGIN_SOURCES) {
      const source = join(root, "plugins", plugin.directory);
      const destination = join(staging, plugin.id);
      const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
      if (manifest.id !== plugin.id || manifest.enabledByDefault !== false) {
        throw new Error(`内置可选插件必须匹配 ID 并声明缺省关闭：${plugin.directory}`);
      }
      await mkdir(destination, { recursive: true });
      await cp(join(source, "manifest.json"), join(destination, "manifest.json"));
      for (const asset of plugin.assets) {
        await cp(join(source, asset), join(destination, asset), { recursive: true });
      }
      await build({
        entryPoints: [join(source, manifest.main)],
        outfile: join(destination, manifest.main),
        bundle: true, platform: "node", target: "node22", format: "cjs",
        external: ["bufferutil", "utf-8-validate"],
        sourcemap: false, legalComments: "eof",
      });
      for (const entry of plugin.browserEntries) {
        await build({
          entryPoints: [join(source, entry)], outfile: join(destination, entry),
          bundle: true, platform: "browser", target: ["chrome110", "safari16"], format: "esm",
          sourcemap: false, legalComments: "eof",
        });
      }
    }
    const resources = join(root, "apps/desktop/resources/plugins");
    await mkdir(resources, { recursive: true });
    for (const plugin of BUILTIN_PLUGIN_SOURCES) {
      const destination = join(resources, plugin.id);
      await rm(destination, { recursive: true, force: true });
      await cp(join(staging, plugin.id), destination, { recursive: true });
    }
    console.log("已准备内置可选插件：会话标题、局域网远程控制、Codex 宠物（缺省关闭）");
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
