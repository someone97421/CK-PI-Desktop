import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, writeFile, cp, lstat } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(root, '../..');
const buildRoot = join(root, '.build');
await mkdir(buildRoot, { recursive: true });
const staging = await mkdtemp(join(buildRoot, 'plugin-'));
const tooling = join(root, '.build', 'tools');
const mode = process.argv.includes('--pack') ? 'pack' : process.argv.includes('--check') ? 'check' : 'build';

async function copyAssets(source, destination) {
  await cp(source, destination, {
    recursive: true,
    filter: async (path) => {
      if ((await lstat(path)).isSymbolicLink()) throw new Error(`插件资源不能包含符号链接：${path}`);
      return !/\.(?:js|map)$/.test(path);
    },
  });
}

await mkdir(staging, { recursive: true });
await mkdir(tooling, { recursive: true });
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
for (const name of ['web', 'panel']) {
  await copyAssets(join(root, name), join(staging, name));
}
await build({
  entryPoints: [join(root, 'main.cjs')],
  outfile: join(staging, 'main.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['bufferutil', 'utf-8-validate'],
  sourcemap: false,
  legalComments: 'eof',
});
for (const name of ['web', 'panel']) {
  await build({
    entryPoints: [join(root, name, 'app.js')],
    outfile: join(staging, name, 'app.js'),
    bundle: true,
    platform: 'browser',
    target: ['chrome110', 'safari16'],
    format: 'esm',
    sourcemap: false,
    legalComments: 'eof',
  });
}

// Bundle the repository's actual devkit rather than duplicating its installer rules.
await build({
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
  console.log(`插件包：${artifact.packagePath}\nSHA-256：${artifact.shasum}`);
} else {
  console.log(`插件静态打包和 manifest 检查通过：${staging}`);
}
