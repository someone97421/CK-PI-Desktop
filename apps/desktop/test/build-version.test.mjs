import assert from "node:assert/strict";
import test from "node:test";
import { buildStamp } from "../../../scripts/prepare-build.mjs";
import { displayAppVersion } from "../../../packages/shared/src/app-version.ts";

test("北京时间构建版本无损往返，数值段满足 Windows 上限", () => {
  for (const [time, visible, numeric] of [
    ["2026-09-16T14:30:45Z", "20260916-223045", "2609.1622.3045"],
    ["2026-09-16T16:00:00Z", "20260917-000000", "2609.1700.0"],
    ["2026-12-31T16:00:01Z", "20270101-000001", "2701.100.1"],
  ]) {
    const stamp = buildStamp(time);
    assert.equal(stamp.displayVersion, visible);
    assert.equal(stamp.version, numeric);
    assert.equal(displayAppVersion(stamp.version), visible);
    assert.ok(stamp.version.split(".").every((part) => Number(part) <= 65535));
  }
});

test("跨秒、跨日和跨年时版本递增，旧语义版本仍原样显示", () => {
  const numeric = (value) => buildStamp(value).version.split(".").map(Number);
  for (const [left, right] of [
    ["2026-09-16T14:30:45Z", "2026-09-16T14:30:46Z"],
    ["2026-09-16T15:59:59Z", "2026-09-16T16:00:00Z"],
    ["2026-12-31T15:59:59Z", "2026-12-31T16:00:00Z"],
  ]) {
    const a = numeric(left); const b = numeric(right);
    const changed = a.findIndex((value, index) => value !== b[index]);
    assert.ok(changed >= 0 && a[changed] < b[changed]);
  }
  assert.equal(displayAppVersion("0.14.8-native.1"), "0.14.8-native.1");
  assert.throws(() => buildStamp("invalid"));
  assert.throws(() => buildStamp("2026-09-16T22:30:45"));
});
