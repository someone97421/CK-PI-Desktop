import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { retainArtifacts } from '../../../scripts/artifact-retention.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(root, '../..');
const mode = process.argv[2] || '--check';
if (!['--check', '--pack'].includes(mode) || process.argv.length > 3) {
  throw new Error('用法：node scripts/build.mjs [--check | --pack]');
}
const scratch = resolve(process.env.PI_SCRATCH_DIR || tmpdir());
await mkdir(scratch, { recursive: true });
const temporary = await mkdtemp(join(scratch, 'file-review-'));
try {
  const staging = join(temporary, 'plugin');
  await mkdir(staging);
  const [manifest, pkg] = await Promise.all([
    readFile(join(root, 'manifest.json'), 'utf8').then(JSON.parse),
    readFile(join(root, 'package.json'), 'utf8').then(JSON.parse),
  ]);
  if (manifest.version !== pkg.version) throw new Error('manifest 与 package 的插件版本必须一致。');
  const copies = await Promise.allSettled([
    copyFile(join(root, 'manifest.json'), join(staging, 'manifest.json')),
    copyFile(join(root, 'README.md'), join(staging, 'README.md')),
    cp(join(root, 'view'), join(staging, 'view'), { recursive: true }),
    cp(join(root, 'shared'), join(staging, 'shared'), { recursive: true }),
  ]);
  for (const result of copies) if (result.status === 'rejected') throw result.reason;
  await build({
    entryPoints: [join(root, 'main.cjs')], outfile: join(staging, 'main.cjs'),
    bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: false,
  });
  await build({
    entryPoints: [join(root, 'renderer/index.mjs')], outfile: join(staging, 'renderer/index.mjs'),
    bundle: true, platform: 'browser', target: 'chrome110', format: 'esm',
    external: ['react'], sourcemap: false,
  });
  const devkitPath = join(temporary, 'devkit.mjs');
  await build({
    entryPoints: [join(repository, 'packages/plugin-devkit/src/index.ts')],
    outfile: devkitPath, bundle: true, platform: 'node', target: 'node22', format: 'esm',
    alias: { '@pi-desktop/plugin-sdk': join(repository, 'packages/plugin-sdk/src/index.ts') },
  });
  const { check, pack } = await import(pathToFileURL(devkitPath).href);
  const result = await check(staging);
  for (const warning of result.warnings) console.warn(`${warning.code}: ${warning.message}`);
  if (!result.ok) {
    for (const error of result.errors) console.error(`${error.code}: ${error.message}`);
    throw new Error('插件静态检查未通过。');
  }
  if (mode === '--pack') {
    const artifact = await pack(staging, { outDir: join(temporary, 'dist') });
    const output = join(root, 'dist');
    await mkdir(output, { recursive: true });
    const packagePath = join(output, `${artifact.fileName.slice(0, -7)}-${artifact.shasum}.piplug`);
    try { await copyFile(artifact.packagePath, packagePath, constants.COPYFILE_EXCL); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = createHash('sha256').update(await readFile(packagePath)).digest('hex');
      if (existing !== artifact.shasum) throw new Error('已有插件包内容与摘要不一致。');
    }
    await retainArtifacts(output, [packagePath], (entry) => entry.isFile() && entry.name.endsWith('.piplug'));
    console.log(`插件包：${packagePath}\nSHA-256：${artifact.shasum}`);
  } else console.log(`插件编译及静态检查通过：${manifest.version}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
