import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import { buildSync } from "esbuild";

const require = createRequire(import.meta.url);
function load(path, overrides = {}) {
  const result = buildSync({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs" });
  const module = { exports: {} };
  const testRequire = id => overrides[id] ?? require(id);
  new Function("require", "module", "exports", result.outputFiles[0].text)(testRequire, module, module.exports);
  return module.exports;
}
function loadWithExecFile(execFile) {
  return load("../electron/main/composer-clipboard-directories.ts", {
    "node:child_process": { execFile },
  });
}
const { nativeClipboardPaths, readComposerClipboardDirectories } = load("../electron/main/composer-clipboard-directories.ts");
const { serializeComposerFileReferences, serializeInlineComposerFileReferences } = load("../../../packages/shared/src/composer-trigger.ts");
const clipboard = values => ({ availableFormats: () => Object.keys(values), readBuffer: format => Buffer.from(values[format] ?? "") });
const silentWindowsClipboard = () => ({ readBuffer: () => assert.fail("Windows must use its native file list") });

test("native URI file lists preserve order and decode spaces/unicode without reading clipboard text", async () => {
  assert.deepEqual(await nativeClipboardPaths(clipboard({
    "text/uri-list": "# comment\r\nfile:///tmp/one%20folder\r\nfile:///tmp/%E4%B8%AD%E6%96%87\r\nhttps://example.com/ignored",
    "text/plain": "unrelated clipboard text",
  }), "linux"), ["/tmp/one folder", "/tmp/中文"]);
  assert.deepEqual(await nativeClipboardPaths(clipboard({ "x-special/gnome-copied-files": "copy\nfile:///tmp/a\nfile:///tmp/a" }), "linux"), ["/tmp/a"]);
});

test("native file lists enforce metadata and selection bounds", async () => {
  await assert.rejects(() => nativeClipboardPaths(clipboard({ "text/uri-list": "x".repeat(1024 * 1024 + 1) }), "linux"), /too large/);
  await assert.rejects(() => nativeClipboardPaths(clipboard({ "text/uri-list": Array.from({ length: 21 }, (_, i) => `file:///tmp/${i}`).join("\n") }), "linux"), /too many/);
  await assert.rejects(() => nativeClipboardPaths(clipboard({ "text/uri-list": "file:///tmp/a%00b" }), "linux"), /null|invalid|encoded/i);
});

test("Windows uses the complete native FileDropList instead of custom CF_HDROP or one FileNameW", async () => {
  const paths = ["C:\\first folder", "C:\\notes.txt", "D:\\中文"];
  assert.deepEqual(await nativeClipboardPaths(silentWindowsClipboard(), "win32", () => paths), paths);
  await assert.rejects(() => nativeClipboardPaths(clipboard({}), "win32", () => ["relative"]), /invalid clipboard file path/);
});

test("normalized MIME enumeration does not hide raw Finder file URLs", async () => {
  const native = clipboard({ "public.file-url": "file:///tmp/synthetic-folder" });
  native.availableFormats = () => ["text/uri-list"];
  assert.deepEqual(await nativeClipboardPaths(native, "darwin"), ["/tmp/synthetic-folder"]);
});

test("macOS Finder file-list metadata is decoded in full", { skip: process.platform !== "darwin" }, async () => {
  const xml = '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array><string>/tmp/first folder</string><string>/tmp/second</string></array></plist>';
  assert.deepEqual(await nativeClipboardPaths(clipboard({ NSFilenamesPboardType: xml }), "darwin"), ["/tmp/first folder", "/tmp/second"]);
});

test("an asynchronous Windows clipboard probe keeps the event loop responsive", async () => {
  // Keep the probe pending while verifying that unrelated event-loop work continues.
  const paths = ["C:\\slow folder"];
  const slowProbe = () => new Promise(resolve => setTimeout(() => resolve(paths), 50));
  let ticks = 0;
  const spin = setInterval(() => ticks++, 5);
  try {
    assert.deepEqual(await nativeClipboardPaths(silentWindowsClipboard(), "win32", slowProbe), paths);
  } finally {
    clearInterval(spin);
  }
  assert.ok(ticks >= 3, "the event loop must keep running while the clipboard probe is pending");
});

test("macOS Finder metadata is piped to plutil asynchronously", async () => {
  const plist = Buffer.from("synthetic Finder plist");
  const paths = ["/tmp/first folder", "/tmp/second"];
  const calls = [];
  let stdinBytes;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = {
    on() {},
    end(input) {
      stdinBytes = Buffer.from(input);
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(JSON.stringify(paths)));
        child.emit("close", 0);
      });
    },
  };
  const { nativeClipboardPaths: readPaths } = loadWithExecFile((command, args, options) => {
    calls.push({ command, args, options });
    return child;
  });

  assert.deepEqual(await readPaths(clipboard({ NSFilenamesPboardType: plist }), "darwin"), paths);
  assert.deepEqual(stdinBytes, plist);
  assert.equal(calls[0].command, "/usr/bin/plutil");
  assert.deepEqual(calls[0].args, ["-convert", "json", "-o", "-", "--", "-"]);
  assert.equal(calls[0].options.timeout, 10_000);
  assert.equal(calls[0].options.maxBuffer, 1024 * 1024);
  assert.equal("input" in calls[0].options, false);
});

test("Windows PowerShell clipboard adapter reads stdout asynchronously with process bounds", async () => {
  const paths = ["C:\\first folder", "D:\\中文"];
  const calls = [];
  let eventLoopTicks = 0;
  const { nativeClipboardPaths: readPaths } = loadWithExecFile((command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    const deliver = () => {
      eventLoopTicks++;
      if (eventLoopTicks < 3) {
        setImmediate(deliver);
        return;
      }
      child.stdout.emit("data", Buffer.from(JSON.stringify(paths)));
      child.emit("close", 0);
    };
    setImmediate(deliver);
    return child;
  });
  assert.deepEqual(await readPaths(silentWindowsClipboard(), "win32"), paths);
  assert.equal(eventLoopTicks, 3, "the event loop must run while PowerShell is pending");
  assert.match(calls[0].command, /powershell\.exe$/i);
  assert.ok(calls[0].args.includes("-STA"));
  assert.equal(calls[0].options.timeout, 10_000);
  assert.equal(calls[0].options.maxBuffer, 1024 * 1024);
});

test("Windows PowerShell clipboard adapter rejects a failed child process", async () => {
  const { nativeClipboardPaths: readPaths } = loadWithExecFile(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    setImmediate(() => child.emit("close", 1));
    return child;
  });
  await assert.rejects(() => readPaths(silentWindowsClipboard(), "win32"), /clipboard file list read failed/);
});

test("the clipboard helper reads a real child process whose stdout is not binary", async () => {
  // execFile defaults to utf8, so a real child hands the stream string chunks. A mock that
  // emits Buffers hides that boundary, which is how the production adapter crashed on macOS.
  const { execFileAsync } = load("../electron/main/composer-clipboard-directories.ts");
  const output = await execFileAsync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(['/tmp/one folder']))"], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  assert.ok(Buffer.isBuffer(output), "stdout must stay binary for JSON.parse");
  assert.deepEqual(JSON.parse(output.toString("utf8")), ["/tmp/one folder"]);
  await assert.rejects(
    () => execFileAsync(process.execPath, ["-e", "process.exit(3)"], { timeout: 30_000 }),
    /clipboard file list read failed/,
  );
});

test("a child process that already decodes stdout to strings is accepted", async () => {
  const paths = ["/tmp/one folder"];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = {
    on() {},
    end() {
      setImmediate(() => {
        child.stdout.emit("data", JSON.stringify(paths));
        child.emit("close", 0);
      });
    },
  };
  const { nativeClipboardPaths: readPaths } = loadWithExecFile(() => child);
  assert.deepEqual(await readPaths(silentWindowsClipboard(), "win32"), paths);
});

test("a child stream error rejects instead of escaping the event handler", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = { on() {}, end() { setImmediate(() => child.stdout.emit("error", new Error("spawn ENOENT"))); } };
  const { nativeClipboardPaths: readPaths } = loadWithExecFile(() => child);
  await assert.rejects(() => readPaths(silentWindowsClipboard(), "win32"), /spawn ENOENT/);
});

test("a Windows clipboard probe failure rejects without blocking the main process", async () => {
  // A hung or killed shell must surface as a rejection the caller can report, never as a
  // synchronous throw that leaves the main process frozen.
  const failed = () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("clipboard file list read failed")), 20));
  await assert.rejects(() => nativeClipboardPaths(silentWindowsClipboard(), "win32", failed), /clipboard file list read failed/);
});

test("directory metadata never copies a tree and mixed files use the existing import capability", async t => {
  const root = await mkdtemp(join(tmpdir(), "composer-folders-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, "folder & 中文"), file = join(root, "notes.txt");
  await mkdir(folder);
  await writeFile(join(folder, "keep.txt"), "original");
  await writeFile(file, "notes");
  let captured;
  const result = await readComposerClipboardDirectories(clipboard({}), paths => { captured = paths; return "selection"; }, () => [folder, file]);
  assert.deepEqual(result.items.map(item => item.kind), ["directory", "file"]);
  assert.equal(result.items[0].name, "folder & 中文");
  assert.equal(result.token, "selection");
  assert.equal(captured.length, 1);
  assert.equal(result.items[1].path, undefined, "regular source paths stay in main");
  assert.equal(await readFile(join(folder, "keep.txt"), "utf8"), "original");
  const regular = await readComposerClipboardDirectories(clipboard({}), () => "file-selection", () => [file]);
  assert.equal(regular.token, "file-selection");
  assert.deepEqual(regular.items, [{ kind: "file", name: "notes.txt" }]);
});

test("both send serializers preserve directory paths as escaped data markers", () => {
  const refs = [{ path: "/tmp/a & <b>", kind: "directory", token: "\ue001" }, { path: "/tmp/two", kind: "directory", token: "\ue002" }];
  for (const serialize of [serializeComposerFileReferences, serializeInlineComposerFileReferences]) {
    const result = serialize("Inspect \ue001 and \ue002", refs);
    assert.ok(result.includes("<dir>/tmp/a &amp; &lt;b&gt;</dir>"));
    assert.ok(result.includes("<dir>/tmp/two</dir>"));
    assert.equal(result, "Inspect <dir>/tmp/a &amp; &lt;b&gt;</dir> and <dir>/tmp/two</dir>");
    assert.equal(serialize("Removed both", refs), "Removed both");
    assert.equal(serialize("", [{ path: "/tmp/without-token", kind: "directory" }]).includes("<dir>/tmp/without-token</dir>"), true);
  }
});

test("内联目录卡片保留完整路径、本地化类型和移除操作", t => {
  const originalDocument = globalThis.document, originalNode = globalThis.Node;
  t.after(() => { globalThis.document = originalDocument; globalThis.Node = originalNode; });
  function element(tag) {
    const node = { nodeType: 1, tagName: tag.toUpperCase(), className: "", dataset: {}, childNodes: [], attributes: {}, listeners: {},
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(key, value) { this.listeners[key] = value; },
      append(...nodes) { this.childNodes.push(...nodes); },
      appendChild(child) { this.childNodes.push(child); return child; },
      replaceChildren() { this.childNodes = []; },
    };
    node.classList = { contains: key => node.className.split(" ").includes(key), add: key => { node.className += ` ${key}`; } };
    return node;
  }
  globalThis.document = { createElement: element, createTextNode: value => ({ nodeType: 3, nodeValue: value }) };
  globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
  const editor = load("../src/features/chat/composer/editor.ts");
  const reference = { path: "/tmp/folder.txt", name: "folder.txt", kind: "directory", token: "\ue001" };
  const container = element("div");
  let removed;
  const args = [container, "\ue001", new Map([["\ue001", reference]]), () => "Remove folder", token => { removed = token; }];
  if (editor.paintEditorValue.length >= 10) args.push(undefined, undefined, () => {}, () => {}, () => {}, "Folder");
  else args.push(() => {}, () => {}, () => {}, "Folder");
  editor.paintEditorValue(...args);
  const card = container.childNodes[0];
  assert.equal(card.classList.contains("composer-directory-card"), true);
  assert.equal(card.title, reference.path);
  assert.equal(card.contentEditable, "false");
  assert.equal(card.childNodes[1].childNodes[0].textContent, "folder.txt");
  assert.equal(card.childNodes[1].childNodes[1].textContent, "Folder");
  assert.equal(editor.readEditorValue(container), "\ue001");
  const remove = card.childNodes.at(-1);
  assert.equal(remove.attributes["aria-label"], "Remove folder");
  remove.listeners.click({ stopPropagation() {} });
  assert.equal(removed, "\ue001");
  assert.equal(editor.isEditableTextReference(reference), false);
});
