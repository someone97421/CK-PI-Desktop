import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set(['node_modules', '.build', 'dist']);
async function filesAt(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesAt(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}
const files = (await filesAt(root)).filter((path) => ['.js', '.mjs', '.cjs'].includes(extname(path)));
let errors = 0;
for (const file of files) {
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (check.status !== 0) {
    errors++;
    console.error(check.stderr);
  }
  const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const localImports = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) localImports.push(specifier.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const specifier of localImports) {
    try { await readFile(resolve(dirname(file), specifier)); }
    catch { errors++; console.error(`Missing local import: ${file} -> ${specifier}`); }
  }
}
console.log(`Checked syntax and relative imports in ${files.length} plugin JavaScript files; ${errors} errors. No service or tests started.`);
process.exitCode = errors ? 1 : 0;
