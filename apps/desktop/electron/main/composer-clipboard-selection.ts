import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clipboard } from "electron";
import { nativeClipboardPaths, readComposerClipboardDirectories } from "./composer-clipboard-directories";
import { MAC_CLIPBOARD_FILE_PROMISE_FORMATS, receiveMacClipboardFiles, resolveMacClipboardAliases } from "./composer-clipboard-mac";
import { receiveWindowsClipboardFiles } from "./composer-clipboard-win";
import { rememberComposerPickerSelection } from "./composer-picker";

export const clipboardTemporaryRoots = process.platform === "darwin" ? [tmpdir(), "/tmp"] : [tmpdir()];

export async function readDesktopClipboardSelection(clipboard: Clipboard, senderId: number, promisesOnly = false) {
  const mac = process.platform === "darwin";
  const receive = mac ? receiveMacClipboardFiles : process.platform === "win32" ? receiveWindowsClipboardFiles : undefined;
  const formats = mac
    ? MAC_CLIPBOARD_FILE_PROMISE_FORMATS
    : ["FileGroupDescriptorW", "FileGroupDescriptor", "FileContents"];
  const advertised = receive && formats.some(format => clipboard.has(format));
  if (promisesOnly && !advertised) return null;
  const remember = (paths: string[]) => rememberComposerPickerSelection(paths, senderId);
  const paths = advertised ? [] : await nativeClipboardPaths(clipboard);
  if (receive && (advertised || !paths.length)) {
    const directory = await mkdtemp(join(tmpdir(), "pi-clipboard-"));
    const dispose = () => { void rm(directory, { recursive: true, force: true }).catch(() => {}); };
    let retained = false;
    try {
      const received = await receive(directory);
      if (received.length) {
        const selection = await readComposerClipboardDirectories(clipboard, files => {
          const token = rememberComposerPickerSelection(files, senderId, Date.now(), dispose);
          retained = true;
          return token;
        }, async () => received);
        return selection;
      }
    } finally {
      if (!retained) dispose();
    }
  }
  const diskPaths = advertised ? await nativeClipboardPaths(clipboard) : paths;
  const resolved = mac && diskPaths.length ? await resolveMacClipboardAliases(diskPaths) : diskPaths;
  return readComposerClipboardDirectories(clipboard, remember, async () => resolved);
}
