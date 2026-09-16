import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { localFontPath, parseFontTables, parseWoff2Metadata, readFontMetadata } from "../electron/main/font-metadata-parser.ts";
import { readableFontFamily, supportsFontWeight, weightFaces } from "../src/lib/fonts.ts";

function tables({ name = "Book", weight = 350, italic = false, width = 5, axis } = {}) {
  const records = [[1, "Fixture"], [2, name], [16, "Fixture"], [17, name], [1, "测试字体"]];
  const strings = records.map(([, value]) => Buffer.from(value, "utf16le").swap16());
  const names = Buffer.alloc(6 + records.length * 12 + strings.reduce((sum, value) => sum + value.length, 0));
  names.writeUInt16BE(records.length, 2);
  names.writeUInt16BE(6 + records.length * 12, 4);
  let offset = 0;
  records.forEach(([id], i) => {
    const at = 6 + i * 12;
    names.writeUInt16BE(3, at);
    names.writeUInt16BE(1, at + 2);
    names.writeUInt16BE(i === 4 ? 0x804 : 0x409, at + 4);
    names.writeUInt16BE(id, at + 6);
    names.writeUInt16BE(strings[i].length, at + 8);
    names.writeUInt16BE(offset, at + 10);
    strings[i].copy(names, 6 + records.length * 12 + offset);
    offset += strings[i].length;
  });
  const os2 = Buffer.alloc(64);
  os2.writeUInt16BE(weight, 4);
  os2.writeUInt16BE(width, 6);
  os2.writeUInt16BE(italic ? 1 : 0, 62);
  const result = new Map([["name", names], ["OS/2", os2]]);
  if (axis) {
    const fvar = Buffer.alloc(36);
    fvar.writeUInt16BE(1, 0);
    fvar.writeUInt16BE(16, 4);
    fvar.writeUInt16BE(1, 8);
    fvar.writeUInt16BE(20, 10);
    fvar.writeUInt16BE(8, 14);
    fvar.write(axis.tag ?? "wght", 16, "ascii");
    [axis.min, axis.default, axis.max].forEach((value, i) => fvar.writeInt32BE(value * 65536, 20 + i * 4));
    result.set("fvar", fvar);
  }
  return result;
}

function sfnt(input, base = 0) {
  const result = Buffer.alloc(12 + input.size * 16 + [...input.values()].reduce((sum, value) => sum + value.length, 0));
  result.writeUInt32BE(0x10000, 0);
  result.writeUInt16BE(input.size, 4);
  let offset = 12 + input.size * 16;
  [...input].forEach(([tag, data], i) => {
    const at = 12 + i * 16;
    result.write(tag, at, "ascii");
    result.writeUInt32BE(base + offset, at + 8);
    result.writeUInt32BE(data.length, at + 12);
    data.copy(result, offset);
    offset += data.length;
  });
  return result;
}

test("static metadata preserves real names, numeric weights and localized family aliases", () => {
  const face = parseFontTables(tables());
  assert.equal(face.name, "Book");
  assert.equal(face.weight, 350);
  assert.equal(face.variable, false);
  assert.equal(face.wght, undefined);
  assert.deepEqual(face.families, ["Fixture", "测试字体"]);
});

test("VF weight ranges are actual fixed-point values, not an assumed 100-900", () => {
  const face = parseFontTables(tables({ axis: { min: 1, default: 350.5, max: 1000 } }));
  assert.equal(face.variable, true);
  assert.deepEqual(face.wght, { min: 1, default: 350.5, max: 1000 });
  assert.equal(supportsFontWeight([face], 950.25), true);
  assert.equal(supportsFontWeight([face], 1001), false);
  const narrow = parseFontTables(tables({ axis: { min: 275, default: 400, max: 625 } }));
  assert.equal(supportsFontWeight([narrow], 700), false);
});

test("a variable font without wght exposes only its actual fixed weight", () => {
  const face = parseFontTables(tables({ axis: { tag: "opsz", min: 8, default: 14, max: 72 } }));
  assert.equal(face.variable, true);
  assert.equal(face.wght, undefined);
  assert.equal(supportsFontWeight([face], 350), true);
  assert.equal(supportsFontWeight([face], 400), false);
});

test("italic and condensed styles never become additional weight options", () => {
  const upright = parseFontTables(tables());
  const italic = parseFontTables(tables({ name: "Italic", italic: true, weight: 450 }));
  const condensed = parseFontTables(tables({ name: "Condensed", width: 3, weight: 550 }));
  const selected = weightFaces({ faces: [upright, italic, condensed, upright] });
  assert.deepEqual(selected, [upright]);
  assert.equal(supportsFontWeight(selected, 550), false);
  assert.deepEqual(weightFaces({ faces: [italic] }), []);
  assert.deepEqual(weightFaces({ faces: [condensed] }), [condensed]);
});

test("malformed tables fail closed instead of inventing weights", () => {
  const badName = tables();
  badName.get("name").writeUInt16BE(65535, 4);
  assert.throws(() => parseFontTables(badName));
  assert.throws(() => parseFontTables(tables({ weight: 0 })));
  assert.throws(() => parseFontTables(tables({ axis: { min: 500, default: 400, max: 900 } })));
  const badAxis = tables({ axis: { min: 100, default: 400, max: 900 } });
  badAxis.get("fvar").writeUInt16BE(65535, 8);
  assert.throws(() => parseFontTables(badAxis));
});

test("CSS normal width selects one width family before style and weight", () => {
  const face = (width, weight, extra = {}) => ({ name: "Fixture", width, weight, style: "normal", variable: false, ...extra });
  const narrow = face(4, 400);
  const wide = face(6, 700, { variable: true, wght: { min: 600, default: 700, max: 900 } });
  assert.deepEqual(weightFaces({ faces: [wide, narrow] }), [narrow]);
  assert.equal(supportsFontWeight(weightFaces({ faces: [wide, narrow] }), 700), false);
  const narrower = face(2, 300);
  assert.deepEqual(weightFaces({ faces: [wide, narrower] }), [narrower]);
  assert.deepEqual(weightFaces({ faces: [face(8, 900), wide] }), [wide]);
  const normal = face(5, 450);
  assert.deepEqual(weightFaces({ faces: [wide, narrow, normal] }), [normal]);
  assert.deepEqual(weightFaces({ faces: [wide, face(4, 400, { style: "italic" })] }), []);
});

test("font paths reject slash UNC, mixed separators and device namespaces before I/O", async () => {
  for (const path of [
    "//server/share/font.ttf", String.raw`\\server\share\font.ttf`, String.raw`/\server/share/font.ttf`,
    String.raw`\\?\UNC\server\share\font.ttf`, "//?/UNC/server/share/font.ttf",
    String.raw`\\.\UNC\server\share\font.ttf`, "//./pipe/font.ttf",
    String.raw`\\?\C:\Fonts\font.ttf`, String.raw`\??\UNC\server\share\font.ttf`,
    "C:font.ttf", "/Fonts/font.ttf", "C:/Fonts/font.ttf:stream", "C:/Fonts/NUL.ttf",
  ]) assert.equal(localFontPath(path, "win32"), undefined, path);
  assert.equal(localFontPath("C:/Fonts/../Fonts/font.ttf", "win32"), String.raw`C:\Fonts\font.ttf`);
  assert.equal(localFontPath("/usr/share/fonts/font.ttf", "linux"), "/usr/share/fonts/font.ttf");
  // Run on any OS; the parser must reject these itself, not rely on discovery.
  for (const path of ["//server/share/font.ttf", String.raw`\\server\share\font.ttf`, "//?/UNC/server/share/font.ttf"]) {
    await assert.rejects(readFontMetadata(path), /Non-local font path/);
  }
});

test("SFNT and TTC metadata use absolute bounded table offsets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-font-metadata-"));
  try {
    const path = join(directory, "fixture.ttf");
    await writeFile(path, sfnt(tables()));
    assert.equal((await readFontMetadata(path))[0].name, "Book");
    const first = sfnt(tables(), 20);
    const second = sfnt(tables({ name: "Bold", weight: 700 }), 20 + first.length);
    const header = Buffer.alloc(20);
    header.write("ttcf");
    header.writeUInt32BE(0x10000, 4);
    header.writeUInt32BE(2, 8);
    header.writeUInt32BE(20, 12);
    header.writeUInt32BE(20 + first.length, 16);
    await writeFile(path, Buffer.concat([header, first, second]));
    assert.deepEqual((await readFontMetadata(path)).map((face) => face.weight), [350, 700]);
    first.writeUInt32BE(0xffffffff, 20);
    await writeFile(path, Buffer.concat([header, first, second]));
    await assert.rejects(readFontMetadata(path));
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(readFontMetadata(path, abort.signal));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("WOFF2 checks decompressed size and metadata while skipping outline transforms", async () => {
  const input = tables({ axis: { min: 200, default: 400, max: 850 } });
  const base128 = (value) => {
    const bytes = [value & 127];
    while ((value = Math.floor(value / 128))) bytes.unshift((value & 127) | 128);
    return Buffer.from(bytes);
  };
  const entries = [...input].map(([tag, data]) => Buffer.concat([Buffer.from([63]), Buffer.from(tag), base128(data.length)]));
  const compressed = brotliCompressSync(Buffer.concat([...input.values()]));
  const header = Buffer.alloc(48);
  header.write("wOF2");
  header.writeUInt32BE(0x10000, 4);
  header.writeUInt16BE(input.size, 12);
  header.writeUInt32BE(compressed.length, 20);
  const file = Buffer.concat([header, ...entries, compressed]);
  file.writeUInt32BE(file.length, 8);
  assert.deepEqual((await parseWoff2Metadata(file))[0].wght, { min: 200, default: 400, max: 850 });
  file.writeUInt32BE(0xffffffff, 20);
  await assert.rejects(parseWoff2Metadata(file));
});

test("bundled resource metadata agrees with the actual CSS declarations", async () => {
  const css = await readFile(new URL("../src/styles/fonts.css", import.meta.url), "utf8");
  let count = 0;
  for (const [, body] of css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
    const file = body.match(/assets\/fonts\/([^"]+)/)[1];
    const weights = body.match(/font-weight:\s*(\d+)(?:\s+(\d+))?;/);
    const [face] = await readFontMetadata(fileURLToPath(new URL(`../src/assets/fonts/${file}`, import.meta.url)));
    const min = Number(weights[1]);
    const max = Number(weights[2] ?? weights[1]);
    assert.equal(face.style, "normal");
    if (min !== max) {
      assert.ok(face.wght);
      assert.ok(face.wght.min <= min && face.wght.max >= max);
    } else assert.equal(face.weight, min);
    count++;
  }
  assert.equal(count, 4);
});

test("quoted family names containing commas or escapes resolve without fallback confusion", () => {
  assert.equal(readableFontFamily('"A, B", sans-serif'), "A, B");
  assert.equal(readableFontFamily("'A\\\\B', monospace"), "A\\B");
  assert.equal(readableFontFamily('"\\41 rial", sans-serif'), "Arial");
});

test("renderer metadata requests coalesce, cache, expire, and time out without inventing faces", async (t) => {
  const source = await readFile(new URL("../src/lib/fonts.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source.replaceAll('import("./api")', 'Promise.resolve({ api: globalThis.__fontMetadataTestApi })'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const { loadFontMetadata } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100000 });
  let calls = 0;
  let resolve;
  globalThis.__fontMetadataTestApi = {
    getFontMetadata: () => { calls++; return new Promise((done) => { resolve = done; }); },
  };
  t.after(() => { delete globalThis.__fontMetadataTestApi; t.mock.timers.reset(); });
  const generic = await loadFontMetadata("ui-monospace, Fixture");
  assert.equal(generic.source, "generic");
  assert.equal(calls, 0);
  const first = loadFontMetadata('"Fixture", sans-serif');
  const second = loadFontMetadata("fixture, monospace");
  await Promise.resolve();
  assert.equal(calls, 1);
  const metadata = { family: "Fixture", status: "known", source: "system", faces: [parseFontTables(tables())] };
  resolve(metadata);
  assert.deepEqual(await first, metadata);
  assert.deepEqual(await second, metadata);
  assert.deepEqual(await loadFontMetadata("Fixture"), metadata);
  assert.equal(calls, 1);
  t.mock.timers.tick(60001);
  const retry = loadFontMetadata("Fixture");
  await Promise.resolve();
  assert.equal(calls, 2);
  t.mock.timers.tick(25001);
  const fallback = await retry;
  assert.equal(fallback.status, "unavailable");
  assert.deepEqual(fallback.faces, []);
  resolve(metadata);
  assert.deepEqual(await loadFontMetadata("Fixture"), fallback);
  t.mock.timers.tick(60001);
  const refreshed = loadFontMetadata("Fixture");
  const concurrent = loadFontMetadata("fixture");
  await Promise.resolve();
  assert.equal(calls, 3);
  const changed = { ...metadata, faces: [parseFontTables(tables({ name: "Bold", weight: 700 }))] };
  resolve(changed);
  assert.deepEqual(await refreshed, changed);
  assert.deepEqual(await concurrent, changed);
  assert.deepEqual(await loadFontMetadata("Fixture"), changed);
  assert.equal(calls, 3);
});

test("focus refresh rejects old families, older requests and unmounted completions", async () => {
  const source = await readFile(new URL("../src/components/settings/FontWeightControl.tsx", import.meta.url), "utf8");
  const start = source.indexOf("  useEffect(() => {");
  const end = source.indexOf("  }, [family]);", start) + "  }, [family]);".length;
  const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const refreshMetadata = { current: () => {} };
  const requests = [];
  const loaded = [];
  const load = (family) => new Promise((resolve) => requests.push({ family, resolve }));
  const mount = (family) => {
    let cleanup;
    new Function("useEffect", "family", "refreshMetadata", "loadFontMetadata", "setLoaded", code)(
      (effect) => { cleanup = effect(); }, family, refreshMetadata, load, (value) => loaded.push(value),
    );
    return cleanup;
  };
  const unmountA = mount("A");
  refreshMetadata.current();
  unmountA();
  const unmountB = mount("B");
  requests[0].resolve({ family: "A" });
  requests[1].resolve({ family: "A" });
  requests[2].resolve({ family: "B", status: "unavailable" });
  await Promise.resolve();
  assert.deepEqual(loaded, [{ family: "B", metadata: { family: "B", status: "unavailable" } }]);
  refreshMetadata.current();
  refreshMetadata.current();
  requests[4].resolve({ family: "B", status: "known" });
  requests[3].resolve({ family: "B", status: "unavailable" });
  await Promise.resolve();
  assert.equal(loaded.length, 2);
  assert.equal(loaded[1].metadata.status, "known");
  refreshMetadata.current();
  unmountB();
  requests[5].resolve({ family: "B" });
  await Promise.resolve();
  assert.equal(loaded.length, 2);
  assert.match(source, /onFocusCapture=\{\(\) => refreshMetadata\.current\(\)\}/);
  assert.match(source, /onPointerDownCapture=\{\(\) => refreshMetadata\.current\(\)\}/);
});

test("weight control retains unsupported stored weights and provides accessible numeric validation", async () => {
  const ui = await readFile(new URL("../src/components/settings/FontWeightControl.tsx", import.meta.url), "utf8");
  assert.match(ui, /loaded\?\.family === family/);
  assert.match(ui, /if \(!cancelled && current === request\) setLoaded/);
  assert.match(ui, /title=\{draftInvalid \? t\("settings.appearanceWeightInvalid"\) : label\}/);
  assert.match(ui, /aria-invalid=\{draftInvalid\}/);
  assert.match(ui, /if \(!metadata \|\| draftInvalid\) return/);
  assert.match(ui, /if \(value !== undefined && !choices.has\(value\)\)/);
  const panels = await readFile(new URL("../src/components/settings/AppearancePanels.tsx", import.meta.url), "utf8");
  assert.match(panels, /updateFont\(\{ family: patch\.fontFamily \?\? "" \}\)/);
  assert.match(panels, /family=\{font\?\.family \|\| fallback\}/);
  assert.doesNotMatch(panels, /\[100, 200, 300/);
});
