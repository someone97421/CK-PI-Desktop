import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { formatSessionLastReplyDate } from "../src/lib/sidebar-session-date.ts";

const sidebarSource = await readFile(
  new URL("../src/components/Sidebar.tsx", import.meta.url),
  "utf8",
);
const sidebarStyles = await Promise.all([
  readFile(new URL("../src/styles/sidebar-threads.css", import.meta.url), "utf8"),
  readFile(new URL("../src/styles/sessions.css", import.meta.url), "utf8"),
]).then((styles) => styles.join("\n"));

test("formats session activity with minute, half-hour, hour and day tiers", () => {
  const now = new Date("2026-10-16T00:05:00+08:00");
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const cases = [
    [-minute, "刚刚"],
    [0, "刚刚"],
    [minute - 1, "刚刚"],
    [minute, "1分钟前"],
    [30 * minute - 1, "29分钟前"],
    [30 * minute, "半小时前"],
    [hour - 1, "半小时前"],
    [hour, "1小时前"],
    [day - 1, "23小时前"],
    [day, "1天前"],
    [31 * day - 1, "30天前"],
    [31 * day, "很久以前"],
  ];
  for (const [elapsed, expected] of cases) {
    const timestamp = new Date(now.getTime() - elapsed).toISOString();
    assert.equal(formatSessionLastReplyDate(timestamp, now, "zh-CN"), expected);
  }

  assert.equal(formatSessionLastReplyDate(now.toISOString(), now, "en"), "Just now");
  assert.equal(
    formatSessionLastReplyDate(new Date(now.getTime() - 30 * minute).toISOString(), now, "en"),
    "Half an hour ago",
  );
  assert.equal(
    formatSessionLastReplyDate(new Date(now.getTime() - 31 * day).toISOString(), now, "en"),
    "A long time ago",
  );
});

test("invalid timestamps do not render a misleading date", () => {
  assert.equal(formatSessionLastReplyDate(undefined), "");
  assert.equal(formatSessionLastReplyDate("not-a-date"), "");
});

test("project session rows show the date until hover or focus reveals actions", () => {
  assert.match(sidebarSource, /sidebarSessionTime !== false/);
  assert.match(sidebarSource, /className=\{cx\([\s\S]*?"thread-item-meta"[\s\S]*?sessionMenu === session\.id/);
  assert.match(sidebarSource, /className="thread-item-last-reply"/);
  assert.match(
    sidebarStyles,
    /\.thread-item:hover \.thread-item-last-reply,[\s\S]*?\.thread-item:focus-within \.thread-item-last-reply\s*\{\s*opacity:\s*0;\s*visibility:\s*hidden;/,
  );
  assert.match(
    sidebarStyles,
    /\.thread-item:hover \.thread-item-more[\s\S]*?\.thread-item:focus-within \.thread-item-more[\s\S]*?opacity:\s*1;/,
  );
});
