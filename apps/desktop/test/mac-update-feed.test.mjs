import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mergeMacUpdateFeeds } from "../../../scripts/mac-update-feed.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));
const { parseUpdateInfo, resolveFiles, findFile } = require("electron-updater/out/providers/Provider.js");
const { MacUpdater } = require("electron-updater/out/MacUpdater.js");

function feed(arch, version = "2610.713.2345") {
  const files = ["-mac.zip", ".dmg"].map((extension) => ({
    url: `this-is-a-agent-20261007-132345-${arch}${extension}`,
    sha512: `${arch}-${extension}-hash`, size: 123,
  }));
  return { version, files, path: files[0].url, sha512: files[0].sha512, releaseDate: "2026-10-07T05:30:00.000Z" };
}

test("标准 Mac 更新文件被现有更新器解析并为两种架构选择正确 ZIP", () => {
  const arm = feed("arm64");
  const intel = feed("x64");
  const merged = mergeMacUpdateFeeds([arm, intel]);
  const info = parseUpdateInfo(JSON.stringify(merged), "latest-mac.yml", "https://example.com/latest-mac.yml");
  const files = resolveFiles(info, new URL("https://example.com/"));
  for (const [arch, isArm] of [["arm64", true], ["x64", false]]) {
    const zip = findFile(MacUpdater.filterFilesForArch(files, isArm), "zip", ["dmg"]);
    assert.equal(zip.info.url, feed(arch).files[0].url);
    assert.equal(zip.info.sha512, feed(arch).files[0].sha512);
  }
  assert.deepEqual(merged.files, [...arm.files, ...intel.files]);
  assert.equal(merged.path, intel.path);
});

test("拒绝发布混合版本或缺失架构的 Mac 更新入口", () => {
  assert.throws(() => mergeMacUpdateFeeds([feed("arm64"), feed("x64", "2610.517.5331")]), /版本不一致/);
  assert.throws(() => mergeMacUpdateFeeds([feed("arm64")]), /缺少 macOS x64/);
});
