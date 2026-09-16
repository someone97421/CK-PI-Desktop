import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const branding = JSON.parse(readFileSync(join(root, "app-branding.json"), "utf8"));

export function buildStamp(timestamp = new Date().toISOString()) {
  if (typeof timestamp !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp)) {
    throw new Error("构建时间必须是带时区的 ISO 时间");
  }
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error("无效的构建时间");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: branding.buildTimezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  const { year, month, day, hour, minute, second } = parts;
  if (Number(year) < 2000 || Number(year) > 2099) throw new Error("日期版本编码支持 2000–2099 年");
  // 三组日期时间数字均不超过 65535，兼容 SemVer、Windows EXE 和 NSIS。
  const version = [year.slice(2) + month, day + hour, minute + second].map(Number).join(".");
  return { version, displayVersion: `${year}${month}${day}-${hour}${minute}${second}`, builtAt: date.toISOString() };
}

function writeChanged(path, contents) {
  let old;
  try { old = readFileSync(path, "utf8"); } catch {}
  if (old !== contents) writeFileSync(path, contents);
}

export function prepareBuild(timestamp = process.env.THIS_IS_A_AGENT_BUILD_TIME) {
  if (branding.sharedDataDirectory !== ".pi-desktop") throw new Error("共用业务目录是已确认边界，迁移需要另行设计");
  const stamp = buildStamp(timestamp);
  process.env.THIS_IS_A_AGENT_BUILD_TIME = stamp.builtAt;
  const manifests = ["package.json", "apps/desktop/package.json", ...readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => `packages/${entry.name}/package.json`)];
  for (const relative of manifests) {
    const path = join(root, relative);
    let pkg;
    try { pkg = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    pkg.version = stamp.version;
    if (relative === "package.json") pkg.name = branding.slug;
    if (relative === "apps/desktop/package.json") {
      const [owner, repo] = branding.repository.split("/");
      pkg.homepage = `https://github.com/${branding.repository}`;
      pkg.desktopName = `${branding.slug}.desktop`;
      pkg.build.appId = branding.appId;
      pkg.build.productName = branding.slug;
      pkg.build.extraMetadata = { ...pkg.build.extraMetadata, name: branding.slug };
      pkg.build.publish = [{ provider: "github", owner, repo }];
      pkg.build.win.executableName = branding.slug;
      pkg.build.linux.executableName = branding.slug;
      pkg.build.linux.desktop = { ...pkg.build.linux.desktop, entry: {
        ...pkg.build.linux.desktop?.entry, Name: branding.name, "Name[en]": branding.slug, Comment: branding.name,
      } };
      pkg.build.deb.packageName = branding.slug;
      pkg.build.rpm.packageName = branding.slug;
      pkg.build.nsis.shortcutName = branding.name;
      pkg.build.nsis.uninstallDisplayName = branding.name;
      pkg.build.nsis.deleteAppDataOnUninstall = false;
      pkg.build.mac.extendInfo = { ...pkg.build.mac.extendInfo, CFBundleDisplayName: branding.name, CFBundleName: branding.name };
      pkg.buildVersionLabel = stamp.displayVersion;
      pkg.build.buildVersion = `${stamp.version}.0`;
      // macOS 使用三段 bundle version；文件名仍使用完整日期时间。
      pkg.build.mac.bundleVersion = stamp.version;
      const slug = branding.slug;
      pkg.build.mac.artifactName = `${slug}-${stamp.displayVersion}-` + '${arch}-mac.${ext}';
      pkg.build.dmg.artifactName = `${slug}-${stamp.displayVersion}-` + '${arch}.${ext}';
      pkg.build.nsis.artifactName = `${slug}-Setup-${stamp.displayVersion}-` + '${arch}.${ext}';
      pkg.build.portable.artifactName = `${slug}-Portable-${stamp.displayVersion}-` + '${arch}.${ext}';
      pkg.build.linux.artifactName = `${slug}-${stamp.displayVersion}-` + '${arch}.${ext}';
      pkg.build.deb.artifactName = `${slug}-${stamp.displayVersion}-` + '${arch}.${ext}';
      pkg.build.rpm.artifactName = `${slug}-${stamp.displayVersion}-` + '${arch}.${ext}';
    }
    writeChanged(path, JSON.stringify(pkg, null, 2) + "\n");
  }
  const cargoPath = join(root, "Cargo.toml");
  writeChanged(cargoPath, readFileSync(cargoPath, "utf8").replace(/^version = "[^"]+"/m, `version = "${stamp.version}"`));
  const lockPath = join(root, "Cargo.lock");
  writeChanged(lockPath, readFileSync(lockPath, "utf8").replace(/(name = "host-core"\r?\n)version = "[^"]+"/, `$1version = "${stamp.version}"`));
  const constants = {
    APP_ID: branding.appId, APP_NAME: branding.name, APP_SLUG: branding.slug,
    APP_REPOSITORY: branding.repository, APP_VERSION: stamp.version,
    APP_DISPLAY_VERSION: stamp.displayVersion, APP_BUILD_TIME: stamp.builtAt,
    APP_BUILD_TIMEZONE: branding.buildTimezone, APP_LEGACY_LOCK_NAME: branding.legacyLockName,
  };
  writeChanged(join(root, "packages/shared/src/app-build.ts"),
    "// 由 scripts/prepare-build.mjs 生成；身份配置请修改根目录 app-branding.json。\n" +
    Object.entries(constants).map(([key, value]) => `export const ${key} = ${JSON.stringify(value)};`).join("\n") + "\n");
  return stamp;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`构建版本：${prepareBuild().displayVersion}（${branding.buildTimezone}）`);
}
