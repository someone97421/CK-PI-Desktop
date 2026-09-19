"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync: defaultSpawnSync } = require("node:child_process");

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_PNG_BYTES = 3 * 1024 * 1024;
const MAX_DIMENSION = 32768;
const MAX_PIXELS = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_INT32 = 0x7fffffff;

function shortMessage(value) {
  const text = value && value.message ? value.message : value;
  return String(text || "unknown error").replace(/[\r\n\t]+/g, " ").slice(0, 240);
}

function attempt(backend, code, error) {
  return { backend, code, ...(error ? { error: shortMessage(error) } : {}) };
}

function failure(code, backend, attempts, error, extra = {}) {
  const errors = attempts.filter((entry) => entry.error).slice(-4)
    .map((entry) => ({ backend: entry.backend, code: entry.code, message: entry.error }));
  return {
    ok: false,
    diagnostic: {
      code,
      backend,
      ...extra,
      attempts: attempts.map(({ backend: name, code: value }) => ({ backend: name, code: value })),
      ...(error ? { error: shortMessage(error) } : {}),
      ...(errors.length ? { errors } : {}),
    },
  };
}

function parseInput(item) {
  if (!item || typeof item !== "object" || typeof item.data !== "string" || !item.data.length) {
    return { error: "image data must be a non-empty base64 string" };
  }
  const data = item.data;
  if (data.length > Math.ceil(MAX_INPUT_BYTES / 3) * 4 + 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    return { error: "image data is invalid base64 or exceeds the input limit" };
  }
  const buffer = Buffer.from(data, "base64");
  if (!buffer.length || buffer.length > MAX_INPUT_BYTES) {
    return { error: "decoded image is empty or exceeds the 16 MiB input limit" };
  }
  return { data, buffer };
}

function parseRegion(region) {
  if (!region || typeof region !== "object") return null;
  const fields = [region.x, region.y, region.width, region.height];
  if (!fields.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  if (region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0) return null;
  const rounded = {
    x: Math.round(region.x),
    y: Math.round(region.y),
    width: Math.round(region.width),
    height: Math.round(region.height),
  };
  if (rounded.width < 1 || rounded.height < 1 ||
      Object.values(rounded).some((value) => value > MAX_INT32)) return null;
  return rounded;
}

function validDimensions(width, height) {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
    width <= MAX_DIMENSION && height <= MAX_DIMENSION && width * height <= MAX_PIXELS;
}

function intersect(region, width, height) {
  if (region.x >= width || region.y >= height) return null;
  return {
    x: region.x,
    y: region.y,
    width: Math.min(region.width, width - region.x),
    height: Math.min(region.height, height - region.y),
  };
}

function pngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 ||
      !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return validDimensions(width, height) ? { width, height } : null;
}

function sameRegion(left, right) {
  return left && right && left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

function success(png, backend, source, requestedRegion, appliedRegion, attempts) {
  const data = png.toString("base64");
  return {
    ok: true,
    image: { type: "image", mimeType: "image/png", data, region: appliedRegion },
    diagnostic: {
      code: "cropped",
      backend,
      source,
      requestedRegion,
      appliedRegion,
      clipped: !sameRegion(requestedRegion, appliedRegion),
      attempts: [...attempts, { backend, code: "cropped" }]
        .map(({ backend: name, code }) => ({ backend: name, code })),
    },
  };
}

function getNativeImage(options) {
  if (Object.prototype.hasOwnProperty.call(options, "nativeImage")) return options.nativeImage;
  const loader = typeof options.requireElectron === "function" ? options.requireElectron : require;
  return loader("electron").nativeImage;
}

function tryElectron(buffer, region, options, attempts) {
  let nativeImage;
  try {
    nativeImage = getNativeImage(options);
  } catch (error) {
    attempts.push(attempt("electron", "electron_unavailable", error));
    return null;
  }
  if (!nativeImage || typeof nativeImage.createFromBuffer !== "function") {
    attempts.push(attempt("electron", "electron_unavailable"));
    return null;
  }
  try {
    const image = nativeImage.createFromBuffer(buffer);
    if (!image || typeof image.isEmpty !== "function" || image.isEmpty()) {
      attempts.push(attempt("electron", "invalid_image", "Electron could not decode the image"));
      return null;
    }
    const size = typeof image.getSize === "function" ? image.getSize() : null;
    const width = size && size.width;
    const height = size && size.height;
    if (!validDimensions(width, height)) {
      const excessive = Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0;
      const code = excessive ? "image_too_large" : "invalid_image";
      attempts.push(attempt("electron", code, "invalid or excessive source dimensions"));
      return { terminal: failure(code, "electron", attempts, null, { source: { width: width || 0, height: height || 0 } }) };
    }
    const source = { width, height };
    const applied = intersect(region, width, height);
    if (!applied) {
      attempts.push(attempt("electron", "region_out_of_bounds"));
      return { terminal: failure("region_out_of_bounds", "electron", attempts, null, { source, requestedRegion: region }) };
    }
    const cropped = image.crop(applied);
    if (!cropped || typeof cropped.isEmpty !== "function" || cropped.isEmpty() || typeof cropped.toPNG !== "function") {
      attempts.push(attempt("electron", "electron_crop_failed", "Electron returned an empty crop"));
      return null;
    }
    const png = cropped.toPNG();
    const dimensions = pngDimensions(png);
    if (!dimensions || dimensions.width !== applied.width || dimensions.height !== applied.height) {
      attempts.push(attempt("electron", "electron_crop_failed", "Electron returned mismatched PNG dimensions"));
      return null;
    }
    if (png.length > MAX_PNG_BYTES) {
      attempts.push(attempt("electron", "output_too_large", "cropped PNG exceeds the output limit"));
      return null;
    }
    return { terminal: success(png, "electron", source, region, applied, attempts) };
  } catch (error) {
    attempts.push(attempt("electron", "electron_crop_failed", error));
    return null;
  }
}

function helperEnvironment(options) {
  const explicit = options.env || {};
  const env = { ...process.env, ...explicit };
  const scratch = explicit.tempDir || explicit.TEMP || explicit.TMPDIR || explicit.TMP ||
    explicit.PI_SCRATCH_DIR || process.env.PI_SCRATCH_DIR;
  if (!scratch) return null;
  env.TEMP = scratch;
  env.TMP = scratch;
  env.TMPDIR = scratch;
  return env;
}

function runPowerShell(data, region, options, attempts) {
  const scriptPath = options.scriptPath || path.join(__dirname, "scripts", "windows-crop.ps1");
  if (!fs.existsSync(scriptPath)) {
    attempts.push(attempt("powershell", "helper_unavailable", "crop helper script is missing"));
    return failure("helper_unavailable", "powershell", attempts);
  }
  const env = helperEnvironment(options);
  if (!env) {
    attempts.push(attempt("powershell", "safe_temp_unavailable"));
    return failure("safe_temp_unavailable", "powershell", attempts);
  }
  const spawnSync = options.spawnSync || defaultSpawnSync;
  const timeout = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.min(DEFAULT_TIMEOUT_MS, Math.round(options.timeoutMs))) : DEFAULT_TIMEOUT_MS;
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
    "-X", String(region.x), "-Y", String(region.y), "-Width", String(region.width), "-Height", String(region.height)];
  let child;
  try {
    child = spawnSync(options.powershellExe || "powershell.exe", args, {
      input: data,
      encoding: "utf8",
      timeout,
      maxBuffer: MAX_STDOUT_BYTES,
      windowsHide: true,
      env,
    });
  } catch (error) {
    attempts.push(attempt("powershell", "helper_failed", error));
    return failure("helper_failed", "powershell", attempts, error);
  }
  if (child && child.error) {
    const code = child.error.code === "ETIMEDOUT" || child.signal === "SIGTERM" ? "helper_timeout" :
      child.error.code === "ENOBUFS" ? "helper_output_too_large" : "helper_failed";
    attempts.push(attempt("powershell", code, child.error));
    return failure(code, "powershell", attempts, child.error);
  }
  const stdout = String((child && child.stdout) || "");
  const stderr = String((child && child.stderr) || "");
  if (Buffer.byteLength(stdout, "utf8") > MAX_STDOUT_BYTES) {
    attempts.push(attempt("powershell", "helper_output_too_large"));
    return failure("helper_output_too_large", "powershell", attempts);
  }
  if (!child || child.status !== 0) {
    const detail = stderr ? `helper exit ${child && child.status}: ${shortMessage(stderr)}` : `helper exit ${child && child.status}`;
    attempts.push(attempt("powershell", "helper_failed", detail));
    return failure("helper_failed", "powershell", attempts, detail);
  }
  let result;
  try {
    result = JSON.parse(stdout.trim());
  } catch {
    attempts.push(attempt("powershell", "helper_invalid_result", "helper stdout was not JSON"));
    return failure("helper_invalid_result", "powershell", attempts);
  }
  if (!result || typeof result !== "object" || result.ok !== true) {
    const allowed = new Set(["invalid_image", "image_too_large", "output_too_large", "region_out_of_bounds", "invalid_region"]);
    const code = result && allowed.has(result.code) ? result.code : "helper_failed";
    const detail = result && (result.error || result.code);
    attempts.push(attempt("powershell", code, detail));
    const source = result && validDimensions(result.sourceWidth, result.sourceHeight)
      ? { source: { width: result.sourceWidth, height: result.sourceHeight }, requestedRegion: region } : {};
    return failure(code, "powershell", attempts, detail, source);
  }
  const sourceWidth = result.sourceWidth;
  const sourceHeight = result.sourceHeight;
  if (!validDimensions(sourceWidth, sourceHeight)) {
    attempts.push(attempt("powershell", "helper_invalid_result", "helper returned invalid source dimensions"));
    return failure("helper_invalid_result", "powershell", attempts);
  }
  const source = { width: sourceWidth, height: sourceHeight };
  const expected = intersect(region, sourceWidth, sourceHeight);
  const applied = { x: result.x, y: result.y, width: result.width, height: result.height };
  if (!expected || !Object.values(applied).every(Number.isInteger) || !sameRegion(expected, applied) || typeof result.png !== "string") {
    attempts.push(attempt("powershell", "helper_invalid_result", "helper returned a crop inconsistent with the request"));
    return failure("helper_invalid_result", "powershell", attempts, null, { source, requestedRegion: region });
  }
  if (result.png.length > Math.ceil(MAX_PNG_BYTES / 3) * 4 + 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.png)) {
    attempts.push(attempt("powershell", "helper_invalid_result", "helper returned invalid or excessive PNG data"));
    return failure("helper_invalid_result", "powershell", attempts);
  }
  const png = Buffer.from(result.png, "base64");
  const dimensions = pngDimensions(png);
  if (!dimensions || dimensions.width !== expected.width || dimensions.height !== expected.height) {
    attempts.push(attempt("powershell", "helper_invalid_result", "helper PNG dimensions do not match its crop"));
    return failure("helper_invalid_result", "powershell", attempts, null, { source, requestedRegion: region });
  }
  return success(png, "powershell", source, region, expected, attempts);
}

/** Crop source-image pixel coordinates without scaling them to any attached thumbnail. */
function cropImageRegion(item, region, options = {}) {
  const parsed = parseInput(item);
  if (parsed.error) return failure("invalid_image", "none", [], parsed.error);
  const requested = parseRegion(region);
  if (!requested) return failure("invalid_region", "none", [], "region requires finite non-negative numeric x/y and positive width/height");

  const attempts = [];
  const electron = tryElectron(parsed.buffer, requested, options, attempts);
  if (electron && electron.terminal) return electron.terminal;

  const platform = options.platform || process.platform;
  if (platform !== "win32") {
    const last = attempts[attempts.length - 1];
    if (last && last.code !== "electron_unavailable") {
      return failure(last.code, "electron", attempts, last.error, { requestedRegion: requested });
    }
    attempts.push(attempt("none", "platform_unsupported"));
    return failure("platform_unsupported", "none", attempts,
      "PowerShell crop fallback is available only on Windows", { requestedRegion: requested });
  }
  return runPowerShell(parsed.data, requested, options, attempts);
}

module.exports = { cropImageRegion };
