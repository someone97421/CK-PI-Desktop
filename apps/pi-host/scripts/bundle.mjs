#!/usr/bin/env node
/**
 * Assemble the self-contained `pi-host` bundle for one Linux target:
 *
 *   dist-bundle/pi-host-<version>-<platform>-<arch>/
 *     pi-host.js                 the CLI, esbuild-bundled with every workspace package
 *     agent-runtime/sidecar.js   the same sidecar bundle the desktop ships
 *     bin/pi-desktop-host-core   the platform host-core binary
 *     node_modules/node-pty      optional; terminals are disabled without it
 *     package.json               { type: module, version }
 *     install.sh                 copies the bundle under ~/.pi-desktop/pi-host/<version>
 *
 * Usage: node scripts/bundle.mjs [--host-core <path>] [--platform linux] [--arch x64|arm64] [--out <dir>]
 *        [--pty <dir>]  node-pty directory for cross builds (env THIS_IS_A_AGENT_PI_HOST_PTY)
 */
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const root = resolve(app, "../..");
const require = createRequire(import.meta.url);
const { version } = require(join(app, "package.json"));

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((arg, index, all) => (arg.startsWith("--") && arg.length > 2 ? [[arg.slice(2), all[index + 1] && !all[index + 1].startsWith("--") ? all[index + 1] : true]] : [])),
);
const platform = String(args.platform ?? process.platform);
const arch = String(args.arch ?? process.arch);
const exe = platform === "win32" ? ".exe" : "";
const hostCore = resolve(String(args["host-core"] ?? join(root, `target/release/pi-desktop-host-core${exe}`)));
const sidecar = join(root, "packages/agent-runtime/dist-bundle/sidecar.js");
const out = resolve(String(args.out ?? join(app, "dist-bundle", `pi-host-${version}-${platform}-${arch}`)));

for (const [label, path] of [["host-core binary", hostCore], ["sidecar bundle", sidecar]]) {
  if (!existsSync(path)) {
    console.error(`${label} missing: ${path}`);
    process.exit(1);
  }
}
// 目标平台二进制必须与目标匹配；错拿 Windows exe 或 arm64 ELF 直接失败，
// 不让错平台二进制进包。
const ELF_MACHINES = { x64: 0x3e, arm64: 0xb7 };
if (platform === "linux") {
  const head = Buffer.alloc(20);
  const fd = openSync(hostCore, "r");
  try {
    readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  if (head.readUInt32BE(0) !== 0x7f454c46) {
    console.error(`host-core 不是 Linux ELF 二进制（疑似其他平台的产物）：${hostCore}`);
    process.exit(1);
  }
  if (head.readUInt16LE(18) !== ELF_MACHINES[arch]) {
    console.error(`host-core ELF 架构与目标 ${arch} 不符：${hostCore}`);
    process.exit(1);
  }
}
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "bin"), { recursive: true });
mkdirSync(join(out, "agent-runtime"), { recursive: true });

const { buildSync } = require("esbuild");
buildSync({
  entryPoints: [join(app, "src/cli.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["node-pty", "bufferutil", "utf-8-validate"],
  outfile: join(out, "pi-host.js"),
  banner: { js: "import { createRequire as __piCreateRequire } from 'node:module'; const require = __piCreateRequire(import.meta.url);" },
});
cpSync(sidecar, join(out, "agent-runtime/sidecar.js"));
writeFileSync(join(out, "agent-runtime/package.json"), '{ "type": "module" }\n');
cpSync(hostCore, join(out, `bin/pi-desktop-host-core${exe}`));
chmodSync(join(out, `bin/pi-desktop-host-core${exe}`), 0o755);
// node-pty 是带原生二进制的可选依赖：只有原生目标才允许用本机安装的
// node-pty；跨平台打包时本机的（如 Windows）node-pty 绝不能进 Linux 包，
// 仅在显式提供 --pty / THIS_IS_A_AGENT_PI_HOST_PTY（linux-x64 node-pty 目录）
// 时复制，否则沿用上游可选终端能力，明确警告本包不含终端。
const nativeTarget = process.platform === platform && process.arch === arch;
const ptyOverride = String(args.pty ?? process.env.THIS_IS_A_AGENT_PI_HOST_PTY ?? "").trim();
if (nativeTarget) {
  try {
    const pty = dirname(require.resolve("node-pty/package.json"));
    cpSync(pty, join(out, "node_modules/node-pty"), { recursive: true, dereference: true });
  } catch {
    console.warn("node-pty not installed; the bundle ships without terminals");
  }
} else if (ptyOverride) {
  if (!existsSync(join(resolve(ptyOverride), "package.json"))) {
    console.error(`--pty / THIS_IS_A_AGENT_PI_HOST_PTY 不是 node-pty 目录：${ptyOverride}`);
    process.exit(1);
  }
  cpSync(resolve(ptyOverride), join(out, "node_modules/node-pty"), { recursive: true, dereference: true });
} else {
  console.warn(`跨平台打包 ${platform}-${arch} 未提供 linux-x64 node-pty；本包不含终端（如需终端请设置 THIS_IS_A_AGENT_PI_HOST_PTY）`);
}
writeFileSync(join(out, "package.json"), `${JSON.stringify({ name: "pi-host", version, type: "module", bin: { "pi-host": "./pi-host.js" } }, null, 2)}\n`);
writeFileSync(
  join(out, "install.sh"),
  `#!/bin/sh
# Install this pi-host bundle under the user's home (D375 bootstrap).
set -eu
target="\${PI_HOST_INSTALL_DIR:-$HOME/.pi-desktop/pi-host}/${version}"
mkdir -p "$target"
cp -R "$(dirname "$0")"/. "$target"/
chmod 755 "$target/bin/pi-desktop-host-core${exe}"
ln -sfn "$target" "$(dirname "$target")/current"
echo "PI_HOST_INSTALLED $target"
`,
);
chmodSync(join(out, "install.sh"), 0o755);
console.log(`bundled ${out}`);
