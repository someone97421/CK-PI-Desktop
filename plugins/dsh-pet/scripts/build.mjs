/**
 * dsh-pet 桌宠（这是一个助手插件）—— 构建 / 打包脚本。
 *
 * 三种模式：
 *   --bundle （默认）只重建 widget/shared-core.js（src/shared → 浏览器 IIFE，挂 window.PetShared）。
 *                     这个产物要提交进仓库：宠物窗口是 file:// 经典 script，运行时不打包。
 *   --check  在 .build/ 里装配一份成品目录并跑插件 devkit 的静态检查（manifest / 入口 / 体积）。
 *   --pack   同上，再用 devkit 打成 dist/<插件id>-<版本>.piplug，并递增版本号（与 lan-remote-control 同一套流程）。
 *
 * esbuild 解析顺序：插件自身的 node_modules → 仓库 node_modules/.pnpm（开发机上没装插件依赖时的兜底）。
 * 不打进任何 DSH / 主程序依赖：本插件只用 node 内置模块与宿主注入的全局 `pi`。
 */
import { mkdir, mkdtemp, readdir, readFile, writeFile, cp, lstat, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { retainArtifacts } from '../../../scripts/artifact-retention.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(root, '../..');

/**
 * esbuild 解析：插件自身的 node_modules 优先；开发机上还没装插件依赖时，
 * 退回仓库 .pnpm 里已安装的 esbuild（与 lan-remote-control 的依赖版本一致）。
 */
async function loadEsbuild() {
  try {
    return await import('esbuild');
  } catch {
    /* 落到仓库兜底 */
  }
  try {
    const pnpm = join(repository, 'node_modules', '.pnpm');
    const dirs = (await readdir(pnpm)).filter((name) => name.startsWith('esbuild@')).sort().reverse();
    for (const dir of dirs) {
      try {
        return await import(pathToFileURL(join(pnpm, dir, 'node_modules', 'esbuild', 'lib', 'main.js')).href);
      } catch {
        /* 换下一个版本 */
      }
    }
  } catch {
    /* .pnpm 不存在：按未安装处理 */
  }
  throw new Error('缺少 esbuild：请在 plugins/dsh-pet 下执行 npm install');
}

const { build: esbuildBuild } = await loadEsbuild();
const buildRoot = join(root, '.build');
const mode = process.argv.includes('--pack')
  ? 'pack'
  : process.argv.includes('--check')
    ? 'check'
    : 'bundle';

/** src/shared（上游纯逻辑，语言 TypeScript）→ widget/shared-core.js（浏览器 IIFE） */
async function bundleShared(outfile) {
  await esbuildBuild({
    entryPoints: [join(root, 'src/shared/index.ts')],
    outfile,
    bundle: true,
    platform: 'browser',
    target: ['chrome110'],
    format: 'iife',
    globalName: 'PetShared',
    sourcemap: false,
    legalComments: 'eof',
  });
}

async function copyDir(source, destination) {
  await cp(source, destination, {
    recursive: true,
    filter: async (path) => {
      if ((await lstat(path)).isSymbolicLink()) {
        throw new Error(`插件资源不能包含符号链接：${path}`);
      }
      return true;
    },
  });
}

if (mode === 'bundle') {
  const outfile = join(root, 'widget', 'shared-core.js');
  await bundleShared(outfile);
  const stats = await readFile(outfile);
  console.log(`共享纯逻辑已生成：${outfile}（${stats.byteLength} 字节）`);
  process.exit(0);
}

await mkdir(buildRoot, { recursive: true });
const staging = await mkdtemp(join(buildRoot, 'plugin-'));
const tooling = join(buildRoot, 'tools');
let buildSucceeded = false;

try {
  await mkdir(staging, { recursive: true });
  await mkdir(tooling, { recursive: true });

  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  let versionFiles = [];
  if (mode === 'pack') {
    const packagePath = join(root, 'package.json');
    const lockPath = join(root, 'package-lock.json');
    const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    const parts = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(manifest.version);
    if (!parts || [pkg.version, lock.version, lock.packages?.['']?.version].some((v) => v !== manifest.version)) {
      throw new Error('插件版本必须是同步一致的 major.minor.patch，无法自动递增。');
    }
    const nextVersion = `${parts[1]}.${parts[2]}.${BigInt(parts[3]) + 1n}`;
    manifest.version = pkg.version = lock.version = lock.packages[''].version = nextVersion;
    versionFiles = [
      [join(root, 'manifest.json'), manifest],
      [packagePath, pkg],
      [lockPath, lock],
    ];
    console.log(`本次插件打包版本：${nextVersion}`);
  }

  await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const name of ['widget', 'views', 'assets']) {
    await copyDir(join(root, name), join(staging, name));
  }
  for (const name of ['LICENSE', 'README.md']) {
    await cp(join(root, name), join(staging, name));
  }

  // 共享纯逻辑：以源码为准重新生成，绝不把上一次的产物带进包
  await bundleShared(join(staging, 'widget', 'shared-core.js'));

  // 插件主进程：只依赖 node 内置模块，但仍打成单文件（与 lan-remote-control 同一约定）
  await esbuildBuild({
    entryPoints: [join(root, 'main.cjs')],
    outfile: join(staging, 'main.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: false,
    legalComments: 'eof',
  });

  // 用仓库里真正的 devkit（不复制一份安装规则）
  await esbuildBuild({
    entryPoints: [join(repository, 'packages/plugin-devkit/src/index.ts')],
    outfile: join(tooling, 'devkit.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    alias: { '@pi-desktop/plugin-sdk': join(repository, 'packages/plugin-sdk/src/index.ts') },
  });
  const { check, pack } = await import(pathToFileURL(join(tooling, 'devkit.mjs')).href);

  const result = await check(staging);
  for (const warning of result.warnings) console.warn(`${warning.code}: ${warning.message}`);
  if (!result.ok) {
    for (const error of result.errors) console.error(`${error.code}: ${error.message}`);
    process.exitCode = 1;
  } else if (mode === 'pack') {
    const artifact = await pack(staging, { outDir: join(root, 'dist') });
    for (const [path, data] of versionFiles) {
      await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
    }
    await retainArtifacts(join(root, 'dist'), [artifact.packagePath], (entry) =>
      entry.isFile() && entry.name.endsWith('.piplug'),
    );
    console.log(`插件包：${artifact.packagePath}\nSHA-256：${artifact.shasum}`);
  } else {
    console.log(`插件静态检查通过：${staging}`);
  }
  if (result.ok) {
    buildSucceeded = true;
    await retainArtifacts(buildRoot, [staging], (entry) => entry.isDirectory() && entry.name.startsWith('plugin-'));
  }
} finally {
  if (!buildSucceeded) await rm(staging, { recursive: true, force: true });
}
