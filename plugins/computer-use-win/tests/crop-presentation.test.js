"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const runtimePath = path.join(__dirname, "..", "runtime.js");
function image(width, height) {
  const data = Buffer.alloc(24); data[0] = 0x89; data[1] = 0x50;
  data.writeUInt32BE(width, 16); data.writeUInt32BE(height, 20);
  return { type: "image", mimeType: "image/png", data: data.toString("base64") };
}
function fixture(cropResult, fixtureOptions = {}) {
  const calls = [];
  const resolverCalls = [];
  const sandbox = { module: { exports: {} }, Buffer, console, setTimeout, clearTimeout,
    __dirname: path.dirname(runtimePath), process: { platform: fixtureOptions.platform || "linux", env: {} },
    require(name) {
      if (name === "./powershell") return { resolvePowerShell(options) {
        resolverCalls.push(options);
        return "C:\\mock\\pwsh.exe";
      } };
      if (name === "./image-region") return { cropImageRegion(item, region, options) { calls.push({ item, region, options }); return cropResult; } };
      if (name === "./overlay") return { ControlBanner: class {} };
      if (name === "./cua") return {};
      if (name === "./policy") return require("../policy");
      if (name === "electron") throw new Error("no Electron in test host");
      if (name === "node:child_process" && fixtureOptions.platform === "win32") return {
        spawn() { throw new Error("unexpected spawn"); },
        spawnSync() { return { status: 0, stdout: JSON.stringify({ ok: true, jpeg: "YQ==" }), stderr: "" }; },
      };
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(runtimePath, "utf8"), sandbox, { filename: runtimePath });
  return { present: sandbox.module.exports.presentResult, calls, resolverCalls };
}
const region = { x: 20, y: 30, width: 40, height: 50 };
const result = { content: [{ type: "text", text: "state" }, image(1280, 805)],
  structuredContent: { action_result: { goal: "unconfirmed", delivery: "unknown" } } };
test("successful crop attaches detail mapping and keeps original result evidence", () => {
  const f = fixture({ ok: true, image: { ...image(40, 50), region }, diagnostic: { code: "cropped", backend: "powershell" } });
  const output = f.present(result, { observe: true, region });
  assert.equal(f.calls.length, 1);
  assert.equal(output.images.length, 2);
  assert.equal(output.structuredContent.region_crop.backend, "powershell");
  assert.deepEqual(JSON.parse(JSON.stringify(output.structuredContent.region_crop.detail_mapping)), {
    origin_x: 20, origin_y: 30, source_width: 40, source_height: 50, attached_width: 40, attached_height: 50,
  });
  assert.equal(output.structuredContent.action_result.goal, "unconfirmed");
  assert.match(output.text, /adding its x\/y origin/);
});
test("crop failure preserves full image with exact backend diagnostic", () => {
  const f = fixture({ ok: false, diagnostic: { code: "helper_timeout", backend: "powershell" } });
  const output = f.present(result, { observe: true, region });
  assert.equal(output.images.length, 1);
  assert.equal(output.structuredContent.region_crop.code, "helper_timeout");
  assert.match(output.text, /helper_timeout/);
});
test("invalid crop request is reported without invoking backend", () => {
  const f = fixture();
  const output = f.present(result, { observe: true, region: { ...region, width: -1 } });
  assert.equal(f.calls.length, 0);
  assert.equal(output.structuredContent.region_crop.code, "invalid_region");
});
test("crop backend receives the explicit runtime helper environment", () => {
  const f = fixture({ ok: false, diagnostic: { code: "helper_timeout", backend: "powershell" } });
  const env = { TEMP: "D:\\project\\Temp", TMP: "D:\\project\\Temp" };
  f.present(result, { observe: true, region, env });
  assert.equal(f.calls[0].options.env, env);
});
test("presentation forwards helper environment to crop and every PowerShell compression", () => {
  const f = fixture({ ok: false, diagnostic: { code: "helper_timeout", backend: "powershell" } }, { platform: "win32" });
  const env = { TEMP: "D:\\project\\Temp", powershellExe: "C:\\env host\\pwsh.exe" };
  const output = f.present(result, { observe: true, region, env });
  assert.equal(f.calls[0].options.env, env);
  assert.equal(output.images[0].data, "YQ==");
  assert.ok(f.resolverCalls.length >= 1);
  assert.ok(f.resolverCalls.every((options) => options.env === env && options.powershellExe === env.powershellExe));
});
test("missing, null and coercible region fields are not silently converted", () => {
  const f = fixture();
  for (const x of [undefined, null, "", "20", false]) {
    const output = f.present(result, { observe: true, region: { ...region, x } });
    assert.equal(output.structuredContent.region_crop.code, "invalid_region");
  }
  assert.equal(f.calls.length, 0);
});
