/**
 * Experimental settings destinations are retained in development builds but
 * omitted from packaged builds. Navigation, search, and stale-page handling
 * must all honor the same build visibility.
 */
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
const composer = readFileSync(
  new URL("../src/components/Composer.tsx", import.meta.url),
  "utf8",
);
const composerToolbar = readFileSync(
  new URL("../src/features/chat/composer/ComposerToolbar.tsx", import.meta.url),
  "utf8",
);

const identity = (key) => key;
const experimentalIds = ["sync", "remoteHosts"];

test("developer mode retains the experimental destinations in development", () => {
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
  assert.ok(visibleSettingsNav(false, false).some((entry) => entry.id === "voice"));
  assert.equal(isSettingsDestinationHidden("voice", false, false), false);
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

  for (const query of ["configSync.connectionTitle", "remotehosts"]) {
    assert.ok(
      searchSettings(query, identity, { developerMode: true })
        .some((hit) => experimentalIds.includes(hit.tab)),
    );
    assert.deepEqual(
      searchSettings(query, identity, {
        developerMode: true,
        includeDevelopmentOnly: false,
      }),
      [],
    );
  }
  assert.ok(searchSettings("liveVoice.enable", identity, {
    developerMode: false,
    includeDevelopmentOnly: false,
  }).some((hit) => hit.tab === "voice"));
  assert.equal(searchSettings("settings", identity, { limit: 2 }).length, 2);
});

test("settings routes, global search, and composer use build visibility", () => {
  assert.match(settingsPage, /const includeDevelopmentOnly = import\.meta\.env\.DEV/);
  assert.match(settingsPage, /visibleSettingsNav\(developerMode, includeDevelopmentOnly\)/);
  assert.match(settingsPage, /isSettingsDestinationHidden\([\s\S]*includeDevelopmentOnly/);
  assert.match(settingsPage, /setSettingsTab\("general"\)/);
  assert.match(settingsPage, /tab === "sync" && !tabHidden && <ConfigSyncPage \/>/);
  assert.match(settingsPage, /tab === "remoteHosts" && !tabHidden && <RemoteHostsPage \/>/);
  assert.match(searchDialog, /includeDevelopmentOnly: import\.meta\.env\.DEV/);
  assert.doesNotMatch(composer, /useVoiceInput/);
  assert.doesNotMatch(composer, /VoiceOverlay|voiceEnabled/);
  assert.match(composerToolbar, /<LiveVoiceControls t=\{t\} workSessionId=\{workSessionId\} workSessionLabel=\{workSessionLabel\} \/>/);
  assert.doesNotMatch(composerToolbar, /VoiceMicButton|voicePhase|onVoiceToggle|onVoiceCancel/);
});
