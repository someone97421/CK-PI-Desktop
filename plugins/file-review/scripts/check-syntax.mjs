import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function sourceFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['dist', 'node_modules', '.build'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(path));
    else if (/\.(?:cjs|mjs|js)$/.test(entry.name)) result.push(path);
  }
  return result;
}
const files = await sourceFiles(root);
const results = await Promise.allSettled(files.map((path) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--check', path], { stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`语法检查失败：${path}`)));
})));
for (const result of results) if (result.status === 'rejected') throw result.reason;
console.log(`JavaScript 语法检查通过：${files.length} 个文件。`);
