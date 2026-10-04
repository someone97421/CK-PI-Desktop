import { createHash } from "node:crypto";
import { Data, NtExecutable, NtExecutableResource, Resource } from "resedit";

export type SavedIconResource = {
  type: number | string;
  id: number | string;
  lang: number | string;
  codepage: number;
  data: string;
};

export function iconDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 保留图标以外的资源及 PE 尾部数据，便携包的压缩载荷位于尾部。 */
export function replaceExecutableIcons(
  bytes: Buffer,
  ico: Buffer | null,
  originalIcons?: SavedIconResource[],
  defaultIco?: Buffer,
): { bytes: Buffer; originalIcons: SavedIconResource[] } {
  const executable = NtExecutable.from(bytes);
  const resources = NtExecutableResource.from(executable);
  const originalSections = executable.getAllSections().map((section) => ({ info: { ...section.info }, data: section.data }));
  const defaultEntries = resources.entries.filter((entry) => entry.type === 3 || entry.type === 14).map((entry) => ({ ...entry }));
  if (!originalIcons && defaultIco) {
    const defaultImages = Data.IconFile.from(defaultIco).icons.map((item) => item.data);
    for (const group of defaultEntries.filter((entry) => entry.type === 14)) {
      Resource.IconGroupEntry.replaceIconsForResource(defaultEntries, group.id, group.lang, defaultImages);
    }
  }
  const saved = defaultEntries.map((entry) => ({
    type: entry.type, id: entry.id, lang: entry.lang, codepage: entry.codepage,
    data: Buffer.from(entry.bin).toString("base64"),
  }));
  if (saved.length === 0) throw new Error("程序没有可替换的图标资源");
  const overlay = executable.getExtraData();
  if (ico) {
    const icons = Data.IconFile.from(ico).icons.map((item) => item.data);
    const groups = resources.entries.filter((entry) => entry.type === 14);
    for (const group of groups) {
      Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icons);
    }
  } else {
    const defaults = originalIcons ?? saved;
    if (!defaults.length) throw new Error("缺少程序的默认图标资源");
    resources.entries = resources.entries.filter((entry) => entry.type !== 3 && entry.type !== 14);
    for (const entry of defaults) {
      const data = Buffer.from(entry.data, "base64");
      resources.entries.push({
        type: entry.type, id: entry.id, lang: entry.lang, codepage: entry.codepage,
        bin: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
      });
    }
  }
  // 新资源放到末尾；原资源位于中间时保留其节，避免留下 Windows 拒绝加载的 RVA 空洞。
  const resourceSection = executable.getSectionByEntry(2);
  if (resourceSection && executable.getAllSections().some((section) =>
    section.info.virtualAddress > resourceSection.info.virtualAddress)) {
    resourceSection.info.name = ".rsrcold";
    executable.newHeader.optionalHeaderDataDirectory.set(2, { virtualAddress: 0, size: 0 });
  } else {
    executable.setSectionByEntry(2, null);
  }
  resources.outputResource(executable);
  const output = Buffer.from(executable.generate());
  const parsed = NtExecutable.from(output);
  const outputOverlay = parsed.getExtraData();
  if (overlay && (!outputOverlay || !Buffer.from(overlay).equals(Buffer.from(outputOverlay)))) {
    throw new Error("便携程序附加数据校验失败，已取消图标替换");
  }
  for (const section of parsed.getAllSections()) {
    const original = originalSections.find((item) => item.info.name === section.info.name);
    if (original && section.info.name !== ".rsrc" && (
      section.info.virtualAddress !== original.info.virtualAddress ||
      !Buffer.from(section.data ?? new ArrayBuffer(0)).equals(Buffer.from(original.data ?? new ArrayBuffer(0)))
    )) throw new Error("程序资源布局不支持安全替换图标");
  }
  return { bytes: output, originalIcons: originalIcons ?? saved };
}
