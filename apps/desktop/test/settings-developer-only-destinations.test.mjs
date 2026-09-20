import assert from "node:assert/strict";
import test from "node:test";
import {
  SETTINGS_NAV,
  isSettingsDestinationHidden,
  searchSettings,
  visibleSettingsNav,
} from "../src/lib/settings-search.ts";

const identity = (key) => key;

test("远程主机在两种开发者模式下均出现在设置导航中", () => {
  const off = visibleSettingsNav(false).map((entry) => entry.id);
  const on = visibleSettingsNav(true).map((entry) => entry.id);
  assert.ok(off.includes("remoteHosts"));
  assert.deepEqual(off, on);
  assert.notEqual(SETTINGS_NAV.find((entry) => entry.id === "remoteHosts")?.developerOnly, true);
});

test("远程主机搜索结果不受开发者模式影响", () => {
  const off = searchSettings("remotehosts", identity, { developerMode: false });
  const on = searchSettings("remotehosts", identity, { developerMode: true });
  assert.ok(off.some((hit) => hit.tab === "remoteHosts"));
  assert.deepEqual(off, on);
  assert.equal(searchSettings("settings", identity, { limit: 2 }).length, 2);
});

test("切换开发者模式不会隐藏远程主机页面", () => {
  assert.equal(isSettingsDestinationHidden("remoteHosts", false), false);
  assert.equal(isSettingsDestinationHidden("remoteHosts", true), false);
  assert.equal(isSettingsDestinationHidden("general", false), false);
});
