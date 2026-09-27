import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SETTINGS_NAV,
  isSettingsDestinationHidden,
  searchSettings,
  visibleSettingsNav,
} from "../src/lib/settings-search.ts";

const settingsPage = readFileSync(
  new URL("../src/features/settings/SettingsPage.tsx", import.meta.url),
  "utf8",
);
const searchDialog = readFileSync(
  new URL("../src/components/SearchDialog.tsx", import.meta.url),
  "utf8",
);
const identity = (key) => key;
const experimentalIds = ["sync", "remoteHosts"];

test("developer mode controls cloud sync and remote hosts in development", () => {
  const off = visibleSettingsNav(false).map((entry) => entry.id);
  const on = visibleSettingsNav(true).map((entry) => entry.id);

  for (const id of experimentalIds) {
    assert.equal(off.includes(id), false);
    assert.equal(on.includes(id), true);
  }
  assert.deepEqual(off, on.filter((id) => !experimentalIds.includes(id)));
  assert.deepEqual(
    SETTINGS_NAV.filter((entry) => entry.developerOnly === true).map((entry) => entry.id),
    experimentalIds,
  );
  assert.ok(
    SETTINGS_NAV.filter((entry) => entry.developerOnly === true)
      .every((entry) => entry.experimentalBadgeKey),
  );
});

test("packaged builds hide cloud sync and remote hosts", () => {
  const packaged = visibleSettingsNav(true, false).map((entry) => entry.id);
  for (const id of experimentalIds) {
    assert.equal(packaged.includes(id), false);
    assert.equal(isSettingsDestinationHidden(id, true, false), true);
  }
  assert.equal(isSettingsDestinationHidden("general", true, false), false);
});

test("settings search mirrors developer and packaged visibility", () => {
  assert.deepEqual(
    searchSettings("configSync.connectionTitle", identity, { developerMode: false }),
    [],
  );
  assert.ok(
    searchSettings("configSync.connectionTitle", identity, { developerMode: true })
      .some((hit) => hit.tab === "sync"),
  );

  for (const [query, tab] of [
    ["configSync.connectionTitle", "sync"],
    ["remotehosts", "remoteHosts"],
  ]) {
    assert.ok(
      searchSettings(query, identity, { developerMode: true })
        .some((hit) => hit.tab === tab),
    );
    assert.deepEqual(
      searchSettings(query, identity, {
        developerMode: true,
        includeDevelopmentOnly: false,
      }),
      [],
    );
  }
  assert.equal(searchSettings("settings", identity, { limit: 2 }).length, 2);
});

test("settings routes and global search honor build visibility", () => {
  assert.match(settingsPage, /const includeDevelopmentOnly = import\.meta\.env\.DEV/);
  assert.match(settingsPage, /visibleSettingsNav\(developerMode, includeDevelopmentOnly\)/);
  assert.match(settingsPage, /isSettingsDestinationHidden\([\s\S]*includeDevelopmentOnly/);
  assert.match(settingsPage, /setSettingsTab\("general"\)/);
  assert.match(settingsPage, /tab === "sync" && !tabHidden && <ConfigSyncPage \/>/);
  assert.match(settingsPage, /tab === "remoteHosts" && !tabHidden && <RemoteHostsPage \/>/);
  assert.match(searchDialog, /includeDevelopmentOnly: import\.meta\.env\.DEV/);
});
