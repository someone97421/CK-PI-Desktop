"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { cropImageRegion } = require("../image-region");

const item = { type: "image", mimeType: "image/png", data: "YWJj" };

function headerPng(width, height) {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

function nativeFixture(width, height, behavior = {}) {
  const calls = [];
  const source = {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    crop(region) {
      calls.push(region);
      if (behavior.throwCrop) throw new Error("native crop unavailable");
      return {
        isEmpty: () => false,
        toPNG: () => headerPng(region.width, region.height),
      };
    },
  };
  return { calls, nativeImage: { createFromBuffer: () => source } };
}

function helperResult(sourceWidth, sourceHeight, region, overrides = {}) {
  const png = headerPng(region.width, region.height).toString("base64");
  return { status: 0, stdout: JSON.stringify({ ok: true, sourceWidth, sourceHeight, ...region, png, ...overrides }), stderr: "" };
}

function bmp24(width, height) {
  const rowBytes = Math.ceil(width * 3 / 4) * 4;
  const pixels = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const diskY = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const offset = diskY * rowBytes + x * 3;
      pixels[offset] = 10 + x + y;
      pixels[offset + 1] = 30 + y * 40;
      pixels[offset + 2] = 20 + x * 40;
    }
  }
  const out = Buffer.alloc(54 + pixels.length);
  out.write("BM", 0, "ascii");
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(pixels.length, 34);
  pixels.copy(out, 54);
  return out;
}

test("Electron crops source pixels and reports an honest clipped intersection", () => {
  const native = nativeFixture(10, 10);
  const result = cropImageRegion(item, { x: 7, y: 8, width: 5, height: 7 }, {
    nativeImage: native.nativeImage,
    platform: "linux",
  });
  assert.equal(result.ok, true);
  assert.equal(result.diagnostic.backend, "electron");
  assert.deepEqual(result.diagnostic.source, { width: 10, height: 10 });
  assert.deepEqual(result.image.region, { x: 7, y: 8, width: 3, height: 2 });
  assert.equal(result.diagnostic.clipped, true);
  assert.deepEqual(native.calls, [{ x: 7, y: 8, width: 3, height: 2 }]);
});

test("Electron failure falls back to bounded PowerShell invocation", () => {
  const native = nativeFixture(4, 4, { throwCrop: true });
  let invocation;
  const result = cropImageRegion(item, { x: 1, y: 1, width: 2, height: 2 }, {
    nativeImage: native.nativeImage,
    platform: "win32",
    env: { PI_SCRATCH_DIR: "C:\\scratch" },
    spawnSync(exe, args, options) {
      invocation = { exe, args, options };
      return helperResult(4, 4, { x: 1, y: 1, width: 2, height: 2 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.diagnostic.backend, "powershell");
  assert.deepEqual(result.diagnostic.attempts.map((entry) => entry.code), ["electron_crop_failed", "cropped"]);
  assert.equal(invocation.exe, "powershell.exe");
  assert.equal(invocation.options.timeout, 8000);
  assert.equal(invocation.options.maxBuffer, 4 * 1024 * 1024);
  assert.equal(invocation.options.input, item.data);
  assert.equal(invocation.options.env.TEMP, "C:\\scratch");
  assert.equal(invocation.options.env.TMP, "C:\\scratch");
  assert.deepEqual(invocation.args.slice(-8), ["-X", "1", "-Y", "1", "-Width", "2", "-Height", "2"]);
});

test("invalid image and region values are rejected before either backend", () => {
  let calls = 0;
  const options = { platform: "win32", nativeImage: { createFromBuffer() { calls++; } }, spawnSync() { calls++; } };
  assert.equal(cropImageRegion({ data: "not base64!" }, { x: 0, y: 0, width: 1, height: 1 }, options).diagnostic.code, "invalid_image");
  for (const region of [
    { x: "0", y: 0, width: 1, height: 1 },
    { x: NaN, y: 0, width: 1, height: 1 },
    { x: -1, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 },
  ]) assert.equal(cropImageRegion(item, region, options).diagnostic.code, "invalid_region");
  assert.equal(calls, 0);
});

test("an origin outside the source is rejected instead of shifted", () => {
  const native = nativeFixture(4, 4);
  const result = cropImageRegion(item, { x: 4, y: 1, width: 2, height: 2 }, {
    nativeImage: native.nativeImage,
    platform: "win32",
    spawnSync() { throw new Error("fallback must not run"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostic.code, "region_out_of_bounds");
  assert.equal(native.calls.length, 0);
});

test("non-Windows without Electron reports unsupported", () => {
  const result = cropImageRegion(item, { x: 0, y: 0, width: 1, height: 1 }, {
    nativeImage: null,
    platform: "darwin",
  });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostic.code, "platform_unsupported");
  assert.deepEqual(result.diagnostic.attempts.map((entry) => entry.code), ["electron_unavailable", "platform_unsupported"]);
});

test("PowerShell timeout is classified and diagnostic errors stay bounded", () => {
  const error = new Error("timeout\n" + "x".repeat(1000));
  error.code = "ETIMEDOUT";
  const result = cropImageRegion(item, { x: 0, y: 0, width: 1, height: 1 }, {
    nativeImage: null,
    platform: "win32",
    spawnSync: () => ({ error, status: null, stdout: "", stderr: "" }),
  });
  assert.equal(result.diagnostic.code, "helper_timeout");
  assert.ok(result.diagnostic.error.length <= 240);
  assert.doesNotMatch(JSON.stringify(result.diagnostic), /YWJj/);
});

for (const [name, child, code] of [
  ["invalid JSON", { status: 0, stdout: "not-json", stderr: "" }, "helper_invalid_result"],
  ["nonzero exit", { status: 7, stdout: "", stderr: "failure" }, "helper_failed"],
]) {
  test(`PowerShell ${name} is classified`, () => {
    const result = cropImageRegion(item, { x: 0, y: 0, width: 1, height: 1 }, {
      nativeImage: null, platform: "win32", spawnSync: () => child,
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostic.code, code);
  });
}

test("PowerShell output must match the requested intersection and PNG dimensions", () => {
  const result = cropImageRegion(item, { x: 2, y: 2, width: 8, height: 8 }, {
    nativeImage: null,
    platform: "win32",
    spawnSync: () => helperResult(4, 4, { x: 2, y: 2, width: 2, height: 2 }, { width: 1 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.diagnostic.code, "helper_invalid_result");
});

test("real Windows System.Drawing helper crops deterministic pixels headlessly", { skip: process.platform !== "win32" }, () => {
  const source = bmp24(4, 4);
  const scratch = process.env.PI_SCRATCH_DIR || process.env.TEMP;
  const result = cropImageRegion({ type: "image", mimeType: "image/bmp", data: source.toString("base64") },
    { x: 1, y: 1, width: 10, height: 2 }, {
      nativeImage: null,
      platform: "win32",
      env: { PI_SCRATCH_DIR: scratch },
    });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostic));
  assert.equal(result.diagnostic.backend, "powershell");
  assert.deepEqual(result.image.region, { x: 1, y: 1, width: 3, height: 2 });

  const inspect = [
    "Add-Type -AssemblyName System.Drawing",
    "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd())",
    "$m=New-Object System.IO.MemoryStream(,$b)",
    "$i=[System.Drawing.Bitmap]::FromStream($m)",
    "$p=$i.GetPixel(0,0)",
    "[pscustomobject]@{width=$i.Width;height=$i.Height;r=$p.R;g=$p.G;b=$p.B}|ConvertTo-Json -Compress",
    "$i.Dispose();$m.Dispose()",
  ].join(";");
  const checked = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", inspect], {
    input: result.image.data,
    encoding: "utf8",
    timeout: 8000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, TEMP: scratch, TMP: scratch },
  });
  assert.equal(checked.status, 0, String(checked.stderr).slice(0, 240));
  assert.deepEqual(JSON.parse(checked.stdout.trim()), { width: 3, height: 2, r: 60, g: 70, b: 12 });
});

test("explicit helper temp directory wins over inherited scratch and normalizes all temp variables", () => {
  for (const env of [
    { TEMP: "D:\\project\\Temp", PI_SCRATCH_DIR: "C:\\other-scratch" },
    { tempDir: "D:\\project\\Temp", TEMP: "C:\\other-temp" },
    { TMPDIR: "D:\\project\\Temp" },
  ]) {
    let received;
    const region = { x: 0, y: 0, width: 2, height: 2 };
    const result = cropImageRegion(item, region, { nativeImage: null, platform: "win32", env,
      spawnSync(exe, args, options) { received = options.env; return helperResult(4, 4, region); } });
    assert.equal(result.ok, true);
    for (const key of ["TEMP", "TMP", "TMPDIR"]) assert.equal(received[key], "D:\\project\\Temp");
  }
});

test("crop helper refuses inherited system temp when no safe directory is configured", () => {
  const previous = process.env.PI_SCRATCH_DIR;
  delete process.env.PI_SCRATCH_DIR;
  try {
    let calls = 0;
    const result = cropImageRegion(item, { x: 0, y: 0, width: 2, height: 2 }, {
      nativeImage: null, platform: "win32", spawnSync() { calls++; },
    });
    assert.equal(result.diagnostic.code, "safe_temp_unavailable");
    assert.equal(calls, 0);
  } finally {
    if (previous !== undefined) process.env.PI_SCRATCH_DIR = previous;
  }
});
