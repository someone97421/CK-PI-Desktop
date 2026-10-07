import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { retainArtifacts } from '../../../scripts/artifact-retention.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(root, '../..');
const mode = process.argv[2] ?? '--check';
if (!['--check', '--pack'].includes(mode) || process.argv.length > 3) {
  throw new Error('用法：node scripts/build.mjs [--check | --pack]');
}

async function copyOptional(name, staging) {
  const source = join(root, name);
  try {
    await stat(source);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  await cp(source, join(staging, name), { recursive: true });
}

const scratch = resolve(process.env.PI_SCRATCH_DIR || tmpdir());
await mkdir(scratch, { recursive: true });
const temporary = await mkdtemp(join(scratch, 'codex-pet-'));
try {
  const staging = join(temporary, 'plugin');
  await mkdir(staging);
  const [manifest, pkg] = await Promise.all([
    readFile(join(root, 'manifest.json'), 'utf8').then(JSON.parse),
    readFile(join(root, 'package.json'), 'utf8').then(JSON.parse),
  ]);
  if (typeof manifest.version !== 'string' || manifest.version !== pkg.version) {
    throw new Error('manifest.json 与 package.json 的插件版本必须一致。');
  }
  if (manifest.main !== 'main.cjs') {
    throw new Error('manifest.main 必须为 main.cjs。');
  }
  const copies = await Promise.allSettled([
    copyFile(join(root, 'manifest.json'), join(staging, 'manifest.json')),
    cp(join(root, 'ui'), join(staging, 'ui'), { recursive: true }),
    cp(join(root, 'shared'), join(staging, 'shared'), { recursive: true }),
    copyOptional('README.md', staging),
    copyOptional('docs', staging),
  ]);
  const failedCopy = copies.find((result) => result.status === 'rejected');
  if (failedCopy) throw failedCopy.reason;
  // UI 保持原生 ES modules，shared 保持 UMD；主入口及其静态依赖统一打包。
  await build({
    entryPoints: [join(root, 'main.cjs')],
    outfile: join(staging, 'main.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: false,
    legalComments: 'eof',
  });
  const devkitPath = join(temporary, 'devkit.mjs');
  await build({
    entryPoints: [join(repository, 'packages/plugin-devkit/src/index.ts')],
    outfile: devkitPath,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
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
    // 内容摘要区分同版本的源码变化，发布失败不会覆盖上一份成功产物。
    const packagePath = join(output, `${artifact.fileName.slice(0, -7)}-${artifact.shasum}.piplug`);
    try {
      await copyFile(artifact.packagePath, packagePath, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existingHash = createHash('sha256').update(await readFile(packagePath)).digest('hex');
      if (existingHash !== artifact.shasum) throw new Error(`已有插件包内容不一致：${packagePath}`);
    }
    await retainArtifacts(output, [packagePath], (entry) => entry.isFile() && entry.name.endsWith('.piplug'));
    console.log(`插件包：${packagePath}\nSHA-256：${artifact.shasum}`);
  } else {
    console.log(`插件编译及静态检查通过，版本：${manifest.version}`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
