import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** 标准 Mac 更新入口包含两种架构，保留打包器提供的文件哈希与大小。 */
export function mergeMacUpdateFeeds(feeds) {
  const [first] = feeds;
  if (!first || feeds.some((feed) => feed.version !== first.version)) {
    throw new Error("macOS 更新描述文件版本不一致");
  }
  const files = feeds.flatMap((feed) => feed.files);
  for (const arch of ["arm64", "x64"]) {
    if (!files.some((file) => file.url.endsWith(`-${arch}-mac.zip`))) {
      throw new Error(`缺少 macOS ${arch} ZIP 更新文件`);
    }
    if (!files.some((file) => file.url.endsWith(`-${arch}.dmg`))) {
      throw new Error(`缺少 macOS ${arch} DMG 安装包`);
    }
  }
  const primary = files.find((file) => file.url.endsWith("-x64-mac.zip"));
  return {
    ...first,
    files,
    path: primary.url,
    sha512: primary.sha512,
    releaseDate: feeds.map((feed) => feed.releaseDate).sort().at(-1),
  };
}

async function main([mode, output, ...inputs]) {
  let feeds;
  if (mode === "export" && inputs.length === 1) {
    // 打包任务已安装依赖；发布任务只读取 JSON，无需重复安装工作区。
    const require = createRequire(new URL("../packages/agent-runtime/package.json", import.meta.url));
    const { parse } = require("yaml");
    feeds = parse(await readFile(inputs[0], "utf8"));
  } else if (mode === "merge" && inputs.length === 2) {
    feeds = mergeMacUpdateFeeds(await Promise.all(inputs.map(async (input) => JSON.parse(await readFile(input, "utf8")))));
  } else {
    throw new Error("用法：mac-update-feed.mjs export 输出.json 输入.yml / merge latest-mac.yml arm64.json x64.json");
  }
  // JSON 是合法 YAML，electron-updater 可直接读取。
  await writeFile(output, `${JSON.stringify(feeds, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
