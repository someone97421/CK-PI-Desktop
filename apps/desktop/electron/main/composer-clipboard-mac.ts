import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, mkdtemp, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const RECEIVE_TIMEOUT_MS = 60_000;
const MAX_FILES = 20;

export const MAC_CLIPBOARD_FILE_PROMISE_FORMATS = [
  "com.apple.pasteboard.promised-file-url",
  "com.apple.pasteboard.promised-file-content-type",
  "com.apple.NSFilePromiseItemMetaData",
  "com.apple.pasteboard.NSFilePromiseID",
  "Apple files promise pasteboard type",
  "NSFilesPromisePboardType",
  "dyn.ah62d4rv4gu8yc6durvwwa3xmrvw1gkdusm1044pxqyuha2pxsvw0e55bsmwca7d3sbwu",
] as const;

const COMMON_SCRIPT = `
ObjC.import('Foundation');

function isPresent(object) {
  return object != null && !object.isNil();
}

function nativeError(error, fallback) {
  return new Error(isPresent(error) ? ObjC.unwrap(error.localizedDescription) : fallback);
}

function filePath(url) {
  if (!isPresent(url) || !url.isFileURL) throw new Error('Expected a local file URL');
  const host = ObjC.unwrap(url.host);
  if (host && host.toLowerCase() !== 'localhost') throw new Error('Expected a local file URL');
  return ObjC.unwrap(url.path);
}
`;

const RECEIVE_SCRIPT = COMMON_SCRIPT + `
ObjC.import('AppKit');

function receiveAppKitFiles(receivers, destination) {
  if (receivers.count > ${MAX_FILES}) throw new Error('Too many promised clipboard files');
  // Keep the JXA callbacks on the script's thread and pump its run loop while writing.
  const queue = $.NSOperationQueue.mainQueue;
  const runLoop = $.NSRunLoop.currentRunLoop;
  let failure;
  const batches = [];
  for (let i = 0; i < receivers.count; i++) {
    const batch = { paths: [], count: 0 };
    const receiver = receivers.objectAtIndex(i);
    receiver.receivePromisedFilesAtDestinationOptionsOperationQueueReader(
      destination, $.NSDictionary.dictionary, queue, function (url, error) {
        try {
          if (isPresent(error)) throw nativeError(error, 'Failed to receive promised file');
          batch.paths.push(filePath(url));
        } catch (error) {
          failure = error;
        }
      },
    );
    batch.count = receiver.fileNames.count;
    batches.push(batch);
  }
  const count = batches.reduce((sum, batch) => sum + batch.count, 0);
  if (count > ${MAX_FILES}) throw new Error('Too many promised clipboard files');
  const isPending = () => batches.some(batch => batch.paths.length < (batch.count || 1));
  const deadline = Date.now() + ${RECEIVE_TIMEOUT_MS};
  while (!failure && isPending() && Date.now() < deadline) {
    runLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
  }
  if (failure) throw failure;
  if (isPending()) throw new Error('Timed out receiving promised clipboard files');
  return batches.flatMap(batch => batch.paths);
}

function receiveLegacyFiles(destination, promiseType) {
  ObjC.import('/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework');
  function check(status, operation) {
    if (status !== 0) throw new Error(operation + ' failed (OSStatus ' + status + ')');
  }
  const boardOut = Ref();
  check($.PasteboardCreate($('com.apple.pasteboard.clipboard'), boardOut), 'PasteboardCreate');
  const board = boardOut[0];
  $.PasteboardSynchronize(board);
  const count = Ref();
  check($.PasteboardGetItemCount(board, count), 'PasteboardGetItemCount');
  check($.PasteboardSetPasteLocation(board, destination), 'PasteboardSetPasteLocation');
  const paths = [];
  for (let i = 1; i <= count[0]; i++) {
    const item = Ref();
    check($.PasteboardGetItemIdentifier(board, i, item), 'PasteboardGetItemIdentifier');
    if ($.PasteboardGetItemFlavorFlags(board, item[0], promiseType, Ref()) !== 0) continue;
    if (paths.length === ${MAX_FILES}) throw new Error('Too many promised clipboard files');
    const data = Ref();
    check($.PasteboardCopyItemFlavorData(board, item[0], promiseType, data), 'PasteboardCopyItemFlavorData');
    const urlString = $.NSString.alloc.initWithDataEncoding(ObjC.castRefToObject(data[0]), $.NSUTF8StringEncoding);
    if (!isPresent(urlString)) throw new Error('Invalid promised file URL');
    paths.push(filePath($.NSURL.URLWithString(urlString)));
  }
  if (!paths.length) throw new Error('A clipboard file promise supplied no file URLs');
  return paths;
}

function run(args) {
  const board = $.NSPasteboard.generalPasteboard;
  const changeCount = board.changeCount;
  const types = ObjC.deepUnwrap(board.types) || [];
  const readable = ObjC.deepUnwrap($.NSFilePromiseReceiver.readableDraggedTypes) || [];
  if (!types.some(type => ${JSON.stringify(MAC_CLIPBOARD_FILE_PROMISE_FORMATS)}.includes(type) || readable.includes(type))) {
    return JSON.stringify({ paths: [], legacy: false });
  }
  const destination = $.NSURL.fileURLWithPathIsDirectory(args[0], true);
  const receivers = board.readObjectsForClassesOptions([$.NSFilePromiseReceiver], $.NSDictionary.dictionary);
  const legacy = !isPresent(receivers) || receivers.count === 0;
  if (legacy && !types.includes(${JSON.stringify(MAC_CLIPBOARD_FILE_PROMISE_FORMATS[0])})) {
    throw new Error('Could not read the clipboard file promises');
  }
  const paths = legacy ? receiveLegacyFiles(destination, $(${JSON.stringify(MAC_CLIPBOARD_FILE_PROMISE_FORMATS[0])}))
    : receiveAppKitFiles(receivers, destination);
  if (board.changeCount !== changeCount) throw new Error('The clipboard changed while receiving files');
  return JSON.stringify({ paths: paths, legacy: legacy });
}
`;

const ALIAS_SCRIPT = COMMON_SCRIPT + `
function run(args) {
  const paths = JSON.parse(args[0]);
  return JSON.stringify(paths.map(path => {
    const url = $.NSURL.fileURLWithPath(path);
    const flag = Ref();
    const error = Ref();
    if (!url.getResourceValueForKeyError(flag, $.NSURLIsAliasFileKey, error)) {
      throw nativeError(error[0], 'Could not read Finder alias metadata');
    }
    if (!isPresent(flag[0]) || !flag[0].boolValue) return path;
    const target = $.NSURL.URLByResolvingAliasFileAtURLOptionsError(
      url, $.NSURLBookmarkResolutionWithoutUI | $.NSURLBookmarkResolutionWithoutMounting, error,
    );
    if (!isPresent(target)) throw nativeError(error[0], 'Could not resolve Finder alias');
    return filePath(target);
  }));
}
`;

async function runScript(script: string, argument: string, timeout: number): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, "--", argument], {
      timeout, maxBuffer: 1024 * 1024,
    }));
  } catch (cause) {
    const error = cause as { stderr?: string; killed?: boolean };
    const detail = error.stderr?.trim().split("\n").pop()?.slice(0, 300);
    throw new Error(error.killed ? "等待剪贴板文件超时" : `读取剪贴板文件失败${detail ? `：${detail}` : ""}`, { cause });
  }
  return JSON.parse(stdout);
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && !value.includes("\0");
}

function isInside(directory: string, path: string): boolean {
  const suffix = relative(directory, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

export async function receiveMacClipboardFiles(directory: string): Promise<string[]> {
  if (process.platform !== "darwin") return [];
  if (!isAbsolutePath(directory)) throw new Error("Clipboard file destination must be an absolute directory");
  const destination = await realpath(directory);
  if (!(await stat(destination)).isDirectory()) throw new Error("Clipboard file destination must be a directory");

  const result = await runScript(RECEIVE_SCRIPT, destination, RECEIVE_TIMEOUT_MS + 5_000);
  if (!result || typeof result !== "object" || !("paths" in result) || !("legacy" in result)
    || typeof result.legacy !== "boolean" || !Array.isArray(result.paths) || !result.paths.every(isAbsolutePath)) {
    throw new Error("Invalid macOS clipboard file list");
  }
  const paths = [...new Set(result.paths)];
  if (paths.length > MAX_FILES) throw new Error("Too many promised clipboard files");
  const received: string[] = [];
  for (const path of paths) {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isFile()) throw new Error("A promised clipboard item is not a file");
    if (isInside(destination, canonical)) {
      received.push(canonical);
    } else if (result.legacy && !isInside(destination, path)) {
      // Some legacy providers hand back an existing temporary file URL.
      const local = join(await mkdtemp(join(destination, "item-")), basename(path));
      await copyFile(canonical, local, constants.COPYFILE_EXCL);
      const copied = await realpath(local);
      if (!isInside(destination, copied)) throw new Error("Promised clipboard file escaped its destination");
      received.push(copied);
    } else {
      throw new Error("Promised clipboard file escaped its destination");
    }
  }
  return [...new Set(received)];
}

export async function resolveMacClipboardAliases(paths: string[]): Promise<string[]> {
  if (process.platform !== "darwin" || !paths.length) return paths;
  if (!paths.every(isAbsolutePath)) throw new Error("Invalid Finder alias path");
  const resolved = await runScript(ALIAS_SCRIPT, JSON.stringify(paths), 10_000);
  if (!Array.isArray(resolved) || resolved.length !== paths.length || !resolved.every(isAbsolutePath)) {
    throw new Error("Invalid Finder alias result");
  }
  return resolved;
}
