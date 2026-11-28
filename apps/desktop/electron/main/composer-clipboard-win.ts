import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const MAX_FILES = 20;
const MAX_FILE_BYTES = 100_000_000;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

// Use native STGMEDIUM pointers so ReleaseStgMedium owns the entire medium,
// including any provider-supplied pUnkForRelease, without RCW ownership changes.
const RECEIVE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using DVASPECT = System.Runtime.InteropServices.ComTypes.DVASPECT;
using FORMATETC = System.Runtime.InteropServices.ComTypes.FORMATETC;
using STATSTG = System.Runtime.InteropServices.ComTypes.STATSTG;
using TYMED = System.Runtime.InteropServices.ComTypes.TYMED;

public static class ComposerClipboardFiles {
    private const int MaxFiles = ${MAX_FILES};
    private const ulong MaxFileBytes = ${MAX_FILE_BYTES};
    private const ulong MaxTotalBytes = ${MAX_TOTAL_BYTES};

    [StructLayout(LayoutKind.Sequential)]
    private struct Medium {
        public TYMED Type;
        public IntPtr Value;
        public IntPtr ReleaseOwner;
    }

    [ComVisible(true), Guid("0000000A-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ILockBytes {
        [PreserveSig] int ReadAt(ulong offset, IntPtr bytes, uint count, IntPtr read);
        [PreserveSig] int WriteAt(ulong offset, IntPtr bytes, uint count, IntPtr written);
        [PreserveSig] int Flush();
        [PreserveSig] int SetSize(ulong size);
        [PreserveSig] int LockRegion(ulong offset, ulong size, uint type);
        [PreserveSig] int UnlockRegion(ulong offset, ulong size, uint type);
        [PreserveSig] int Stat(out STATSTG info, uint flags);
    }

    // Compound storage writes through these callbacks, so it cannot grow the
    // output past the attachment limits even before IStorage::Commit.
    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public sealed class BoundedLockBytes : ILockBytes {
        private const int InvalidFunction = unchecked((int)0x80030001);
        private readonly FileStream file;
        private readonly byte[] buffer;
        private readonly ulong total;

        public BoundedLockBytes(FileStream file, byte[] buffer, ulong total) {
            this.file = file;
            this.buffer = buffer;
            this.total = total;
        }

        public int ReadAt(ulong offset, IntPtr bytes, uint count, IntPtr read) {
            uint actual = 0;
            if (offset < (ulong)file.Length) {
                file.Position = (long)offset;
                while (actual < count) {
                    int chunk = file.Read(buffer, 0, (int)Math.Min((uint)buffer.Length, count - actual));
                    if (chunk == 0) break;
                    Marshal.Copy(buffer, 0, IntPtr.Add(bytes, (int)actual), chunk);
                    actual += (uint)chunk;
                }
            }
            if (read != IntPtr.Zero) Marshal.WriteInt32(read, (int)actual);
            return actual == count ? 0 : 1;
        }

        public int WriteAt(ulong offset, IntPtr bytes, uint count, IntPtr written) {
            if (written != IntPtr.Zero) Marshal.WriteInt32(written, 0);
            CheckSize(offset, total);
            CheckSize(offset + count, total);
            file.Position = (long)offset;
            for (int copied = 0; copied < (int)count;) {
                int chunk = Math.Min(buffer.Length, (int)count - copied);
                Marshal.Copy(IntPtr.Add(bytes, copied), buffer, 0, chunk);
                file.Write(buffer, 0, chunk);
                copied += chunk;
            }
            if (written != IntPtr.Zero) Marshal.WriteInt32(written, (int)count);
            return 0;
        }

        public int SetSize(ulong size) {
            CheckSize(size, total);
            file.SetLength((long)size);
            return 0;
        }

        public int Flush() { file.Flush(); return 0; }
        public int LockRegion(ulong offset, ulong size, uint type) { return InvalidFunction; }
        public int UnlockRegion(ulong offset, ulong size, uint type) { return InvalidFunction; }
        public int Stat(out STATSTG info, uint flags) {
            info = new STATSTG { type = 3, cbSize = file.Length }; // STGTY_LOCKBYTES
            return 0;
        }
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint RegisterClipboardFormat(string name);
    [DllImport("user32.dll")]
    private static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("ole32.dll")]
    private static extern int OleInitialize(IntPtr reserved);
    [DllImport("ole32.dll")]
    private static extern void OleUninitialize();
    [DllImport("ole32.dll")]
    private static extern int OleGetClipboard(out IntPtr data);
    [DllImport("ole32.dll")]
    private static extern void ReleaseStgMedium(ref Medium medium);
    [DllImport("ole32.dll")]
    private static extern int StgCreateDocfileOnILockBytes(IntPtr bytes, uint mode, uint reserved, out IntPtr storage);
    [DllImport("kernel32.dll")]
    private static extern UIntPtr GlobalSize(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalLock(IntPtr handle);
    [DllImport("kernel32.dll")]
    private static extern bool GlobalUnlock(IntPtr handle);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int GetData(IntPtr self, ref FORMATETC format, out Medium medium);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int ReadStream(IntPtr self, IntPtr buffer, int count, out int read);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int SeekStream(IntPtr self, long offset, int origin, out ulong position);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int CopyStorage(IntPtr self, uint excludeCount, IntPtr excludeInterfaces, IntPtr excludeNames, IntPtr destination);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int CommitStorage(IntPtr self, uint flags);
    private static IntPtr Method(IntPtr instance, int slot) {
        return Marshal.ReadIntPtr(Marshal.ReadIntPtr(instance), slot * IntPtr.Size);
    }

    private static uint Register(string name) {
        uint result = RegisterClipboardFormat(name);
        if (result == 0) throw new Win32Exception();
        return result;
    }

    private static void Check(int result, string operation) {
        if (result < 0) throw new COMException(operation + " (0x" + result.ToString("X8") + ").", result);
    }

    private static Medium Fetch(IntPtr data, GetData getData, uint id, int index, TYMED type, string name) {
        FORMATETC format = new FORMATETC {
            cfFormat = unchecked((short)id),
            dwAspect = DVASPECT.DVASPECT_CONTENT,
            lindex = index,
            tymed = type
        };
        Medium medium;
        Check(getData(data, ref format, out medium), "Could not read clipboard " + name);
        return medium;
    }

    private static IntPtr Lock(IntPtr handle) {
        IntPtr bytes = GlobalLock(handle);
        if (bytes == IntPtr.Zero) throw new Win32Exception();
        return bytes;
    }

    private sealed class Descriptor {
        public string Name;
        public ulong? Size;
    }

    private static Descriptor[] ReadDescriptors(Medium medium, bool wide) {
        if (medium.Type != TYMED.TYMED_HGLOBAL || medium.Value == IntPtr.Zero) {
            throw new IOException("Invalid clipboard file descriptor medium.");
        }
        ulong capacity = GlobalSize(medium.Value).ToUInt64();
        if (capacity < 4) throw new IOException("Truncated clipboard file descriptors.");
        IntPtr bytes = Lock(medium.Value);
        try {
            uint count = unchecked((uint)Marshal.ReadInt32(bytes));
            if (count > MaxFiles) throw new IOException("Too many clipboard files (maximum " + MaxFiles + ").");
            // FILEGROUPDESCRIPTOR starts with a UINT. Each FILEDESCRIPTOR has
            // a 72-byte fixed header and a MAX_PATH array of WCHARs or CHARs.
            int width = wide ? 2 : 1;
            int stride = 72 + 260 * width;
            if (capacity < 4 + (ulong)count * (ulong)stride) {
                throw new IOException("Truncated clipboard file descriptors.");
            }
            Descriptor[] descriptors = new Descriptor[count];
            ulong declaredTotal = 0;
            for (int index = 0; index < descriptors.Length; index++) {
                IntPtr entry = IntPtr.Add(bytes, 4 + index * stride);
                int flags = Marshal.ReadInt32(entry);
                if ((flags & 4) != 0 && (Marshal.ReadInt32(entry, 36) & 16) != 0) {
                    throw new IOException("The clipboard file group contains a directory.");
                }
                IntPtr name = IntPtr.Add(entry, 72);
                int length = 0;
                while (length < 260 && (wide ? Marshal.ReadInt16(name, length * 2) : Marshal.ReadByte(name, length)) != 0) {
                    length++;
                }
                if (length == 260) throw new IOException("Unterminated clipboard file name.");
                Descriptor descriptor = new Descriptor {
                    Name = wide ? Marshal.PtrToStringUni(name, length) : Marshal.PtrToStringAnsi(name, length)
                };
                if ((flags & 0x40) != 0) {
                    ulong high = unchecked((uint)Marshal.ReadInt32(entry, 64));
                    ulong low = unchecked((uint)Marshal.ReadInt32(entry, 68));
                    ulong size = (high << 32) | low;
                    CheckSize(size, declaredTotal);
                    declaredTotal += size;
                    descriptor.Size = size;
                }
                descriptors[index] = descriptor;
            }
            return descriptors;
        } finally {
            GlobalUnlock(medium.Value);
        }
    }

    private static void CheckSize(ulong size, ulong total) {
        if (size > MaxFileBytes) throw new IOException("Clipboard file exceeds " + MaxFileBytes + " bytes.");
        if (size + total > MaxTotalBytes) throw new IOException("Clipboard files exceed " + MaxTotalBytes + " bytes.");
    }

    private static ulong WriteGlobal(IntPtr handle, ulong? declared, FileStream file, byte[] buffer, ulong total) {
        ulong capacity = GlobalSize(handle).ToUInt64();
        // The allocation can exceed the payload when FD_FILESIZE is present.
        ulong size = declared ?? capacity;
        if (size > capacity) throw new IOException("Truncated clipboard memory file.");
        CheckSize(size, total);
        if (size == 0) return 0;
        IntPtr bytes = Lock(handle);
        try {
            for (int offset = 0; offset < (int)size;) {
                int count = Math.Min(buffer.Length, (int)size - offset);
                Marshal.Copy(IntPtr.Add(bytes, offset), buffer, 0, count);
                file.Write(buffer, 0, count);
                offset += count;
            }
        } finally {
            GlobalUnlock(handle);
        }
        return size;
    }

    private static bool CannotSeek(int result) {
        return result == unchecked((int)0x80004001) || result == unchecked((int)0x80030001);
    }

    private static ulong WriteStream(IntPtr stream, FileStream file, byte[] buffer, ulong total) {
        ReadStream read = (ReadStream)Marshal.GetDelegateForFunctionPointer(Method(stream, 3), typeof(ReadStream));
        SeekStream seek = (SeekStream)Marshal.GetDelegateForFunctionPointer(Method(stream, 5), typeof(SeekStream));
        // OLE permits GetData to return the stream positioned just past the payload.
        // Producers that start at zero can be read to EOF, including forward-only streams.
        ulong end;
        int tell = seek(stream, 0, 1, out end);
        if (CannotSeek(tell)) end = 0;
        else Check(tell, "Could not inspect clipboard stream position");
        ulong start;
        int rewind = seek(stream, 0, 0, out start);
        if (end != 0 || !CannotSeek(rewind)) {
            Check(rewind, "Could not rewind clipboard stream");
            if (start != 0) throw new IOException("Invalid clipboard stream position.");
        }
        if (end != 0) CheckSize(end, total);
        ulong written = 0;
        GCHandle pin = GCHandle.Alloc(buffer, GCHandleType.Pinned);
        try {
            while (end == 0 || written < end) {
                int count = end == 0 ? buffer.Length : (int)Math.Min((ulong)buffer.Length, end - written);
                int actual;
                int result = read(stream, pin.AddrOfPinnedObject(), count, out actual);
                Check(result, "Could not read clipboard stream");
                if (actual < 0 || actual > count) throw new IOException("Invalid clipboard stream read length.");
                written += (ulong)actual;
                CheckSize(written, total);
                file.Write(buffer, 0, actual);
                if (actual == 0 || result == 1) break;
            }
        } finally {
            pin.Free();
        }
        if (end != 0 && written != end) throw new IOException("Truncated clipboard stream.");
        return written;
    }

    private static ulong WriteStorage(IntPtr storage, FileStream file, byte[] buffer, ulong total) {
        BoundedLockBytes bytes = new BoundedLockBytes(file, buffer, total);
        IntPtr backing = Marshal.GetComInterfaceForObject(bytes, typeof(ILockBytes));
        try {
            IntPtr destination;
            // STGM_CREATE | STGM_READWRITE | STGM_SHARE_EXCLUSIVE
            Check(StgCreateDocfileOnILockBytes(backing, 0x1012, 0, out destination), "Could not create clipboard compound file");
            try {
                CopyStorage copy = (CopyStorage)Marshal.GetDelegateForFunctionPointer(Method(storage, 7), typeof(CopyStorage));
                CommitStorage commit = (CommitStorage)Marshal.GetDelegateForFunctionPointer(Method(destination, 9), typeof(CommitStorage));
                Check(copy(storage, 0, IntPtr.Zero, IntPtr.Zero, destination), "Could not copy clipboard compound file");
                Check(commit(destination, 0), "Could not commit clipboard compound file");
            } finally {
                Marshal.Release(destination);
            }
            return (ulong)file.Length;
        } finally {
            Marshal.Release(backing);
        }
    }

    public static string[] Receive(string directory) {
        uint unicodeFormat = Register("FileGroupDescriptorW");
        uint ansiFormat = Register("FileGroupDescriptor");
        uint contentsFormat = Register("FileContents");
        bool wide = IsClipboardFormatAvailable(unicodeFormat);
        if (!wide && !IsClipboardFormatAvailable(ansiFormat)) {
            if (IsClipboardFormatAvailable(contentsFormat)) throw new IOException("Clipboard file descriptors are missing.");
            return new string[0];
        }

        Check(OleInitialize(IntPtr.Zero), "Could not initialize OLE clipboard");
        try {
            IntPtr data;
            Check(OleGetClipboard(out data), "Could not open OLE clipboard");
            try {
                // IDataObject::GetData is the first method after IUnknown.
                GetData getData = (GetData)Marshal.GetDelegateForFunctionPointer(Method(data, 3), typeof(GetData));
                Medium group = Fetch(data, getData, wide ? unicodeFormat : ansiFormat, -1, TYMED.TYMED_HGLOBAL, "file descriptors");
                Descriptor[] descriptors;
                try {
                    descriptors = ReadDescriptors(group, wide);
                } finally {
                    ReleaseStgMedium(ref group);
                }

                string[] names = new string[descriptors.Length];
                byte[] buffer = new byte[64 * 1024];
                ulong total = 0;
                for (int index = 0; index < descriptors.Length; index++) {
                    Descriptor descriptor = descriptors[index];
                    Medium contents = Fetch(data, getData, contentsFormat, index,
                        TYMED.TYMED_ISTREAM | TYMED.TYMED_HGLOBAL | TYMED.TYMED_ISTORAGE, "file contents at index " + index);
                    try {
                        if (contents.Value == IntPtr.Zero) throw new IOException("Missing clipboard file data at index " + index + ".");
                        using (FileStream file = new FileStream(Path.Combine(directory, index.ToString(System.Globalization.CultureInfo.InvariantCulture)), FileMode.CreateNew, FileAccess.ReadWrite)) {
                            if (contents.Type == TYMED.TYMED_ISTREAM) {
                                total += WriteStream(contents.Value, file, buffer, total);
                            } else if (contents.Type == TYMED.TYMED_HGLOBAL) {
                                total += WriteGlobal(contents.Value, descriptor.Size, file, buffer, total);
                            } else if (contents.Type == TYMED.TYMED_ISTORAGE) {
                                total += WriteStorage(contents.Value, file, buffer, total);
                            } else {
                                throw new IOException("Unsupported clipboard file medium at index " + index + ".");
                            }
                        }
                    } finally {
                        ReleaseStgMedium(ref contents);
                    }
                    names[index] = descriptor.Name;
                }
                return names;
            } finally {
                Marshal.Release(data);
            }
        } finally {
            OleUninitialize();
        }
    }
}
'@
  $names = [ComposerClipboardFiles]::Receive($env:PI_COMPOSER_CLIPBOARD_STAGE)
  [Console]::Write((ConvertTo-Json -Compress -InputObject @($names)))
} catch {
  [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
  exit 1
}
`;

function readClipboard(stage: string): Promise<string> {
  const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const bootstrap = Buffer.from("& ([ScriptBlock]::Create([Console]::In.ReadToEnd()))", "utf16le").toString("base64");
  return new Promise((resolveOutput, reject) => {
    const child = execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", bootstrap], {
      env: { ...process.env, PI_COMPOSER_CLIPBOARD_STAGE: stage },
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 128 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr.trim() || (error.killed ? "helper timed out or was terminated" : error.message);
        reject(new Error(`could not receive Windows clipboard files: ${detail}`, { cause: error }));
      } else {
        resolveOutput(stdout);
      }
    });
    // A child that fails to start or closes stdin early is reported by execFile.
    child.stdin?.on("error", () => {});
    child.stdin?.end(RECEIVE_SCRIPT, "utf8");
  });
}

function safeFileName(rawName: string, index: number): string {
  const leaf = rawName.split(/[\\/]/).pop() ?? "";
  let name = leaf.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/[ .]+$/, "");
  if (!name) return `pasted-file-${index + 1}`;
  if (/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|(?:com|lpt)[0-9¹²³])(?:[ .]|$)/i.test(name)) name = `_${name}`;
  return name;
}

/** Receive the current Windows Shell virtual file group into an existing directory. */
export async function receiveWindowsClipboardFiles(directory: string): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const root = resolve(directory);
  const stage = await mkdtemp(join(root, ".clipboard-"));
  const paths: string[] = [];
  try {
    const names: unknown = JSON.parse(await readClipboard(stage));
    if (!Array.isArray(names) || names.length > MAX_FILES || names.some(name => typeof name !== "string")) {
      throw new Error("invalid Windows clipboard file list");
    }
    for (const [index, rawName] of names.entries()) {
      const name = safeFileName(rawName, index);
      const originalExtension = extname(name);
      const extension = originalExtension.slice(0, 100).replace(/[ .\uD800-\uDBFF]+$/, "");
      const stem = name.slice(0, Math.min(name.length - originalExtension.length, 230 - extension.length))
        .replace(/[ .\uD800-\uDBFF]+$/, "") || `pasted-file-${index + 1}`;
      const source = join(stage, String(index));
      for (let suffix = 1; ; suffix++) {
        const path = join(root, `${stem}${suffix === 1 ? "" : ` (${suffix})`}${extension}`);
        try {
          await copyFile(source, path, constants.COPYFILE_EXCL);
          paths.push(path);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
    }
    await rm(stage, { recursive: true, force: true });
    return paths;
  } catch (error) {
    const cleanup = await Promise.allSettled([
      rm(stage, { recursive: true, force: true }),
      ...paths.map(path => rm(path, { force: true })),
    ]);
    const failures = cleanup.filter(result => result.status === "rejected").map(result => result.reason);
    if (failures.length) throw new AggregateError([error, ...failures], "Windows clipboard receive and cleanup failed", { cause: error });
    throw error;
  }
}
