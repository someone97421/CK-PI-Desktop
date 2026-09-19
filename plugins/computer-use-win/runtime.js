"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { ControlBanner } = require("./overlay");
const { probe: probeCua, doctor: cuaDoctor } = require("./cua");
const { filterRecords, gateRecord, namesMatch, normalize } = require("./policy");

const PLUGIN_VERSION = "0.3.0";
const START_TIMEOUT_MS = 15_000;
const RPC_TIMEOUT_MS = 90_000;
const FOCUS_TIMEOUT_MS = 8_000;
const AGENT_JPEG_QUALITIES = [80, 65, 50];
const AGENT_MAX_EDGES = [0, 1280, 1024, 768];
const AGENT_MAX_B64_CHARS = 200_000;
const AGENT_KEEP_ORIGINAL_CHARS = 32_000;
const AGENT_MAX_TREE_CHARS = 16_000;
const MAX_IMAGE_DIMENSION = 1280;
const CONTROL_TOOLS = new Set([
  "get_app_state",
  "click",
  "scroll",
  "drag",
  "type_text",
  "press_key",
  "set_value",
  "perform_secondary_action",
  "paste_text",
  "launch_app",
]);

function pngSize(b64) {
  try {
    const buf = Buffer.from(String(b64 || ""), "base64");
    if (buf.length < 24) return { width: 0, height: 0 };
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    return { width: 0, height: 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

function jpegSize(b64) {
  try {
    const buf = Buffer.from(String(b64 || ""), "base64");
    if (buf.length < 10 || buf[0] !== 0xff || buf[1] !== 0xd8) return { width: 0, height: 0 };
    let i = 2;
    while (i + 8 < buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if (i + 3 >= buf.length) break;
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
    return { width: 0, height: 0 };
  } catch {
    return { width: 0, height: 0 };
  }
}

function imageSize(item) {
  if (!item || !item.data) return { width: 0, height: 0 };
  const mime = String(item.mimeType || item.mime_type || "").toLowerCase();
  if (mime.includes("jpeg") || mime.includes("jpg")) {
    const jpeg = jpegSize(item.data);
    if (jpeg.width) return jpeg;
  }
  const png = pngSize(item.data);
  if (png.width) return png;
  return jpegSize(item.data);
}

function tryCompressWithElectron(buf, options = {}) {
  try {
    const { nativeImage } = require("electron");
    const original = nativeImage.createFromBuffer(buf);
    if (!original || original.isEmpty()) return null;
    const src = original.getSize();
    if (!src.width || !src.height) return null;
    const qualities = options.qualities || AGENT_JPEG_QUALITIES;
    const maxEdges = options.maxEdges || AGENT_MAX_EDGES;
    const maxB64 = options.maxB64Chars || AGENT_MAX_B64_CHARS;
    for (const maxEdge of maxEdges) {
      let img = original;
      const edge = Math.max(src.width, src.height);
      if (maxEdge > 0 && edge > maxEdge) {
        const scale = maxEdge / edge;
        img = original.resize({
          width: Math.max(1, Math.round(src.width * scale)),
          height: Math.max(1, Math.round(src.height * scale)),
          quality: "better",
        });
      }
      for (const quality of qualities) {
        const jpeg = img.toJPEG(quality);
        const data = jpeg.toString("base64");
        if (data.length <= maxB64) {
          return { type: "image", mimeType: "image/jpeg", data };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

function tryCompressWithPowerShell(buf, options = {}) {
  if (process.platform !== "win32") return null;
  const script = path.join(__dirname, "scripts", "windows-jpeg.ps1");
  if (!fs.existsSync(script)) return null;
  const maxB64 = options.maxB64Chars || AGENT_MAX_B64_CHARS;
  const qualities = options.qualities || AGENT_JPEG_QUALITIES;
  try {
    for (const quality of qualities) {
      const result = spawnSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-MaxB64Chars",
        String(maxB64),
        "-Qualities",
        String(quality),
      ], {
        input: buf.toString("base64"),
        encoding: "utf8",
        timeout: 12000,
        windowsHide: true,
        maxBuffer: 2_000_000,
      });
      if (result.status !== 0) continue;
      const line = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop();
      if (!line) continue;
      const parsed = JSON.parse(line);
      if (!parsed || !parsed.ok || !parsed.jpeg) continue;
      const data = String(parsed.jpeg);
      if (data.length <= maxB64) return { type: "image", mimeType: "image/jpeg", data };
    }
    return null;
  } catch {
    return null;
  }
}

function compressImageForAgent(item, options = {}) {
  if (!item || !item.data) return null;
  const mime = String(item.mimeType || "image/png");
  const data = String(item.data);
  const keepOriginalChars = options.keepOriginalChars != null ? options.keepOriginalChars : AGENT_KEEP_ORIGINAL_CHARS;
  const maxB64 = options.maxB64Chars || AGENT_MAX_B64_CHARS;
  if (keepOriginalChars > 0 && data.length <= keepOriginalChars) {
    return { type: "image", mimeType: mime, data };
  }
  if ((mime === "image/jpeg" || mime === "image/jpg") && data.length <= maxB64 && !options.forceJpeg) {
    return { type: "image", mimeType: "image/jpeg", data };
  }
  const buf = Buffer.from(data, "base64");
  const compressed = tryCompressWithElectron(buf, options) || tryCompressWithPowerShell(buf, options);
  if (compressed && compressed.data.length < data.length) return compressed;
  if (data.length <= maxB64) {
    return { type: "image", mimeType: mime, data };
  }
  return compressed;
}

function parseRegion(region) {
  if (!region || typeof region !== "object") return null;
  const { x, y, width, height } = region;
  if (![x, y, width, height].every(value => typeof value === "number" && Number.isFinite(value)) ||
      x < 0 || y < 0 || width < 2 || height < 2) return null;
  return { x, y, width, height };
}


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textFromResult(result) {
  const content = Array.isArray(result && result.content) ? result.content : [];
  return content.filter((item) => item && item.type === "text").map((item) => String(item.text || "")).join("\n");
}

function imageFromResult(result) {
  const content = Array.isArray(result && result.content) ? result.content : [];
  const fromContent = content.find((item) => item && item.type === "image" && item.data);
  if (fromContent) {
    return {
      type: "image",
      mimeType: fromContent.mimeType || fromContent.mime_type || "image/png",
      data: String(fromContent.data),
    };
  }
  const structured = structuredOf(result);
  const data =
    structured.screenshot_png_b64 ||
    structured.screenshot_png_base64 ||
    structured.screenshot_base64 ||
    (typeof structured.screenshot === "string" ? structured.screenshot : null);
  if (!data) return null;
  return {
    type: "image",
    mimeType: structured.screenshot_mime_type || structured.mimeType || "image/png",
    data: String(data),
  };
}

function structuredOf(result) {
  return (result && result.structuredContent) || {};
}

function runtimeError(code, message, delivery = "unknown") {
  return { isError: true, content: [{ type: "text", text: message }], structuredContent: { code, delivery } };
}

function normalizeActionResult(result, action) {
  result = result && typeof result === "object" ? result : runtimeError("empty_result", "Empty runtime result");
  const s = structuredOf(result);
  const readOnly = !CONTROL_TOOLS.has(action) || action === "get_app_state";
  let delivery = readOnly ? "not_sent" : "unknown";
  if (!readOnly) {
    if (Number.isInteger(s.sent) && s.sent >= 0) {
      delivery = s.sent === 0 ? "not_sent"
        : Number.isInteger(s.expected) && s.expected > s.sent ? "partial"
        : s.expected === s.sent ? "sent" : "unknown";
    } else if (["sent", "not_sent", "partial", "unknown"].includes(s.delivery)) delivery = s.delivery;
    else if (s.transport_sent === true) delivery = "sent";
    else if (s.transport_sent === false) delivery = "not_sent";
  }
  // Driver verified/effect=confirmed often means Invoke succeeded, not that the
  // UI changed or the user's business goal succeeded. Never promote those flags.
  const uiChange = ["changed", "unchanged"].includes(s.ui_change) ? s.ui_change : "unknown";
  const matched = action === "get_app_state" && s.wait?.status === "matched" && Array.isArray(s.wait.evidence) && s.wait.evidence.length > 0;
  const evidence = [];
  if (Number.isInteger(s.sent)) evidence.push({ kind: "transport", sent: s.sent, expected: s.expected });
  if (uiChange !== "unknown") evidence.push({ kind: "ui_change", value: uiChange });
  if (matched) evidence.push(...s.wait.evidence);
  return { ...result, structuredContent: { ...s, action_result: {
    schema_version: 1, action, delivery, ui_change: uiChange,
    goal: matched ? "confirmed" : "unconfirmed", retry_safe: readOnly || delivery === "not_sent", evidence,
  } } };
}

function validateStateArgs(args) {
  if ([false, "false"].includes(args.include_screenshot) && [false, "false"].includes(args.include_tree)) return "include_screenshot and include_tree cannot both be false";
  if (args.refresh !== undefined && typeof args.refresh !== "boolean") return "refresh must be a boolean";
  for (const [key, min, max] of [["wait_timeout_ms", 0, 30000], ["poll_interval_ms", 100, 5000]]) {
    if (args[key] !== undefined && (typeof args[key] !== "number" || !Number.isFinite(args[key]) || args[key] < min || args[key] > max)) return `${key} must be between ${min} and ${max}`;
  }
  if (args.wait_for === undefined) return null;
  const p = args.wait_for;
  if (!p || typeof p !== "object" || Array.isArray(p)) return "wait_for must be an object";
  if (Object.keys(p).some((key) => !["kind", "text", "name", "role", "value", "baseline"].includes(key))) return "unknown wait_for field";
  if (!["text_present", "text_absent", "value_equals", "value_changed"].includes(p.kind)) return "invalid wait_for.kind";
  for (const key of ["text", "name", "role", "value", "baseline"]) if (p[key] !== undefined && typeof p[key] !== "string") return `wait_for.${key} must be a string`;
  if (p.kind.startsWith("text_") && !p.text?.trim()) return "wait_for.text is required and must be nonempty";
  if (p.kind.startsWith("value_") && !p.name?.trim()) return "wait_for.name is required and must be nonempty";
  if (p.kind === "value_equals" && p.value === undefined) return "wait_for.value is required";
  if (p.kind === "value_changed" && p.baseline === undefined) return "wait_for.baseline is required";
  return null;
}

function refusalCode(result) {
  const s = structuredOf(result);
  if (s && s.refusal && typeof s.refusal.code === "string") return s.refusal.code;
  return "";
}
function captureFailed(result) {
  const s = structuredOf(result);
  return !result || result.isError || result.ok === false || s.ok === false || s.success === false
    || Boolean(s.error || s.error_code) || /^(failed|error|unavailable)$/i.test(String(s.status || s.tree_status || result.status || ""));
}

function evaluateWait(result, predicate, maxElements, maxDepth) {
  const s = structuredOf(result);
  if (captureFailed(result) || !Array.isArray(s.elements)) return { matched: false, reason: "capture_failed", evidence: [] };
  const lower = (value) => String(value ?? "").toLowerCase();
  const candidates = s.elements.filter((el) => el
    && (predicate.name === undefined || lower(el.name ?? el.label) === lower(predicate.name))
    && (predicate.role === undefined || lower(el.role) === lower(predicate.role)));
  const complete = completeFreshTree(result, maxElements, maxDepth, true);
  let matched = false;
  let hits = [];
  if (predicate.kind.startsWith("text_")) {
    hits = candidates.filter((el) => [el.name, el.label, el.text, el.value].some((v) => v != null && lower(v).includes(lower(predicate.text))));
    matched = predicate.kind === "text_present" ? hits.length > 0 : complete && hits.length === 0;
  } else {
    hits = candidates;
    matched = complete && hits.length === 1 && hits[0].value != null
      && (predicate.kind === "value_equals" ? String(hits[0].value) === predicate.value : String(hits[0].value) !== predicate.baseline);
  }
  let reason = "predicate_not_matched";
  if (matched) reason = "predicate_matched";
  else if (!complete) reason = "incomplete_tree";
  else if (predicate.kind.startsWith("value_")) {
    if (hits.length === 0) reason = "target_missing";
    else if (hits.length > 1) reason = "ambiguous_target";
    else if (hits[0].value == null) reason = "value_missing";
  }
  return { matched, reason,
    evidence: matched ? [{ kind: "wait_predicate", predicate: { ...predicate }, observation_id: s.observation_id,
      tree_version: s.tree_version, matches: hits.map((el) => ({ element_index: el.element_index, name: el.name ?? el.label, role: el.role, value: el.value })) }] : [] };
}

function observationFields(cached) {
  return Object.fromEntries(["observation_id", "image_version", "tree_version", "image_captured_at", "tree_captured_at", "tree_actionable", "pid", "window_id"].map((key) => [key, cached[key] ?? null]));
}

function observationText(cached) {
  return Object.entries(observationFields(cached)).map(([key, value]) => `${key}=${value}`).join(" ");
}
// True when a requested channel was not refreshed and its timestamp is
// inherited from an earlier capture; surfaced so a fresh image never implies
// a fresh tree (or vice versa).
function stalenessFields(state) {
  const out = {};
  if (state && state.tree_stale === true) out.tree_stale = true;
  if (state && state.image_stale === true) out.image_stale = true;
  return out;
}

function trimTreeText(text) {
  let out = String(text || "");
  if (out.length <= AGENT_MAX_TREE_CHARS) return out;
  const cut = out.slice(0, AGENT_MAX_TREE_CHARS);
  const lastNl = cut.lastIndexOf("\n");
  const omitted = out.length - AGENT_MAX_TREE_CHARS;
  return `${lastNl > 0 ? cut.slice(0, lastNl) : cut}\n... [tree truncated, ${omitted} chars omitted; use query= or include_screenshot=false]`;
}

function compactElements(elements) {
  if (!Array.isArray(elements) || !elements.length) return "";
  return elements.map((el) => {
    const idx = el.element_index != null ? el.element_index : "?";
    const role = el.role || "";
    let label = String(el.label || el.value || "");
    if (label.length > 80) label = `${label.slice(0, 77)}...`;
    const actions = Array.isArray(el.actions) && el.actions.length ? ` {${el.actions.join(",")}}` : "";
    return `[${idx}] ${role} ${label}${actions}`.trim();
  }).join("\n");
}

function elementFrame(el) {
  const f = (el && (el.frame || el.bounds || el.rect)) || {};
  const x = Number(f.x ?? f.left ?? 0);
  const y = Number(f.y ?? f.top ?? 0);
  const w = Number(f.w ?? f.width ?? 0);
  const h = Number(f.h ?? f.height ?? 0);
  if (![x, y, w, h].every(Number.isFinite) || w < 2 || h < 2) return null;
  return { x, y, w, h, area: w * h };
}

function originFromBounds(bounds) {
  if (!bounds || typeof bounds !== "object") return null;
  const x = Number(bounds.x ?? bounds.left);
  const y = Number(bounds.y ?? bounds.top);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function localizeElements(elements, origin) {
  if (!Array.isArray(elements)) return [];
  if (!origin) return elements;
  return elements.map((el) => {
    const f = elementFrame(el);
    if (!f) return el;
    return { ...el, frame: { x: f.x - origin.x, y: f.y - origin.y, w: f.w, h: f.h } };
  });
}

function mergeTreeCache(prev, incoming, opts = {}) {
  const hasPrev = Array.isArray(prev && prev.elements) && prev.elements.length > 0;
  if (opts.query && hasPrev) {
    return { elements: prev.elements, snapshot_id: prev.snapshot_id, kept: true };
  }
  if (opts.includeTree === false && hasPrev) {
    return { elements: prev.elements, snapshot_id: opts.snapshotId || prev.snapshot_id, kept: true };
  }
  return {
    elements: localizeElements(incoming, opts.origin),
    snapshot_id: opts.snapshotId,
    kept: false,
  };
}

function filterElements(elements, query) {
  if (!Array.isArray(elements)) return [];
  const q = String(query || "").trim().toLowerCase();
  if (!q) return elements;
  return elements.filter((el) => {
    if (!el) return false;
    const blob = `${el.role || ""} ${el.label || ""} ${el.value || ""} ${el.name || ""}`.toLowerCase();
    return blob.includes(q);
  });
}

const AX_CLICK_ROLES = new Set([
  "button",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tabitem",
  "tab",
  "checkbox",
  "radiobutton",
  "radio",
  "hyperlink",
  "link",
  "splitbutton",
  "combobox",
]);

const AX_CLICK_SKIP = new Set([
  "document",
  "pane",
  "list",
  "window",
  "titlebar",
  "scrollbar",
  "thumb",
  "separator",
  "image",
  "group",
  "custom",
  "datagrid",
  "table",
  "text",
  "edit",
  "editor",
  "documenttext",
]);

function shouldUpgradePixelToAx(el) {
  if (!el) return false;
  const role = String(el.role || "").toLowerCase();
  if (AX_CLICK_SKIP.has(role)) return false;
  if (AX_CLICK_ROLES.has(role)) return true;
  const actions = Array.isArray(el.actions) ? el.actions.map((item) => String(item).toLowerCase()) : [];
  return actions.includes("invoke") || actions.includes("select") || actions.includes("toggle");
}

function hitTestElement(elements, x, y) {
  if (!Array.isArray(elements) || !elements.length) return null;
  const px = Number(x);
  const py = Number(y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  let best = null;
  let bestArea = Infinity;
  for (const el of elements) {
    if (!el || el.enabled === false) continue;
    const frame = elementFrame(el);
    if (!frame) continue;
    if (px < frame.x || py < frame.y || px > frame.x + frame.w || py > frame.y + frame.h) continue;
    const role = String(el.role || "").toLowerCase();
    if (AX_CLICK_SKIP.has(role)) continue;
    if (frame.area < bestArea) {
      bestArea = frame.area;
      best = el;
    }
  }
  return best;
}

function describeHit(el, via) {
  if (!el) return via === "pixel" ? "hit=none (pixel)" : "";
  const role = el.role || "";
  let label = String(el.label || el.value || "");
  if (label.length > 60) label = `${label.slice(0, 57)}...`;
  const idx = el.element_index != null ? el.element_index : "?";
  return `hit=[${idx}] ${role} ${label} via=${via || "ax"}`.trim();
}

function annotateHit(result, el, via) {
  const desc = describeHit(el, via);
  if (!desc || !result || typeof result !== "object") return result;
  const content = Array.isArray(result.content) ? result.content.map((item) => ({ ...item })) : [];
  const textItem = content.find((item) => item && item.type === "text");
  if (textItem) textItem.text = `${String(textItem.text || "").trim()}. ${desc}`;
  else content.unshift({ type: "text", text: desc });
  return { ...result, content };
}

const EDIT_ROLES = new Set([
  "document",
  "edit",
  "editor",
  "text",
  "textbox",
  "documenttext",
  "richedit",
  "combobox",
]);
const SKIP_EDIT_ROLES = new Set([
  "button",
  "menu",
  "menuitem",
  "menubar",
  "tab",
  "toolbar",
  "titlebar",
  "image",
  "scrollbar",
  "thumb",
  "separator",
  "hyperlink",
  "link",
]);

function pickEditableElement(elements) {
  if (!Array.isArray(elements) || !elements.length) return null;
  let best = null;
  let bestScore = 0;
  for (const el of elements) {
    if (!el || el.element_index == null || el.enabled === false) continue;
    const role = String(el.role || "").toLowerCase();
    const label = String(el.label || "").toLowerCase();
    const actions = Array.isArray(el.actions) ? el.actions.map((item) => String(item).toLowerCase()) : [];
    let score = 0;
    if (el.has_keyboard_focus || el.focused || el.keyboard_focus) score += 50;
    if (EDIT_ROLES.has(role)) score += 30;
    if (actions.some((item) => item.includes("setvalue") || item === "value" || item.includes("text"))) score += 20;
    if (/document|editor|text editor|contents|rich text/.test(label)) score += 15;
    if (SKIP_EDIT_ROLES.has(role)) score -= 50;
    const frame = el.frame || {};
    const width = Number(frame.w || frame.width || 0);
    const height = Number(frame.h || frame.height || 0);
    if (width > 0 && height > 0) score += Math.min(25, Math.floor((width * height) / 40000));
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return bestScore >= 20 ? best : null;
}

function isTypeIndexError(result) {
  const text = `${textFromResult(result)}\n${JSON.stringify(structuredOf(result))}`;
  return /element_index/i.test(text) && /xaml|winui|uwp|valuepattern|setvalue|requires? element/i.test(text);
}

function isBackgroundUnavailable(result) {
  const structured = structuredOf(result);
  const code = String(structured.code || structured.error_code || structured.error || "");
  const rec = structured.escalation && structured.escalation.recommended
    ? String(structured.escalation.recommended)
    : "";
  const text = `${textFromResult(result)}\n${JSON.stringify(structured)}`;
  const blob = `${code}\n${rec}\n${text}`;
  if (/background_unavailable/i.test(blob)) return true;
  if (/background coordinate injection cannot reach/i.test(blob)) return true;
  if (/coordinate injection cannot reach this target/i.test(blob)) return true;
  if (/cannot reach this target/i.test(blob) && /background|foreground|occlud/i.test(blob)) return true;
  if (/escalate to delivery_mode/i.test(blob)) return true;
  if (/occlud/i.test(blob) && /background/i.test(blob)) return true;
  if (/^foreground$/i.test(rec.trim())) return true;
  return false;
}

const OVERLAY_LABEL_RE = /删除记录|查看详情|设置提醒|分享此记录|复制记录链接|智能总结|向上插入|向下插入/;
const CHROME_MENU_RE = /重新加载|reload|另存为|save as|检查|inspect|查看网页源代码/;
const OVERLAY_KEYS = new Set(["escape", "return", "down", "up", "left", "right", "delete", "insert", "tab", "end", "home", "pageup", "pagedown", "menu", "f10"]);
const NATIVE_MENU_CONTEXT_MS = 30_000;
const MENU_NAV_KEYS = new Set(["escape", "return", "down", "up", "left", "right", "end", "home", "pageup", "pagedown", "tab", "space"]);
const WINDOWS_NATIVE_NAV_KEYS = new Set(["right", "left", "up", "down", "home", "end", "pageup", "pagedown", "tab", "return"]);
// A fresh tree is only a guard, never proof that an OS key had an effect. At
// driver caps, absence of an editor/menu is inconclusive even without a flag.
function completeFreshTree(result, maxElements = 400, maxDepth = 20, allowEmpty = false) {
  const structured = structuredOf(result);
  const elements = structured.elements;
  if (captureFailed(result) || !Array.isArray(elements) || (!allowEmpty && !elements.length)
    || elements.length >= maxElements || structured.query || structured.query_local) return false;
  function incomplete(value, nesting = 0) {
    if (!value || typeof value !== "object") return false;
    if (nesting > 64) return true;
    return Object.entries(value).some(([key, item]) => {
      const name = key.replace(/[_-]/g, "").toLowerCase();
      const flagged = item != null && item !== false && item !== 0 && item !== "" && item !== "false";
      if (/error|unavailable|degrad|truncat|incomplete|partial|(limit|cap)(reached|hit|exceeded)|limited|capped|hasmore/.test(name) && flagged) return true;
      if (/(complete|full|fulltree)$/.test(name) && (item === false || item === "false")) return true;
      if (/depthreached$/.test(name) && (item === true || item === "true")) return true;
      if (/^(status|treestatus)$/.test(name) && /error|degrad|truncat|incomplete|partial/i.test(String(item))) return true;
      if (/^(depth|treedepth|level|depthreached|maxdepthreached)$/.test(name) && Number(item) >= maxDepth) return true;
      return typeof item === "object" && incomplete(item, nesting + 1);
    });
  }
  return !incomplete(structured) && !incomplete({ ...result, structuredContent: undefined, content: undefined });
}

function treeHasMenu(elements) {
  return treeHasContextOverlay(elements) || elements.some((el) => el && !isWindowChromeMenu(el)
    && /^menu(item(checkbox|radio)?)?$/i.test(String(el.role || "")));
}

function treeHasContextOverlay(elements) {
  if (!Array.isArray(elements) || !elements.length) return false;
  let hits = 0;
  let deleteHit = false;
  for (const el of elements) {
    if (!el) continue;
    const blob = `${el.label || ""} ${el.value || ""}`;
    if (CHROME_MENU_RE.test(blob)) continue;
    if (OVERLAY_LABEL_RE.test(blob)) {
      hits += 1;
      if (/删除记录/.test(blob)) deleteHit = true;
    }
  }
  return hits >= 2 || deleteHit;
}

function clickTargetsOverlay(hit, elements, mouseButton) {
  if (String(mouseButton || "left").toLowerCase() === "right") return false;
  if (!treeHasContextOverlay(elements)) return false;
  if (!hit) return false;
  return OVERLAY_LABEL_RE.test(`${hit.label || ""} ${hit.value || ""}`);
}

function isUnverifiedAction(result) {
  if (!result) return true;
  if (result.isError) return true;
  const structured = structuredOf(result);
  if (structured.verified === true || structured.effect === "confirmed") return false;
  if (structured.effect === "unverifiable") return true;
  if (structured.verified === false || structured.effect === "suspected_noop") return true;
  return false;
}

function overlayKeyAction(parsed) {
  if (!nativeKeyChord(parsed)) return false;
  return parsed.kind === "hotkey" || OVERLAY_KEYS.has(parsed.key);
}

function isContextMenuKey(parsed) {
  if (!parsed) return false;
  if (parsed.kind === "press_key") return parsed.key === "menu";
  const keys = parsed.keys || [];
  return keys.includes("menu") || (keys.includes("shift") && keys.includes("f10"));
}

function isCellEditorMarker(el) {
  if (!el) return false;
  const blob = `${el.role || ""} ${el.label || ""} ${el.value || ""} ${el.name || ""}`;
  return /BITABLE_TEXT_EDITOR|number-editor-input|ai-cell-toolbar/i.test(blob);
}

function editorMarkerUnavailable(el) {
  const on = (value) => value === true || value === 1 || value === "true" || value === "1";
  const off = (value) => value === false || value === 0 || value === "false" || value === "0";
  return on(el.hidden) || off(el.visible) || off(el.enabled) || on(el.disabled)
    || on(el.is_hidden) || off(el.is_visible) || off(el.is_enabled);
}

function markerText(el) {
  if (!el) return "";
  return [el.name, el.label, el.value, el.text].map((value) => String(value ?? "").trim()).find(Boolean) || "";
}
// The title-bar system menu item ("系统" / "System") is resident window chrome,
// not a context menu or editing popup; it must never feed cancellation or
// native-menu evidence (AX-less game windows expose only this chrome).
const WINDOW_CHROME_MENU_NAME_RE = /^(系统|系统菜单|system)$/i;
function isWindowChromeMenu(el) {
  if (!el) return false;
  const role = String(el.role || "").replace(/[ _-]/g, "").toLowerCase();
  if (!/^menu(item(checkbox|radio)?)?$/.test(role)) return false;
  return WINDOW_CHROME_MENU_NAME_RE.test(markerText(el));
}


function cancellationMarkerKind(el) {
  if (!el || isWindowChromeMenu(el)) return null;
  const role = String(el.role || "").replace(/[ _-]/g, "").toLowerCase();
  const blob = `${el.role || ""} ${el.label || ""} ${el.value || ""} ${el.name || ""}`;
  if (/BITABLE_TEXT_EDITOR|number-editor-input/i.test(blob)) return "cell_editor";
  if (/ai-cell-toolbar/i.test(blob)) return "editor_toolbar";
  if (role === "edit" && markerText(el) === "查找或创建选项") return "option_popup";
  const expanded = el.expanded === true || el.is_expanded === true || el.aria_expanded === true
    || el.expanded === "true" || el.is_expanded === "true" || el.aria_expanded === "true";
  const active = el.focused === true || el.has_keyboard_focus === true || el.hasKeyboardFocus === true
    || el.contains_focus === true || el.active === true || el.is_active === true;
  if (role === "combobox" && expanded && active) return "expanded_combobox";
  if (role === "listbox" && active) return "listbox_popup";
  if (role === "dialog" && (active || el.modal === true || el.is_modal === true)) return "dialog";
  if (/^menu(item(checkbox|radio)?)?$/.test(role) && (el.in_web_content !== true || active)) return "context_menu";
  return null;
}

function cancellationEvidence(elements) {
  if (!Array.isArray(elements)) return { kind: "none", markers: [], unavailable: [] };
  const candidates = elements.map((el) => ({ el, kind: cancellationMarkerKind(el) })).filter((item) => item.kind);
  const unavailable = candidates.filter(({ el }) => editorMarkerUnavailable(el));
  const visible = candidates.filter(({ el }) => !editorMarkerUnavailable(el));
  const markers = visible.map(({ el, kind }) => ({
    kind, role: el.role || null, name: markerText(el) || null,
    element_index: el.element_index ?? null,
  }));
  const kinds = [...new Set(markers.map((marker) => marker.kind))];
  return { kind: kinds.length === 0 ? "none" : kinds.length === 1 ? kinds[0] : "multiple", markers, unavailable };
}

function normalizeMarkerName(name) {
  return String(name || "").replace(/[_-]?(?:[0-9a-z]{6,}|\d+)$/i, "");
}

function markerSignature(marker) {
  return `${marker.kind}|${marker.role || ""}|${normalizeMarkerName(marker.name)}`;
}

function treeSignature(elements) {
  if (!Array.isArray(elements)) return null;
  const parts = elements.map((el) => `${(el && el.role) || ""}:${(el && (el.name ?? el.label)) ?? ""}`).sort();
  let hash = 0x811c9dc5;
  const text = parts.join("\n");
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  }
  return { count: elements.length, hash };
}

function treeHasCellEditor(elements) {
  if (!Array.isArray(elements) || !elements.length) return false;
  return elements.some((el) => isCellEditorMarker(el) && !editorMarkerUnavailable(el));
}

function responseFlaggedUnhealthy(result) {
  function scan(value, nesting = 0) {
    if (!value || typeof value !== "object") return false;
    if (nesting > 64) return true;
    return Object.entries(value).some(([key, item]) => {
      // tree_stale/image_stale are informational freshness annotations added by
      // _getAppState, not capture health flags; they must not poison the guard.
      if (key === "content" || key === "elements" || key === "tree_markdown"
        || key === "tree_stale" || key === "image_stale") return false;
      const name = key.replace(/[_-]/g, "").toLowerCase();
      const flagged = item != null && item !== false && item !== 0 && item !== "" && item !== "false";
      if (/error|unavailable|degrad|stale/.test(name) && flagged) return true;
      if (/^(status|treestatus|capturestatus)$/.test(name) && /degrad|failed|error|unavailable|stale/i.test(String(item))) return true;
      if (/^(ok|success)$/.test(name) && item === false) return true;
      if (/^(cached|fromcache|cachehit|querylocal)$/.test(name) && flagged) return true;
      if (name === "fresh" && item === false) return true;
      if (/^(source|treesource)$/.test(name) && /^(cache|cached)$/i.test(String(item))) return true;
      return typeof item === "object" && scan(item, nesting + 1);
    });
  }
  return scan(result);
}

function nestedTargetMismatch(value, target, nesting = 0) {
  if (!value || typeof value !== "object" || nesting > 64) return false;
  return Object.entries(value).some(([key, item]) => {
    if (key === "elements" || key === "content" || key === "tree_markdown") return false;
    const name = key.replace(/[_-]/g, "").toLowerCase();
    if (/^(pid|targetpid|capturepid)$/.test(name) && Number.isFinite(Number(item)) && Number(item) !== Number(target.pid)) return true;
    if (/^(windowid|targetwindowid|capturewindowid|hwnd|targethwnd)$/.test(name) && Number.isFinite(Number(item)) && Number(item) !== Number(target.window_id)) return true;
    return typeof item === "object" && nestedTargetMismatch(item, target, nesting + 1);
  });
}

function liveTreeGuard(result, target) {
  const structured = structuredOf(result);
  if (captureFailed(result)) return { usable: false, reason: "capture_failed", elements: [] };
  if (responseFlaggedUnhealthy(result)) return { usable: false, reason: "capture_unhealthy", elements: [] };
  if (!Array.isArray(structured.elements)) return { usable: false, reason: "tree_missing", elements: [] };
  const cached = structured.cached === true || structured.from_cache === true || structured.cache_hit === true
    || structured.fresh === false || /^(cache|cached)$/i.test(String(structured.source || structured.tree_source || ""));
  if (structured.query || structured.query_local || cached) {
    return { usable: false, reason: structured.query || structured.query_local ? "filtered_tree" : "cached_tree", elements: [] };
  }
  if (structured._capture_target_match === false || nestedTargetMismatch(structured, target)) {
    return { usable: false, reason: "foreign_target", elements: [] };
  }
  const evidence = cancellationEvidence(structured.elements);
  if (evidence.unavailable.length) {
    return { usable: false, reason: "cancellation_marker_hidden_or_disabled", elements: [] };
  }
  return {
    usable: true,
    reason: "live_tree",
    elements: structured.elements,
    editor: treeHasCellEditor(structured.elements),
    cancellation: { kind: evidence.kind, markers: evidence.markers },
    complete: completeFreshTree(result, 400, 20, true),
  };
}

function liveGuardBlocked(code, message, reason) {
  const result = runtimeError(code, message, "not_sent");
  result.structuredContent.guard_reason = reason;
  return result;
}

function annotateOverlayUnverified(result) {
  if (!result || typeof result !== "object") return result;
  const structured = { ...structuredOf(result), overlay_unverified: true, delivery_mode: structuredOf(result).delivery_mode || "foreground" };
  const content = Array.isArray(result.content) ? result.content.map((item) => ({ ...item })) : [];
  const textItem = content.find((item) => item && item.type === "text");
  const extra = "overlay_unverified. Do not click this menu again; use keys or stop.";
  if (textItem) textItem.text = `${String(textItem.text || "").trim()}. ${extra}`;
  else content.unshift({ type: "text", text: extra });
  return { ...result, content, structuredContent: structured };
}


// Compatibility export: uncertain delivery must never authorize a second paste.
function needsPasteFallback() { return false; }

// Caller-selected delivery (schema delivery_mode): still a single attempt; the
// foreground choice only prepares the target window before that attempt.
function callerDeliveryOpts(args) {
  return args && String(args.delivery_mode || "").toLowerCase() === "foreground"
    ? { foreground: true, routeReason: "caller_requested_foreground" }
    : {};
}

function actionSummary(result, action, app) {
  const structured = structuredOf(result);
  const verified = structured.verified;
  const effect = structured.effect;
  const delivery = structured.path || structured.delivery_mode;
  const bits = [
    `${result && result.isError ? "error" : "result"} action=${action} app=${app}`,
    verified === true ? "driver_verified=true (not goal confirmation)" : verified === false ? "verified=false" : null,
    effect ? `effect=${effect}` : null,
    delivery ? `path=${delivery}` : null,
    "Goal unconfirmed; verify the intended result. Do not automatically replay this action.",
  ].filter(Boolean);
  const raw = textFromResult(result).trim();
  if (raw && !/^✅/.test(raw)) bits.push(raw.slice(0, 400));
  return bits.join(". ");
}

const IS_MAC = process.platform === "darwin";
const IS_WIN = process.platform === "win32";

const KEY_ALIASES = {
  control: "ctrl",
  control_l: "ctrl",
  control_r: "ctrl",
  ctrl: "ctrl",
  ctrl_l: "ctrl",
  ctrl_r: "ctrl",
  shift: "shift",
  shift_l: "shift",
  shift_r: "shift",
  alt: "alt",
  alt_l: "alt",
  alt_r: "alt",
  option: "alt",
  super: IS_MAC ? "command" : "win",
  super_l: IS_MAC ? "command" : "win",
  super_r: IS_MAC ? "command" : "win",
  meta: IS_MAC ? "command" : "win",
  meta_l: IS_MAC ? "command" : "win",
  command: IS_MAC ? "command" : "ctrl",
  cmd: IS_MAC ? "command" : "ctrl",
  win: IS_MAC ? "command" : "win",
  windows: IS_MAC ? "command" : "win",
  return: "return",
  enter: "return",
  escape: "escape",
  esc: "escape",
  tab: "tab",
  space: "space",
  backspace: "backspace",
  delete: "delete",
  menu: "menu",
  apps: "menu",
  application: "menu",
  context_menu: "menu",
  contextmenu: "menu",
  end: "end",
  home: "home",
  f10: "f10",
  down: "down",
  up: "up",
  left: "left",
  right: "right",
  page_down: "pagedown",
  page_up: "pageup",
  pagedown: "pagedown",
  pageup: "pageup",
};

function parseKeyChord(raw) {
  const parts = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .split("+")
    .filter(Boolean)
    .map((part) => KEY_ALIASES[part] || part.replace(/^kp_/, ""));
  if (!parts.length) return null;
  if (parts.length === 1) return { kind: "press_key", key: parts[0] };
  return { kind: "hotkey", keys: parts };
}

function isPasteChord(key) {
  const parsed = parseKeyChord(key);
  if (!parsed || parsed.kind !== "hotkey") return false;
  const keys = parsed.keys;
  return keys.length === 2 && keys.includes("v") && keys.some((item) => item === "ctrl" || item === "command");
}

const EDITOR_SINGLE_KEYS = new Set(["return", "tab", "delete", "space"]);

function keyNeedsEditorFocus(parsed) {
  if (!parsed) return false;
  if (parsed.kind === "hotkey") {
    const keys = parsed.keys;
    if (keys.includes("escape") || keys.includes("alt")) return false;
    return keys.includes("ctrl") || keys.includes("win") || keys.includes("command");
  }
  return EDITOR_SINGLE_KEYS.has(parsed.key);
}

function writeClipboardText(text) {
  try {
    const { clipboard } = require("electron");
    clipboard.writeText(String(text ?? ""));
    return "electron";
  } catch {
    return null;
  }
}

function sendUiaFocus(env, hwnd) {
  const script = path.join(__dirname, "scripts", "windows-uia-focus.ps1");
  if (!IS_WIN || !fs.existsSync(script) || !hwnd) return false;
  try {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Hwnd", String(Number(hwnd))],
      { env, encoding: "utf8", timeout: FOCUS_TIMEOUT_MS, windowsHide: true, maxBuffer: 1_000_000 },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}


// Read-only keyboard focus probe (GetGUIThreadInfo) for targets without a
// ValuePattern. Reports where focus sits; never moves focus or sends input.
function readFocusState(env, hwnd, pid) {
  if (!IS_WIN || !hwnd) return null;
  const script = path.join(__dirname, "scripts", "windows-focus-state.ps1");
  if (!fs.existsSync(script)) return null;
  try {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
        "-Hwnd", String(Number(hwnd)), "-TargetPid", String(Number(pid || 0))],
      { env, encoding: "utf8", timeout: FOCUS_TIMEOUT_MS, windowsHide: true, maxBuffer: 64_000 },
    );
    if (result.error || result.status !== 0) return null;
    const parsed = JSON.parse(String(result.stdout || "").trim());
    return parsed && typeof parsed === "object" && parsed.ok === true ? parsed : null;
  } catch {
    return null;
  }
}

// Deliberately narrow: never discard modifiers to turn a hotkey into a menu key.
function nativeKeyChord(parsed) {
  if (!parsed) return null;
  if (parsed.kind === "press_key") {
    return OVERLAY_KEYS.has(parsed.key) || ["space", "backspace"].includes(parsed.key)
      ? { key: parsed.key, shift: false } : null;
  }
  const keys = parsed.keys || [];
  if (keys.length === 2 && keys.includes("ctrl") && keys.includes("v")) return { key: "v", control: true, shift: false };
  if (keys.length !== 2 || !keys.includes("shift")) return null;
  const key = keys.find((item) => item !== "shift");
  return key === "f10" || key === "tab" ? { key, shift: true } : null;
}

function sendWindowsKey(env, hwnd, pid, parsed) {
  const failure = (code, diagnostic = "") => ({
    ok: false, code, sent: null, expected: null, foreground_hwnd: 0, focus_hwnd: 0,
    target_hwnd: hwnd, target_pid: pid, last_error: 0, diagnostic: String(diagnostic).slice(0, 800),
  });
  const chord = nativeKeyChord(parsed);
  if (!IS_WIN || !chord) return { ...failure("unsupported_key_chord"), sent: 0, expected: 0 };
  const script = path.join(__dirname, "scripts", "windows-send-key.ps1");
  if (!fs.existsSync(script) || !hwnd || !pid) return { ...failure("invalid_native_target"), sent: 0, expected: 0 };
  const extra = ["-Hwnd", String(Number(hwnd)), "-TargetPid", String(Number(pid)), "-Key", chord.key];
  if (chord.shift) extra.push("-Shift");
  if (chord.control) extra.push("-Control");
  try {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...extra],
      { env, encoding: "utf8", timeout: FOCUS_TIMEOUT_MS, windowsHide: true, maxBuffer: 64_000 },
    );
    const diagnostic = String(result.stderr || result.error?.message || "").slice(0, 800);
    let transport;
    try { transport = JSON.parse(String(result.stdout || "").trim()); }
    catch { return failure("invalid_native_result", diagnostic); }
    if (!transport || typeof transport.ok !== "boolean" || typeof transport.code !== "string"
      || !Number.isInteger(transport.sent) || !Number.isInteger(transport.expected)
      || transport.sent < 0 || transport.expected < transport.sent
      || !["foreground_hwnd", "focus_hwnd", "target_hwnd", "target_pid", "last_error"].every((key) => Number.isFinite(transport[key]))) {
      return failure("invalid_native_result", diagnostic);
    }
    const accepted = result.status === 0 && !result.error && transport.ok
      && transport.expected === (chord.shift || chord.control ? 4 : 2) && transport.sent === transport.expected
      && Number(transport.target_hwnd) === Number(hwnd) && Number(transport.target_pid) === Number(pid);
    return { ...transport, ok: accepted, code: accepted || !transport.ok ? transport.code : "native_process_failed", diagnostic };
  } catch (error) {
    return failure("native_process_failed", error.message);
  }
}

function win32KeyResult(app, parsed, transport) {
  const key = parsed.kind === "hotkey" ? parsed.keys.join("+") : parsed.key;
  return {
    ...(transport.ok ? {} : { isError: true }),
    content: [{ type: "text", text: transport.ok
      ? `ok action=press_key app=${app}. transport_sent=true effect=unverifiable path=win32-hwnd key=${key}. Input accepted once; key effect not verified.`
      : `Windows key transport failed: ${transport.code} sent=${transport.sent}/${transport.expected}. No retry.${transport.diagnostic ? ` ${transport.diagnostic}` : ""}` }],
    structuredContent: { ...transport, transport_sent: Number.isInteger(transport.sent) ? transport.sent > 0 : null, effect: "unverifiable", path: "win32-hwnd" },
  };
}

function pickWindow(windows, windowId) {
  const list = Array.isArray(windows) ? windows : [];
  if (windowId) {
    const hit = list.find((item) => Number(item.window_id) === Number(windowId));
    if (hit) return hit;
  }
  const usable = list.filter((item) => item.is_on_screen !== false && item.minimized !== true);
  const pool = usable.length ? usable : list;
  return pool.slice().sort((a, b) => Number(b.z_index || 0) - Number(a.z_index || 0))[0] || null;
}

class ComputerUseRuntime {
  constructor() {
    this.child = null;
    this.buf = "";
    this.nextId = 1;
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.status = "stopped";
    this.lastError = "";
    this.stderrTail = "";
    this.stoppedByUser = false;
    this.lastFrame = null;
    this.info = { version: null, exe: null };
    this._starting = null;
    this.tempDir = null;
    this.targets = new Map();
    this._nativeMenuContext = null;
    this.banner = new ControlBanner();
    this._controlDepth = 0;
    this._bannerHideTimer = null;
    this.settings = {};
    this._imageVersion = 0;
    this._treeVersion = 0;
    this._observationId = 0;
  }

  callTool(name, args, options = {}) {
    const observe = options.observe === true;
    if (options.settings) this.settings = options.settings;
    const run = async () => {
      const nextArgs = args && typeof args === "object" ? { ...args } : {};
      const action = CONTROL_TOOLS.has(name) && name !== "get_app_state";
      const waiting = name === "get_app_state" && nextArgs.wait_for !== undefined;
      const controlling = CONTROL_TOOLS.has(name) && !waiting;
      let began = false;
      let mapped;
      const waitStartedAt = Date.now();
      try {
        const validation = name === "get_app_state" && validateStateArgs(nextArgs);
        if (validation) return normalizeActionResult(runtimeError("validation_error", validation, "not_sent"), name);
        if (this.stoppedByUser) {
          const stopped = runtimeError("stopped_by_user", "Computer Use stopped", "not_sent");
          if (waiting) stopped.structuredContent.wait = { status: "cancelled", predicate: { ...nextArgs.wait_for }, attempts: 0, elapsed_ms: 0, evidence: [] };
          return normalizeActionResult(stopped, name);
        }
        if (waiting) {
          nextArgs._waitStartedAt = waitStartedAt;
          nextArgs._waitDeadline = waitStartedAt + Math.max(1, nextArgs.wait_timeout_ms ?? 10000);
          const startup = { active: true, deadline: Math.min(nextArgs._waitDeadline, waitStartedAt + START_TIMEOUT_MS) };
          await this._waitStep(() => this.ensureRunning(), startup);
        } else await this.ensureRunning();
        if (controlling) { this.beginControl(); began = true; }
        const beforeSig = action && observe && nextArgs.app ? this._treeSignatureFor(nextArgs.app) : null;
        mapped = await this._dispatch(name, nextArgs, observe);
        if (beforeSig) nextArgs._treeBeforeSig = beforeSig;
      } catch (error) {
        mapped = runtimeError(error.code || "runtime_error", error.message || String(error), error.code === "stale_tree" ? "not_sent" : "unknown");
        if (waiting) mapped.structuredContent.wait = {
          status: this.stoppedByUser || error.code === "stopped_by_user" ? "cancelled" : error.code === "wait_timeout" ? "timeout" : "error",
          predicate: { ...nextArgs.wait_for }, attempts: 0, elapsed_ms: Date.now() - waitStartedAt, reason: "startup_failed", evidence: [],
        };
      } finally {
        if (action) this._invalidateTrees();
        if (began) this.endControl();
      }
      mapped = normalizeActionResult(mapped, name);
      if (action) {
        mapped = this._recordActionObservation(nextArgs.app || nextArgs.name, mapped);
        if (observe && nextArgs.app && !this.stoppedByUser && !structuredOf(mapped).cancellation?.post_observed) {
          mapped = await this._observeAction(nextArgs, mapped);
          if (nextArgs._treeBeforeSig) mapped = this._applyTreeDiff(nextArgs._treeBeforeSig, mapped);
        }
      }
      this._rememberFrame(nextArgs.app || nextArgs.name, mapped);
      return mapped;
    };
    const pending = this.queue.then(run, run);
    this.queue = pending.catch(() => {});
    return pending;
  }

  async _observeAction(args, actionResult) {
    const context = { active: true, deadline: Date.now() + 10000 };
    try {
      const observation = await this._waitStep(() => this._getAppState({
        app: args.app, window_id: args.window_id, refresh: true,
        include_tree: true, include_screenshot: true, _waitContext: context,
      }), context);
      const state = structuredOf(observation);
      const failed = captureFailed(observation);
      return { ...actionResult,
        content: [...(actionResult.content || []).filter((item) => item.type === "text"), ...(observation.content || [])],
        structuredContent: { ...structuredOf(actionResult), ...observationFields(state), ...stalenessFields(state),
          observation: state, ...(failed ? { observation_error: "post_action_capture_failed" } : {}) },
      };
    } catch (error) {
      this._invalidateTrees(args.app);
      return { ...actionResult,
        content: [...(actionResult.content || []), { type: "text", text: `Post-action observation failed: ${error.message}. Action was not replayed.` }],
        structuredContent: { ...structuredOf(actionResult), observation_error: error.code || "capture_failed" },
      };
    } finally { context.active = false; }
  }

  async _dispatch(name, args, observe) {
    if (CONTROL_TOOLS.has(name) && name !== "get_app_state" && args.element_index != null && args.element_index !== "") {
      await this._resolveTarget(args.app, args.window_id);
      this._elementFields(args.app, args.element_index);
      const cached = this.targets.get(normalize(args.app));
      if (!cached.elements.some((el) => Number(el.element_index) === Number(args.element_index))) {
        return runtimeError("stale_tree", "stale_tree: element index missing; refresh get_app_state with include_tree=true.", "not_sent");
      }
    }
    if (name === "list_apps") return this._listApps(args);
    if (name === "list_windows") return this._listWindows(args);
    if (name === "launch_app") return this._launchApp(args);
    if (name === "get_app_state") return this._getAppState(args);
    if (name === "paste_text") return this._pasteText(args, observe);
    if (name === "press_key" && isPasteChord(args.key)) {
      return this._pasteText({ ...args, text: null, pasteOnly: true }, observe);
    }
    if (name === "click") return this._click(args, observe);
    if (name === "scroll") return this._scroll(args, observe);
    if (name === "drag") return this._drag(args, observe);
    if (name === "type_text") return this._typeText(args, observe);
    if (name === "press_key") return this._pressKey(args, observe);
    if (name === "set_value") return this._setValue(args, observe);
    return this._cua(name, args);
  }

  async _cua(name, args, timeout = RPC_TIMEOUT_MS) {
    let result = await this._rpcUnlocked("tools/call", { name, arguments: args || {} }, timeout);
    // The driver ends its MCP session after an idle period and refuses every
    // tool until start_session is called explicitly. The refused call was not
    // delivered (delivery=not_sent, retry_safe=true), so reopen once and retry;
    // stale AX tokens from the ended session are invalidated, not reused.
    if (name !== "start_session" && refusalCode(result) === "session_ended" && !this.stoppedByUser) {
      this._invalidateTrees();
      this._nativeMenuContext = null;
      await this._rpcUnlocked("tools/call", { name: "start_session", arguments: {} }, timeout);
      result = await this._rpcUnlocked("tools/call", { name, arguments: args || {} }, timeout);
      if (refusalCode(result) !== "session_ended") {
        result = { ...result, structuredContent: { ...structuredOf(result), session_recovered: true } };
      }
    }
    return result;
  }

  async _cuaAction(name, args, observe, opts = {}) {
    this._nativeMenuContext = null;
    // Select delivery before the only attempt. Errors and occlusion are not proof
    // that the first action was not delivered.
    if (this.stoppedByUser) return runtimeError("stopped_by_user", "Computer Use stopped; no action sent", "not_sent");
    const actionEpoch = this._sessionEpoch || 0;
    const foreground = opts.overlay === true || opts.foreground === true;
    const deliveryMode = foreground ? "foreground" : "background";
    if (foreground) await this._cua("bring_to_front", { pid: args.pid, window_id: args.window_id }).catch(() => {});
    if (this.stoppedByUser) return runtimeError("stopped_by_user", "Computer Use stopped; no action sent", "not_sent");
    if (actionEpoch !== (this._sessionEpoch || 0)) return runtimeError("session_changed", "Control session changed before delivery; no action sent", "not_sent");
    let result;
    try {
      result = await this._cua(name, { ...args, delivery_mode: deliveryMode });
    } catch (error) {
      result = runtimeError("action_delivery_unknown", error.message);
    } finally {
      this._invalidateTrees();
    }
    result = result || runtimeError("action_delivery_unknown", "Empty action result");
    result = { ...result, structuredContent: { ...structuredOf(result), verify_needed: true,
      delivery_mode: deliveryMode, delivery_path: `cua-${deliveryMode}`,
      route_reason: opts.routeReason || (opts.overlay ? "existing_overlay" : "default_delivery") } };
    if (opts.overlay && isUnverifiedAction(result)) result = annotateOverlayUnverified(result);
    if (observe) return result;
    return { ...result, content: [{ type: "text", text: actionSummary(result, name, this._labelForPid(args.pid) || "") },
      ...(result.content || []).filter((item) => item.type === "image")] };
  }

  _labelForPid(pid) {
    for (const [key, target] of this.targets) {
      if (Number(target.pid) === Number(pid)) return target.app || key;
    }
    return "";
  }

  async _listWindowsRaw() {
    const result = await this._cua("list_windows", {});
    const windows = structuredOf(result).windows || [];
    return filterRecords(windows, this.settings);
  }

  async _listApps(args) {
    if (args.include_installed === true || args.include_installed === "true") {
      const result = await this._cua("list_apps", {});
      const apps = filterRecords(structuredOf(result).apps || [], this.settings);
      const lines = [`${apps.length} app(s) (installed+running)`];
      for (const app of apps) {
        lines.push(`- ${app.name} pid=${app.pid || 0} running=${app.running} ${app.launch_path || ""}`.trim());
      }
      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { apps } };
    }
    const windows = await this._listWindowsRaw();
    const seen = new Map();
    for (const win of windows) {
      const key = `${win.pid}:${normalize(win.app_name)}`;
      if (!seen.has(key)) {
        seen.set(key, {
          name: win.app_name,
          pid: win.pid,
          running: true,
          window_id: win.window_id,
          title: win.title,
        });
      }
    }
    const apps = [...seen.values()];
    const lines = [`${apps.length} running app(s). Pass include_installed=true for installed-not-running.`];
    for (const app of apps) {
      lines.push(`- ${app.name} pid=${app.pid} window_id=${app.window_id} ${app.title || ""}`.trim());
    }
    return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { apps } };
  }

  async _listWindows(args) {
    let windows = await this._listWindowsRaw();
    if (args.app) windows = windows.filter((item) => namesMatch(args.app, item));
    if (args.on_screen_only === true || args.on_screen_only === "true") {
      windows = windows.filter((item) => item.is_on_screen !== false && item.minimized !== true);
    }
    const lines = [`${windows.length} window(s)`];
    for (const win of windows) {
      const tag = win.is_on_screen === false || win.minimized ? " [off-screen]" : "";
      lines.push(`- ${win.app_name} pid=${win.pid} window_id=${win.window_id} "${win.title || ""}"${tag}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { windows } };
  }

  async _launchApp(args) {
    const payload = {};
    if (args.launch_path) payload.launch_path = args.launch_path;
    else if (args.path) payload.path = args.path;
    else if (args.name) payload.name = args.name;
    else return { isError: true, content: [{ type: "text", text: "name, path, or launch_path is required" }] };
    const result = await this._cua("launch_app", payload);
    const structured = structuredOf(result);
    const pid = structured.pid;
    const windows = structured.windows || [];
    if (pid && windows[0]) {
      this._rememberTarget(args.name || args.path || String(pid), {
        app: args.name || args.path,
        pid,
        window_id: windows[0].window_id,
      });
    }
    return result;
  }

  async _resolveTarget(app, windowId, context = null) {
    const epoch = this._sessionEpoch || 0;
    const checkResolution = () => {
      if (this.stoppedByUser || epoch !== (this._sessionEpoch || 0) || (context && (!context.active || Date.now() >= context.deadline))) {
        const error = new Error("Target resolution cancelled or expired; no cached target changed");
        error.code = this.stoppedByUser ? "stopped_by_user" : context ? "wait_timeout" : "session_changed";
        throw error;
      }
    };
    checkResolution();
    const blocked = gateRecord({ name: app, pid: 0 }, this.settings);
    if (blocked && blocked.startsWith("blocked app")) {
      throw new Error(blocked);
    }
    const cached = this.targets.get(normalize(app));
    if (cached && (!windowId || Number(cached.window_id) === Number(windowId))) {
      const gate = gateRecord({ name: app, pid: cached.pid }, this.settings);
      if (gate) throw new Error(gate);
      return { ...cached, window_id: windowId || cached.window_id };
    }
    const windows = await this._listWindowsRaw();
    checkResolution();
    const matches = windows.filter((item) => namesMatch(app, item));
    const picked = windowId ? matches.find((item) => Number(item.window_id) === Number(windowId)) : pickWindow(matches);
    if (!picked) {
      throw new Error(`no window for app=${app}. Call launch_app or list_windows.`);
    }
    const gate = gateRecord({ name: picked.app_name, pid: picked.pid }, this.settings);
    if (gate) throw new Error(gate);
    const target = {
      app: picked.app_name || app,
      pid: picked.pid,
      window_id: picked.window_id,
      window_bounds: picked.bounds || picked.window_bounds,
    };
    this._rememberTarget(app, target);
    return target;
  }

  _rememberTarget(app, target) {
    const key = normalize(app);
    let prev = this.targets.get(key) || {};
    if ((target.pid != null && prev.pid != null && Number(target.pid) !== Number(prev.pid))
      || (target.window_id != null && prev.window_id != null && Number(target.window_id) !== Number(prev.window_id))) {
      prev = { tree_actionable: false, elements: [], snapshot_id: null };
      this._nativeMenuContext = null;
    }
    this.targets.set(key, { ...prev, ...target, app: target.app || prev.app || app });
  }

  _invalidateTrees(app) {
    for (const [key, target] of this.targets) {
      if (!app || key === normalize(app)) target.tree_actionable = false;
    }
  }

  _recordActionObservation(app, result) {
    const cached = this.targets.get(normalize(app));
    if (!cached) return result;
    const s = structuredOf(result);
    const image = imageFromResult(result);
    const tree = !captureFailed(result) && Array.isArray(s.elements) && s.snapshot_id && !s.query_local;
    const at = new Date().toISOString();
    if (image || tree) cached.observation_id = this._observationId = (this._observationId || 0) + 1;
    if (image) { cached.image_version = this._imageVersion = (this._imageVersion || 0) + 1; cached.image_captured_at = at; }
    if (tree) {
      cached.tree_version = this._treeVersion = (this._treeVersion || 0) + 1;
      cached.tree_captured_at = at;
      cached.snapshot_id = s.snapshot_id;
      cached.elements = localizeElements(s.elements, originFromBounds(s.window_bounds || cached.window_bounds));
    }
    // Even an action's attached observation is not permission to reuse AX indices.
    cached.tree_actionable = false;
    return { ...result, content: [...(result.content || []), { type: "text", text: observationText(cached) }],
      structuredContent: { ...s, ...observationFields(cached) } };
  }

  _elementFields(app, elementIndex) {
    if (elementIndex == null || elementIndex === "") return {};
    const cached = this.targets.get(normalize(app)) || {};
    if (cached.tree_actionable !== true) {
      const neverActionable = cached.tree_actionable !== true && cached._everActionable !== true;
      const error = new Error(neverActionable
        ? "stale_tree: this window's AX tree is not actionable (incomplete or foreign), so element_index cannot be used and refresh=true will not change that; click by x,y screenshot coordinates instead."
        : "stale_tree: element indices are no longer actionable; call get_app_state with refresh=true and include_tree=true.");
      error.code = "stale_tree";
      throw error;
    }
    const index = Number(elementIndex);
    const out = { element_index: index };
    if (cached.snapshot_id) out.snapshot_id = cached.snapshot_id;
    const el = Array.isArray(cached.elements)
      ? cached.elements.find((item) => Number(item.element_index) === index)
      : null;
    if (el && el.element_token) out.element_token = el.element_token;
    return out;
  }

  async _ensureEditableFields(app, windowId, elementIndex, force) {
    const existing = this._elementFields(app, elementIndex);
    if (existing.element_index != null) return existing;
    let cached = this.targets.get(normalize(app)) || {};
    if (force || cached.tree_actionable !== true || !Array.isArray(cached.elements) || !cached.elements.length) {
      try {
        await this._getAppState({
          app,
          window_id: windowId,
          include_screenshot: false,
          include_tree: true,
        });
      } catch {
        /* keep whatever snapshot we already have */
      }
      cached = this.targets.get(normalize(app)) || {};
    }
    const picked = cached.tree_actionable === true ? pickEditableElement(cached.elements) : null;
    if (!picked) return {};
    return this._elementFields(app, picked.element_index);
  }

  _menuContextFor(target) {
    const context = this._nativeMenuContext;
    if (context && (context.pid !== Number(target.pid) || context.window_id !== Number(target.window_id)
      || Date.now() >= context.expiresAt)) this._nativeMenuContext = null;
    return this._nativeMenuContext;
  }

  _waitStep(work, context) {
    return new Promise((resolve, reject) => {
      let done = false;
      let timer;
      const finish = (error, value) => {
        if (done) return;
        done = true; clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const check = () => {
        if (this.stoppedByUser || !context.active || Date.now() >= context.deadline) {
          context.active = false;
          const error = new Error(this.stoppedByUser ? "Wait cancelled by user" : "Wait deadline reached");
          error.code = this.stoppedByUser ? "stopped_by_user" : "wait_timeout";
          finish(error);
        } else timer = setTimeout(check, Math.min(50, Math.max(1, context.deadline - Date.now())));
      };
      // Even a mocked/stalled RPC is bounded; late resolutions cannot cache state.
      Promise.resolve().then(() => {
        if (!done && context.active && !this.stoppedByUser) return work();
      }).then((value) => {
        if (done) return;
        if (this.stoppedByUser || !context.active || Date.now() > context.deadline) check();
        else finish(null, value);
      }, (error) => finish(error));
      check();
    });
  }

  async _waitForState(args) {
    const start = args._waitStartedAt ?? Date.now();
    const timeout = args.wait_timeout_ms ?? 10000;
    const interval = args.poll_interval_ms ?? 500;
    const context = { active: true, deadline: args._waitDeadline ?? start + Math.max(1, timeout) };
    const wantScreenshot = args.include_screenshot !== false && args.include_screenshot !== "false";
    const wantTree = args.include_tree !== false && args.include_tree !== "false";
    const maxElements = Number(args.max_tree_nodes) || 400;
    const maxDepth = Number(args.max_tree_depth) || 20;
    let attempts = 0;
    let last;
    let checked = { matched: false, reason: "no_observation", evidence: [] };
    let status = "timeout";
    const capture = async (screenshot) => {
      attempts += 1;
      let result;
      try {
        result = await this._waitStep(() => this._getAppState({ ...args, wait_for: undefined,
          query: undefined, refresh: true, include_tree: true, include_screenshot: screenshot, _waitContext: context }), context);
      } catch (error) {
        if (this.stoppedByUser || !context.active || error.code === "wait_timeout" || error.code === "stopped_by_user") throw error;
        result = runtimeError("capture_failed", "Wait capture failed; predicate not evaluated");
      }
      last = result;
      checked = evaluateWait(result, args.wait_for, maxElements, maxDepth);
    };
    try {
      for (;;) {
        await capture(false);
        if (checked.matched) {
          if (wantScreenshot) await capture(true); // Re-evaluate the final frame, never attach a mismatching frame to success.
          if (checked.matched) { status = "matched"; break; }
        }
        const remaining = context.deadline - Date.now();
        if (remaining <= interval + 1) {
          if (wantScreenshot && remaining > 1) {
            await capture(true);
            if (checked.matched) { status = "matched"; break; }
          }
          await this._waitStep(() => sleep(Math.max(1, context.deadline - Date.now())), context);
          break;
        }
        await this._waitStep(() => sleep(Math.min(interval, remaining)), context);
      }
    } catch (error) {
      if (this.stoppedByUser || error.code === "stopped_by_user") status = "cancelled";
      else if (error.code !== "wait_timeout") checked = { matched: false, reason: "capture_failed", evidence: [] };
      else if (checked.matched) checked = { matched: false, reason: "final_observation_deadline", evidence: [] };
    } finally {
      context.active = false;
    }
    if (status !== "matched") this._invalidateTrees(args.app);
    last = last || runtimeError(status === "cancelled" ? "stopped_by_user" : "wait_timeout", "No completed wait observation");
    const s = { ...structuredOf(last) };
    if (status !== "matched") s.tree_actionable = false;
    const wait = { status, predicate: { ...args.wait_for }, attempts, elapsed_ms: Date.now() - start,
      reason: checked.reason, evidence: status === "matched" ? checked.evidence : [] };
    const content = [];
    if (wantTree) content.push(...(last.content || []).filter((item) => item.type === "text").map((item) => status === "matched"
      ? item : { ...item, text: String(item.text || "").replace(/tree_actionable=true/g, "tree_actionable=false") }));
    else { delete s.elements; delete s.tree_markdown; content.push({ type: "text", text: observationText(s) }); }
    if (wantScreenshot) {
      const image = imageFromResult(last);
      if (image) content.push(image);
      else content.push({ type: "text", text: "screenshot unavailable within wait deadline" });
    }
    content.unshift({ type: "text", text: `wait=${status} attempts=${attempts} elapsed_ms=${wait.elapsed_ms}; accessibility predicate only (no OCR/canvas inference)` });
    return { ...last, ...(status === "cancelled" ? { isError: true } : {}), content, structuredContent: { ...s, wait } };
  }

  async _getAppState(args) {
    const validation = validateStateArgs(args);
    if (validation) return runtimeError("validation_error", validation, "not_sent");
    const includeScreenshot = args.include_screenshot !== false && args.include_screenshot !== "false";
    const includeTree = args.include_tree !== false && args.include_tree !== "false";
    if (!includeScreenshot && !includeTree) return runtimeError("validation_error", "include_screenshot and include_tree cannot both be false", "not_sent");
    if (args.wait_for !== undefined) return this._waitForState(args);
    const context = args._waitContext;
    const epoch = this._sessionEpoch || 0;
    const checkWait = () => {
      if (this.stoppedByUser || epoch !== (this._sessionEpoch || 0)) {
        const error = new Error("Observation belongs to a stopped or replaced driver session");
        error.code = this.stoppedByUser ? "stopped_by_user" : "session_changed";
        throw error;
      }
      if (context && (this.stoppedByUser || !context.active || Date.now() > context.deadline)) {
        const error = new Error("Wait stopped or deadline reached");
        error.code = this.stoppedByUser ? "stopped_by_user" : "wait_timeout";
        throw error;
      }
    };
    checkWait();
    if (args.refresh) this._invalidateTrees(args.app);
    const target = await this._resolveTarget(args.app, args.window_id, context);
    checkWait();
    this._rememberTarget(args.app, target);
    this._menuContextFor(target);
    const prev = this.targets.get(normalize(args.app)) || {};
    const query = args.query != null && args.query !== "" ? String(args.query) : "";
    const localQuery = Boolean(query && !args.refresh && !includeScreenshot && includeTree && prev.tree_actionable === true && Array.isArray(prev.elements));
    if (localQuery) {
      const elements = filterElements(prev.elements, query);
      return { content: [{ type: "text", text: `${observationText(prev)} snapshot_id=${prev.snapshot_id} query=${query} (local) screenshot omitted\n${trimTreeText(compactElements(elements))}` }],
        structuredContent: { ...observationFields(prev), snapshot_id: prev.snapshot_id, elements, query, query_local: true } };
    }
    // Every actual query refresh requests a full tree, then filters locally. A
    // new screenshot must never inherit actionable tokens from an older tree.
    this._invalidateTrees(args.app);
    const payload = { pid: target.pid, window_id: target.window_id, include_screenshot: includeScreenshot,
      include_accessibility_tree: includeTree, max_depth: Number(args.max_tree_depth) || 20,
      max_elements: Number(args.max_tree_nodes) || 400, max_dimension: MAX_IMAGE_DIMENSION };
    let result;
    try {
      result = await this._cua("get_window_state", payload, context ? Math.max(1, context.deadline - Date.now()) : RPC_TIMEOUT_MS);
      checkWait();
    } catch (error) {
      if (epoch === (this._sessionEpoch || 0) && (!context || context.active)) this._nativeMenuContext = null;
      throw error;
    }
    if (captureFailed(result)) {
      this._nativeMenuContext = null;
      return result ? { ...result, isError: true } : runtimeError("capture_failed", "Empty window state");
    }
    let structured = structuredOf(result);
    if (!context && includeScreenshot && structured.screenshot_error) {
      await this._cua("bring_to_front", { pid: target.pid, window_id: target.window_id }).catch(() => {});
      await sleep(200);
      checkWait();
      result = await this._cua("get_window_state", payload);
      checkWait();
      structured = structuredOf(result);
      if (captureFailed(result)) { this._nativeMenuContext = null; return result ? { ...result, isError: true } : runtimeError("capture_failed", "Empty window state"); }
    }
    const captureTargetMatch = structured._capture_target_match !== false
      && (structured.pid == null || Number(structured.pid) === Number(target.pid))
      && (structured.window_id == null || Number(structured.window_id) === Number(target.window_id));
    const trustedTree = liveTreeGuard(result, target).usable && captureTargetMatch;
    const freshTree = includeTree && trustedTree && Array.isArray(structured.elements);
    const complete = freshTree && completeFreshTree(result, payload.max_elements, payload.max_depth, true);
    if (includeTree && (!complete || !treeHasMenu(structured.elements || []))) this._nativeMenuContext = null;
    const image = includeScreenshot ? imageFromResult(result) : null;
    const capturedAt = new Date().toISOString();
    const origin = originFromBounds(structured.window_bounds) || originFromBounds(target.window_bounds) || originFromBounds(prev.window_bounds);
    const remembered = { ...target,
      window_bounds: structured.window_bounds || target.window_bounds || prev.window_bounds,
      snapshot_id: freshTree ? structured.snapshot_id : prev.snapshot_id,
      elements: includeTree ? localizeElements(structured.elements || [], origin) : prev.elements || [],
      observation_id: this._observationId = (this._observationId || 0) + 1,
      image_version: image ? (this._imageVersion = (this._imageVersion || 0) + 1) : prev.image_version ?? 0,
      tree_version: freshTree ? (this._treeVersion = (this._treeVersion || 0) + 1) : prev.tree_version ?? 0,
      image_captured_at: image ? capturedAt : prev.image_captured_at ?? null,
      tree_captured_at: freshTree ? capturedAt : prev.tree_captured_at ?? null,
      tree_actionable: Boolean(complete && (!includeScreenshot || image) && !structured.screenshot_error),
      _everActionable: prev._everActionable === true || Boolean(complete && (!includeScreenshot || image) && !structured.screenshot_error),
    };
    this._rememberTarget(args.app, remembered);
    // A fresh screenshot with an inherited tree timestamp (or vice versa) is a
    // common misread; flag each channel that was NOT refreshed this capture.
    const treeStale = includeTree && !freshTree && remembered.tree_captured_at != null;
    const imageStale = includeScreenshot && !image && remembered.image_captured_at != null;
    // Markers seen by standalone observations (no internal guard/wait context) are
    // candidates for "resident" app chrome; two distinct tree versions confirm it.
    if (!args._waitContext && includeTree && freshTree) {
      this._noteIdleMarkers(args.app, remembered.elements, remembered.tree_version);
    }
    const elements = includeTree ? (query ? filterElements(structured.elements || [], query) : structured.elements || []) : [];
    structured = { ...structured, ...observationFields(remembered), _capture_target_match: captureTargetMatch,
      ...(treeStale ? { tree_stale: true } : {}), ...(imageStale ? { image_stale: true } : {}),
      ...(query ? { query, query_local: false } : {}) };
    if (includeTree && freshTree) structured.elements = elements;
    if (!includeTree) { delete structured.elements; delete structured.tree_markdown; }
    const size = image ? imageSize(image) : { width: 0, height: 0 };
    const meta = [`app=${target.app} snapshot_id=${remembered.snapshot_id || ""}`, observationText(remembered),
      treeStale ? "tree_state=stale(earlier capture, not refreshed)" : null,
      imageStale ? "image_state=stale(earlier capture, not refreshed)" : null,
      structured.degraded ? `degraded=${structured.degraded_reason || true}` : null,
      includeScreenshot ? `screenshot_width=${structured.screenshot_width || size.width} screenshot_height=${structured.screenshot_height || size.height}` : "screenshot omitted",
      includeTree ? `elements=${elements.length}` : "tree omitted", query ? `query=${query}` : null].filter(Boolean).join(" ");
    const text = [meta, includeTree ? trimTreeText(compactElements(elements) || structured.tree_markdown) : null,
      includeScreenshot && !image ? `screenshot unavailable: ${structured.screenshot_error || "missing from driver result"}` : null].filter(Boolean).join("\n");
    const content = [{ type: "text", text }];
    if (image) content.push(image);
    return { ...result, content, structuredContent: structured };
  }

  async _click(args, observe) {
    const target = await this._resolveTarget(args.app, args.window_id);
    const payload = { pid: target.pid, window_id: target.window_id };
    const cached = this.targets.get(normalize(args.app)) || {};
    const rightClick = String(args.mouse_button || "left").toLowerCase() === "right";
    let hit = null;
    let via = null;
    if (args.element_index != null && args.element_index !== "") {
      Object.assign(payload, this._elementFields(args.app, args.element_index));
      hit = Array.isArray(cached.elements)
        ? cached.elements.find((item) => Number(item.element_index) === Number(args.element_index))
        : null;
      via = "ax";
    } else if (args.x != null && args.y != null) {
      const x = Number(args.x);
      const y = Number(args.y);
      payload.x = x;
      payload.y = y;
      hit = cached.tree_actionable === true ? hitTestElement(cached.elements, x, y) : null;
      // A right click is semantically different from a default AX Invoke/Select;
      // preserve its explicit pixel operation instead of upgrading it to AX.
      if (!rightClick && hit && shouldUpgradePixelToAx(hit)) {
        Object.assign(payload, this._elementFields(args.app, hit.element_index));
        delete payload.x;
        delete payload.y;
        via = "ax-from-pixel";
      } else {
        via = "pixel";
      }
    } else {
      return { isError: true, content: [{ type: "text", text: "click needs element_index or x,y" }] };
    }
    if (args.click_count) payload.count = Number(args.click_count);
    if (args.mouse_button) payload.button = args.mouse_button;
    const overlay = clickTargetsOverlay(hit, cached.elements, args.mouse_button);
    const requested = callerDeliveryOpts(args);
    const result = await this._cuaAction("click", payload, observe, {
      overlay,
      foreground: rightClick || requested.foreground === true,
      routeReason: rightClick ? "right_click_foreground" : overlay ? "existing_overlay"
        : requested.routeReason || "default_delivery",
    });
    return annotateHit(result, hit, via);
  }

  async _scroll(args, observe) {
    const target = await this._resolveTarget(args.app, args.window_id);
    const payload = {
      pid: target.pid,
      window_id: target.window_id,
      direction: String(args.direction || "down"),
      by: "page",
      amount: Math.max(1, Number(args.pages) || 1),
    };
    Object.assign(payload, this._elementFields(args.app, args.element_index));
    return this._cuaAction("scroll", payload, observe);
  }

  async _drag(args, observe) {
    const target = await this._resolveTarget(args.app, args.window_id);
    return this._cuaAction("drag", {
      pid: target.pid,
      window_id: target.window_id,
      from_x: Number(args.from_x),
      from_y: Number(args.from_y),
      to_x: Number(args.to_x),
      to_y: Number(args.to_y),
    }, observe);
  }

  async _typeText(args, observe) {
    const target = await this._resolveTarget(args.app, args.window_id);
    const extra = await this._ensureEditableFields(args.app, target.window_id, args.element_index, false);
    const payload = { pid: target.pid, window_id: target.window_id, text: String(args.text ?? ""), ...extra };
    let result = await this._cuaAction("type_text", payload, observe, callerDeliveryOpts(args));
    // AX-less targets (games, custom-drawn canvases) have no ValuePattern read-back;
    // a cheap GetGUIThreadInfo probe at least reports where keyboard focus sits.
    if (IS_WIN && isUnverifiedAction(result)) {
      const focus = readFocusState(this._childEnv(), target.window_id, target.pid);
      if (focus) {
        const note = `focus_state: target_window_foreground=${focus.target_foreground} target_thread_focus=${focus.target_thread_focus}`;
        const content = (result.content || []).map((item) => item && item.type === "text"
          ? { ...item, text: `${item.text} ${note}.` } : item);
        result = { ...result, content, structuredContent: { ...structuredOf(result), focus_state: focus } };
      }
    }
    return result;
  }

  _elementIsEditable(app, elementIndex) {
    if (elementIndex == null || elementIndex === "") return true;
    const cached = this.targets.get(normalize(app)) || {};
    const el = Array.isArray(cached.elements)
      ? cached.elements.find((item) => Number(item.element_index) === Number(elementIndex))
      : null;
    if (!el) return true;
    const role = String(el.role || "").toLowerCase();
    if (SKIP_EDIT_ROLES.has(role)) return false;
    return EDIT_ROLES.has(role);
  }

  _noteIdleMarkers(app, elements, treeVersion) {
    const key = normalize(app || "");
    if (!key || treeVersion == null) return;
    const evidence = cancellationEvidence(elements);
    if (!evidence.markers.length) return;
    const store = this._residentMarkers || (this._residentMarkers = new Map());
    let appMap = store.get(key);
    if (!appMap) { appMap = new Map(); store.set(key, appMap); }
    for (const marker of evidence.markers) {
      const sig = markerSignature(marker);
      const entry = appMap.get(sig) || { count: 0, lastVersion: null };
      if (entry.lastVersion !== treeVersion) { entry.count += 1; entry.lastVersion = treeVersion; }
      appMap.set(sig, entry);
    }
  }

  _markerResidency(app, markers) {
    const store = this._residentMarkers;
    const appMap = store && store.get(normalize(app || ""));
    return (markers || []).map((marker) => {
      const entry = appMap && appMap.get(markerSignature(marker));
      return Boolean(entry && entry.count >= 2);
    });
  }

  _treeSignatureFor(app) {
    const cached = this.targets.get(normalize(app)) || {};
    return cached.tree_actionable === true ? treeSignature(cached.elements) : null;
  }

  // Transport acceptance is not a UI change; but when both the pre-action cached
  // tree and the post-action observation are complete, their signature diff is
  // real evidence either way.
  _applyTreeDiff(beforeSig, mapped) {
    const s = structuredOf(mapped);
    const ar = s.action_result;
    if (!ar || ar.ui_change !== "unknown") return mapped;
    const observation = s.observation;
    if (!observation || !Array.isArray(observation.elements)) return mapped;
    if (!completeFreshTree({ structuredContent: observation }, 400, 20, true)) return mapped;
    const afterSig = treeSignature(observation.elements);
    const changed = afterSig.count !== beforeSig.count || afterSig.hash !== beforeSig.hash;
    return { ...mapped, structuredContent: { ...s, action_result: { ...ar,
      ui_change: changed ? "changed" : "unchanged",
      evidence: [...(ar.evidence || []), { kind: "tree_diff", before_count: beforeSig.count, after_count: afterSig.count }] } } };
  }

  async _postCancellation(args, target, parsed, transport, before, observe, actionEpoch, actionDeadline) {
    let result = win32KeyResult(args.app, parsed, transport);
    const context = { active: true, deadline: Math.min(Date.now() + 10000, actionDeadline || Infinity) };
    let after = { kind: "none", markers: [] };
    let status = "unverified";
    let reason = "post_capture_failed";
    let observation = null;
    try {
      if (this.stoppedByUser || actionEpoch !== (this._sessionEpoch || 0)) {
        reason = this.stoppedByUser ? "stopped_before_reobservation" : "session_changed_before_reobservation";
      } else {
        observation = await this._waitStep(() => this._getAppState({
          app: args.app, window_id: target.window_id, refresh: true,
          include_screenshot: observe === true, include_tree: true, _waitContext: context,
        }), context);
        if (this.stoppedByUser || actionEpoch !== (this._sessionEpoch || 0)) {
          observation = null;
          const error = new Error("Cancellation observation belongs to a replaced or stopped session");
          error.code = this.stoppedByUser ? "stopped_by_user" : "session_changed";
          throw error;
        }
        const guard = liveTreeGuard(observation, target);
        if (!guard.usable) {
          reason = guard.reason;
        } else {
          after = guard.cancellation;
          if (after.markers.length) {
            const residency = this._markerResidency(args.app, after.markers);
            after = { ...after, markers: after.markers.map((marker, i) => ({ ...marker, resident: residency[i] })) };
            // Some apps (Feishu Bitable) keep editor containers in the tree even
            // when nothing is being edited. A marker already seen across two idle
            // observations cannot prove editing is still active.
            if (residency.every(Boolean)) {
              status = "unverified";
              reason = "resident_marker_persistent";
            } else {
              status = "still_present";
              reason = "relevant_editor_or_popup_still_visible";
            }
          } else if (!before.markers.length) {
            reason = "no_positive_before_evidence";
          } else if (guard.complete) {
            status = "closed";
            reason = "all_relevant_markers_absent_in_complete_tree";
          } else {
            reason = "partial_tree_marker_absence_unverified";
          }
        }
      }
    } catch (error) {
      reason = error.code || "post_capture_failed";
    } finally {
      context.active = false;
      if (actionEpoch === (this._sessionEpoch || 0)) this._invalidateTrees(args.app);
    }
    const cancellation = { before, after, status, reason, post_observed: true };
    const positive = before.markers.length
      ? ` Positive ${before.kind} cancellation evidence was observed before Escape.` : "";
    const content = (result.content || []).map((item) => item.type === "text"
      ? { ...item, text: `${item.text}${positive} cancellation_status=${status} reason=${reason}.` } : item);
    if (observe && observation) content.push(...(observation.content || []).map((item) => item.type === "text"
      ? { ...item, text: String(item.text || "").replace(/tree_actionable=true/g, "tree_actionable=false") } : item));
    const observedState = observation ? structuredOf(observation) : null;
    const state = observedState ? { ...observedState, tree_actionable: false } : null;
    result = { ...result, content, structuredContent: {
      ...structuredOf(result), cancellation,
      ...(before.markers.some((marker, i) => marker.kind === "cell_editor" && !this._markerResidency(args.app, before.markers)[i]) ? { cell_editing: true } : {}),
      ...(observe && state ? { ...observationFields(state), ...stalenessFields(state), observation: state } : {}),
    } };
    return result;
  }

  async _sendNativeNavigation(args, target, parsed, menuContext) {
    const actionEpoch = this._sessionEpoch || 0;
    if (this.stoppedByUser) return runtimeError("stopped_by_user", "Computer Use stopped; no key sent", "not_sent");
    // Do not activate an owner over its already-focused native popup. Otherwise
    // prepare the target once, then let the helper validate foreground/focus.
    if (!menuContext) {
      await this._cua("bring_to_front", { pid: target.pid, window_id: target.window_id }).catch(() => {});
    }
    if (this.stoppedByUser || actionEpoch !== (this._sessionEpoch || 0)) {
      return runtimeError(this.stoppedByUser ? "stopped_by_user" : "session_changed",
        "Control session stopped or changed before native key delivery; no key sent", "not_sent");
    }
    const transport = sendWindowsKey(this._childEnv(), target.window_id, target.pid, parsed);
    this._invalidateTrees(args.app);
    if (!transport.ok || (parsed.kind === "press_key" && parsed.key === "return")) this._nativeMenuContext = null;
    return win32KeyResult(args.app, parsed, transport);
  }

  async _pressKey(args, observe) {
    const operationEpoch = this._sessionEpoch || 0;
    const parsed = parseKeyChord(args.key);
    if (!parsed) {
      this._nativeMenuContext = null;
      return { isError: true, content: [{ type: "text", text: "key is required" }] };
    }
    const menuKey = isContextMenuKey(parsed);
    const plainEscape = parsed.kind === "press_key" && parsed.key === "escape";
    // Resolution, fresh guard, delivery and verification share a deadline below
    // the host's 110-second ceiling.
    const operationContext = IS_WIN && (menuKey || plainEscape)
      ? { active: true, deadline: Date.now() + 100000 } : null;
    const target = await this._resolveTarget(args.app, args.window_id, operationContext);
    if (this.stoppedByUser || operationEpoch !== (this._sessionEpoch || 0)) {
      return runtimeError(this.stoppedByUser ? "stopped_by_user" : "session_changed",
        "Control session stopped or changed during key target resolution; no key sent", "not_sent");
    }
    const menuContext = this._menuContextFor(target);
    const plainNavigation = parsed.kind === "press_key" && WINDOWS_NATIVE_NAV_KEYS.has(parsed.key);
    const shiftedTab = parsed.kind === "hotkey" && parsed.keys.length === 2
      && parsed.keys.includes("shift") && parsed.keys.includes("tab");

    if (IS_WIN && (plainNavigation || shiftedTab)) {
      return this._sendNativeNavigation(args, target, parsed, menuContext);
    }

    if (IS_WIN && (menuKey || plainEscape)) {
      if (menuKey) this._nativeMenuContext = null;
      if (!nativeKeyChord(parsed)) {
        return win32KeyResult(args.app, parsed, sendWindowsKey(this._childEnv(), target.window_id, target.pid, parsed));
      }
      const guardEpoch = this._sessionEpoch || 0;
      // A minimized/background target makes the native helper's own activation
      // fail (foreground_mismatch, zero sent). The driver route proved able to
      // restore and foreground the window; do it before the fresh guard capture.
      // Skip while a native menu intent is open: activating the owner could
      // dismiss its popup.
      if (!menuContext) {
        await this._cua("bring_to_front", { pid: target.pid, window_id: target.window_id }).catch(() => {});
        if (this.stoppedByUser || guardEpoch !== (this._sessionEpoch || 0)) {
          return liveGuardBlocked(this.stoppedByUser ? "stopped_by_user" : "session_changed",
            `${menuKey ? "Menu" : "Escape"} blocked because the control session stopped or changed during foreground preparation; no key sent.`, "session_not_current");
        }
      }
      let fresh;
      try {
        fresh = await this._getAppState({ app: args.app, window_id: target.window_id, refresh: true,
          include_screenshot: false, include_tree: true, _waitContext: operationContext });
      } catch (error) {
        const stopped = this.stoppedByUser || error.code === "stopped_by_user";
        const prefix = menuKey ? "menu" : "escape";
        return liveGuardBlocked(stopped ? "stopped_by_user" : error.code === "session_changed" ? "session_changed" : `${prefix}_live_capture_failed`,
          `${menuKey ? "Menu" : "Escape"} blocked because the fresh cancellation guard capture failed; no key sent.`, error.code || "capture_exception");
      }
      if (this.stoppedByUser || guardEpoch !== (this._sessionEpoch || 0)) {
        return liveGuardBlocked(this.stoppedByUser ? "stopped_by_user" : "session_changed",
          `${menuKey ? "Menu" : "Escape"} blocked because the control session stopped or changed after capture; no key sent.`, "session_not_current");
      }
      const guard = liveTreeGuard(fresh, target);
      if (!guard.usable) {
        return liveGuardBlocked(menuKey ? "menu_live_capture_untrusted" : "escape_live_capture_untrusted",
          `${menuKey ? "Menu" : "Escape"} blocked because the fresh cancellation guard was not trustworthy (${guard.reason}); no key sent.`, guard.reason);
      }
      let before = guard.cancellation;
      if (plainEscape && menuContext && before.markers.length === 0) {
        before = { kind: "context_menu", markers: [{ kind: "context_menu", role: null, name: "native menu routing intent", element_index: null }] };
      }
      const hasCancellationEvidence = before.markers.length > 0;
      if (!guard.complete && !hasCancellationEvidence) {
        return liveGuardBlocked(menuKey ? "menu_tree_incomplete" : "escape_cancellation_state_uncertain",
          `${menuKey ? "Menu" : "Escape"} blocked: partial tree had no positive editor or popup evidence; no key sent.`, "incomplete_tree_without_cancellation_evidence");
      }
      if (menuKey && !hasCancellationEvidence) {
        const transport = sendWindowsKey(this._childEnv(), target.window_id, target.pid, parsed);
        this._invalidateTrees(args.app);
        if (transport.ok) this._nativeMenuContext = {
          pid: Number(target.pid), window_id: Number(target.window_id), expiresAt: Date.now() + NATIVE_MENU_CONTEXT_MS,
        };
        return win32KeyResult(args.app, parsed, transport);
      }
      const escape = { kind: "press_key", key: "escape" };
      const transport = sendWindowsKey(this._childEnv(), target.window_id, target.pid, escape);
      this._nativeMenuContext = null;
      return this._postCancellation(args, target, escape, transport, before, observe, guardEpoch, operationContext.deadline);
    }


    // Preserve the established native handling for non-navigation keys while a
    // positively identified in-app overlay is present. Delete/backspace are not
    // enabled outside this guarded route.
    const cached = this.targets.get(normalize(args.app)) || {};
    const editing = cached.tree_actionable === true && treeHasCellEditor(cached.elements);
    const overlay = cached.tree_actionable === true && treeHasContextOverlay(cached.elements);
    if (IS_WIN && overlay && overlayKeyAction(parsed)) {
      const overlayEpoch = this._sessionEpoch || 0;
      await this._cua("bring_to_front", { pid: target.pid, window_id: target.window_id }).catch(() => {});
      if (this.stoppedByUser || overlayEpoch !== (this._sessionEpoch || 0)) {
        return runtimeError(this.stoppedByUser ? "stopped_by_user" : "session_changed",
          "Control session stopped or changed during foreground preparation; no key sent", "not_sent");
      }
      const transport = sendWindowsKey(this._childEnv(), target.window_id, target.pid, parsed);
      this._invalidateTrees(args.app);
      if (!transport.ok) this._nativeMenuContext = null;
      return win32KeyResult(args.app, parsed, transport);
    }

    // An unrelated action can dismiss a native popup; do not carry routing intent across it.
    this._nativeMenuContext = null;
    let extra = this._elementFields(args.app, args.element_index);
    const passedIndex = extra.element_index != null;
    const editableTarget = !passedIndex || this._elementIsEditable(args.app, extra.element_index);
    if (keyNeedsEditorFocus(parsed) && editableTarget && !overlay && !editing && !menuContext) {
      sendUiaFocus(this._childEnv(), target.window_id);
      extra = {};
    }
    const cuaName = parsed.kind === "hotkey" ? "hotkey" : "press_key";
    const payload = parsed.kind === "hotkey"
      ? { pid: target.pid, window_id: target.window_id, keys: parsed.keys, ...extra }
      : { pid: target.pid, window_id: target.window_id, key: parsed.key, ...extra };
    return this._cuaAction(cuaName, payload, observe, callerDeliveryOpts(args));
  }

  async _setValue(args, observe) {
    const target = await this._resolveTarget(args.app, args.window_id);
    const payload = {
      pid: target.pid,
      window_id: target.window_id,
      value: String(args.value ?? ""),
      ...this._elementFields(args.app, args.element_index),
    };
    return this._cuaAction("set_value", payload, observe);
  }

  async _pasteText(args, observe) {
    this._nativeMenuContext = null;
    const target = await this._resolveTarget(args.app, args.window_id);
    if (!args.pasteOnly) {
      const value = String(args.text ?? "");
      const clip = await this._cua("clipboard_write", { text: value }).catch(() => null);
      if (!clip || clip.isError) {
        const wrote = writeClipboardText(value);
        if (!wrote) {
          return runtimeError("clipboard_write_failed", "clipboard write failed; no paste sent", "not_sent");
        }
      }
    }
    if (IS_WIN) {
      await this._cua("bring_to_front", { pid: target.pid, window_id: target.window_id }).catch(() => {});
      if (this.stoppedByUser) return runtimeError("stopped_by_user", "Computer Use stopped; no paste sent", "not_sent");
      const parsed = { kind: "hotkey", keys: ["ctrl", "v"] };
      const transport = sendWindowsKey(this._childEnv(), target.window_id, target.pid, parsed);
      this._invalidateTrees();
      return win32KeyResult(args.app, parsed, transport);
    }
    return this._cuaAction("hotkey", {
      pid: target.pid, window_id: target.window_id, keys: IS_MAC ? ["command", "v"] : ["ctrl", "v"],
    }, observe);
  }

  setTempDir(dir) {
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    this.tempDir = dir;
  }

  _childEnv() {
    const env = { ...process.env };
    if (this.tempDir) {
      env.TMP = this.tempDir;
      env.TEMP = this.tempDir;
      env.TMPDIR = this.tempDir;
    }
    return env;
  }

  binaryPath() {
    const info = probeCua({ verify: true });
    if (!info.installed || info.error || !info.mcpCommand) {
      throw new Error(info.error || "内置运行环境不可用，请重新导入 Windows 版插件包。");
    }
    this.info.exe = info.mcpCommand;
    this.info.version = info.version;
    this.info.mcpArgs = info.mcpArgs && info.mcpArgs.length ? info.mcpArgs : ["mcp"];
    return info;
  }

  snapshot() {
    const probed = probeCua();
    return {
      status: this.status,
      lastError: this.lastError,
      stoppedByUser: this.stoppedByUser,
      bannerActive: Boolean(this.banner && this.banner.active),
      platform: process.platform,
      arch: process.arch,
      exe: this.info.exe || probed.path,
      version: this.info.version || probed.version,
      lastFrame: this.lastFrame,
      stderrTail: this.stderrTail,
      probe: probed,
    };
  }

  async ensureRunning() {
    if (this.status === "running" && this.child) return;
    if (this.stoppedByUser) {
      throw new Error("Computer Use is stopped (Esc or panel). Start it from the Computer Use panel.");
    }
    await this.start();
  }

  start() {
    if (this.status === "running" && this.child) return Promise.resolve();
    if (this._starting) return this._starting;
    this.stoppedByUser = false;
    this.status = "starting";
    this.lastError = "";
    const starting = this._startChild().catch((error) => {
      if (this._starting === starting && !this.stoppedByUser) {
        this.status = "error";
        this.lastError = error instanceof Error ? error.message : String(error);
      }
      throw error;
    }).finally(() => {
      if (this._starting === starting) this._starting = null;
    });
    this._starting = starting;
    return starting;
  }

  async _startChild() {
    this._killChild();
    const info = this.binaryPath();
    const child = spawn(info.mcpCommand, info.mcpArgs, {
      cwd: path.dirname(info.mcpCommand),
      env: this._childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.buf = "";
    this.nextId = this.nextId || 1;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { if (this.child === child) this._onStdout(chunk); });
    child.stderr.on("data", (chunk) => {
      if (this.child !== child) return;
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000);
    });
    const onDead = (why) => {
      if (this.child !== child) return;
      this._sessionEpoch = (this._sessionEpoch || 0) + 1;
      this.targets.clear();
      this._nativeMenuContext = null;
      this._failAll(new Error(why));
      this.child = null;
      if (this.banner) this.banner.stop();
      if (this.status !== "stopped") {
        this.status = "error";
        this.lastError = why;
      }
    };
    child.on("error", (err) => onDead(`runtime spawn failed: ${err.message}`));
    child.on("exit", (code, signal) => {
      onDead(`runtime exited (${signal || code})`);
    });
    try {
      const init = await this._rpcUnlocked(
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "cn.star.computer-use", version: PLUGIN_VERSION },
        },
        START_TIMEOUT_MS,
      );
      if (this.child !== child || this.stoppedByUser) throw new Error("Driver startup was cancelled or replaced");
      this._write({ jsonrpc: "2.0", method: "notifications/initialized" });
      this.status = "running";
      if (init?.serverInfo?.version) this.info.version = init.serverInfo.version;
      await this._cua("set_config", { key: "max_image_dimension", value: MAX_IMAGE_DIMENSION }).catch(() => {});
    } catch (err) {
      if (this.child === child) {
        this._killChild();
        this.status = this.stoppedByUser ? "stopped" : "error";
        this.lastError = err instanceof Error ? err.message : String(err);
      }
      throw err;
    }
  }

  stop(reason) {
    this._controlDepth = 0;
    if (this._bannerHideTimer) {
      clearTimeout(this._bannerHideTimer);
      this._bannerHideTimer = null;
    }
    this.stoppedByUser = true;
    this._starting = null;
    this.status = "stopped";
    this.lastError = reason || "";
    this._failAll(new Error(reason || "Computer Use stopped"));
    if (this.banner) this.banner.stop();
    this._killChild();
  }

  beginControl() {
    this._controlDepth += 1;
    if (this._bannerHideTimer) {
      clearTimeout(this._bannerHideTimer);
      this._bannerHideTimer = null;
    }
    this.ensureBanner();
  }

  endControl() {
    this._controlDepth = Math.max(0, this._controlDepth - 1);
    if (this._controlDepth > 0) return;
    if (this._bannerHideTimer) clearTimeout(this._bannerHideTimer);
    this._bannerHideTimer = setTimeout(() => {
      this._bannerHideTimer = null;
      if (this._controlDepth === 0 && this.banner) this.banner.stop();
    }, 400);
  }

  ensureBanner() {
    if (this.status !== "running") return;
    this.banner.start({
      env: this._childEnv(),
      onEsc: () => {
        if (this.status === "stopped") return;
        this.stop("stopped by Esc");
      },
    });
  }

  _killChild() {
    this._sessionEpoch = (this._sessionEpoch || 0) + 1;
    this.targets.clear();
    this._nativeMenuContext = null;
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }

  _failAll(err) {
    for (const [, rec] of this.pending) {
      clearTimeout(rec.timer);
      rec.reject(err);
    }
    this.pending.clear();
  }

  _write(obj) {
    const child = this.child;
    if (!child) throw new Error("runtime is not running");
    child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  _onStdout(chunk) {
    this.buf += chunk;
    for (;;) {
      const i = this.buf.indexOf("\n");
      if (i < 0) return;
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const rec = this.pending.get(msg.id);
      if (!rec) continue;
      this.pending.delete(msg.id);
      clearTimeout(rec.timer);
      if (msg.error) {
        rec.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        rec.resolve(msg.result);
      }
    }
  }

  _rpcUnlocked(method, params, timeoutMs) {
    const child = this.child;
    if (!child) return Promise.reject(new Error("runtime is not running"));
    const id = this.nextId++;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`runtime timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(payload, (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  _rememberFrame(app, result) {
    if (!result || typeof result !== "object") return;
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter((item) => item && item.type === "text" && item.text)
      .map((item) => item.text)
      .join("\n");
    const image = imageFromResult(result);
    const s = structuredOf(result);
    const cached = this.targets.get(normalize(app)) || {};
    const sameTarget = this.lastFrame && this.lastFrame.app === app
      && this.lastFrame.pid === cached.pid && this.lastFrame.window_id === cached.window_id;
    this.lastFrame = {
      ...observationFields(cached), ...observationFields(s.observation_id != null ? s : cached),
      at: Date.now(),
      app: app ? String(app) : "",
      text,
      imageDataUrl: image
        ? `data:${image.mimeType || "image/png"};base64,${image.data}`
        : sameTarget ? this.lastFrame.imageDataUrl : null,
    };
  }

  doctor() {
    return Promise.resolve(cuaDoctor());
  }
}

// Keep image bytes on the bounded host images channel, never duplicated in JSON.
function publicDiagnostics(value) {
  if (Array.isArray(value)) return value.map(publicDiagnostics);
  if (!value || typeof value !== "object") return value;
  const rawImageKeys = new Set(["screenshot_png_b64", "screenshot_png_base64", "screenshot_base64", "screenshot"]);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !rawImageKeys.has(key))
    .map(([key, item]) => [key, publicDiagnostics(item)]));
}

function presentResult(result, opts = {}) {
  if (!result || typeof result !== "object") {
    return { ok: false, error: "empty runtime result" };
  }
  const observe = opts.observe === true;
  const action = opts.action || "";
  const app = opts.app || "";
  const content = Array.isArray(result.content) ? result.content : [];
  const rawText = content
    .filter((item) => item && item.type === "text")
    .map((item) => String(item.text || ""))
    .join("\n");
  const diagnostics = publicDiagnostics(structuredOf(result));
  const { content: rawContent, images: rawImages, structuredContent: rawStructured, ...metadata } = result;
  const publicMetadata = publicDiagnostics(metadata);

  if (!observe) {
    let text = rawText.trim() || (result.isError ? "tool error" : `ok action=${action} app=${app}`);
    if (opts.region) {
      diagnostics.region_crop = { code: "observe_required", backend: "none" };
      text = `${text}\n[region_* ignored: cropping applies to the post-action screenshot and requires observe=true]`;
    }
    return { ...publicMetadata, ok: !result.isError, ...(result.isError ? { isError: true, error: text } : {}), text,
      content: [{ type: "text", text }], structuredContent: diagnostics };
  }

  let text = trimTreeText(rawText);
  const source = imageFromResult(result) || content.find((item) => item && item.type === "image" && item.data) || null;
  const region = parseRegion(opts.region);
  const images = [];
  if (source && region) {
    const cropResult = require("./image-region").cropImageRegion(source, region, { env: opts.env });
    diagnostics.region_crop = cropResult.diagnostic;
    const cropped = cropResult.ok ? cropResult.image : null;
    const full = compressImageForAgent(source, {
      keepOriginalChars: 0,
      forceJpeg: true,
      maxB64Chars: 100_000,
      qualities: [65, 50],
      maxEdges: [1024, 768],
    });
    const detail = cropped
      ? compressImageForAgent(cropped, {
          qualities: [80, 65, 50],
          maxEdges: [0, 1280],
        })
      : null;
    if (full) images.push(full);
    if (detail) images.push(detail);
    const used = cropped && cropped.region ? cropped.region : region;
    text = detail
      ? `${text}\n[image ${full ? 1 : "none"} = full window; image ${full ? 2 : 1} = region ${used.x},${used.y} ${used.width}x${used.height}; crop backend=${cropResult.diagnostic.backend}. Detail coordinates require scaling to region size, then adding its x/y origin.]`
      : `${text}\n[region ${region.x},${region.y} ${region.width}x${region.height} unavailable: ${cropResult.diagnostic.code}; backend=${cropResult.diagnostic.backend}; full window only]`;
    if (cropped && !detail) diagnostics.region_crop = { ...diagnostics.region_crop, code: "crop_attachment_failed" };
    if (detail) {
      const size = imageSize(detail);
      diagnostics.region_crop.detail_mapping = { origin_x: used.x, origin_y: used.y,
        source_width: used.width, source_height: used.height, attached_width: size.width, attached_height: size.height };
    }
  } else {
    if (opts.region) {
      diagnostics.region_crop = { code: region ? "source_image_missing" : "invalid_region", backend: "none" };
      text += `\n[region unavailable: ${diagnostics.region_crop.code}]`;
    }
    const rawImages = content.filter((item) => item && item.type === "image" && item.data);
    if (!rawImages.length && source) rawImages.push(source);
    images.push(...rawImages.map((item) => compressImageForAgent(item)).filter(Boolean));
    if (!images.length && source) {
      const fallback = compressImageForAgent(source, {
        keepOriginalChars: 0,
        forceJpeg: true,
        maxB64Chars: AGENT_MAX_B64_CHARS,
        qualities: [50, 40, 30],
        maxEdges: [768, 512],
      });
      if (fallback) images.push(fallback);
    }
  }
  if (!images.length && source) {
    text = `${text}\n[screenshot present but too large to attach; try region_* or include_tree=false]`.trim();
  } else if (!images.length && opts.screenshotExpected) {
    text = `${text}\n[screenshot not attached]`.trim();
  }
  if (images.length) {
    const orig = source ? imageSize(source) : { width: 0, height: 0 };
    const already = orig.width && new RegExp(`screenshot_width=${orig.width}\\b`).test(text);
    const bits = [];
    if (orig.width && orig.height && !already) {
      bits.push(`screenshot_width=${orig.width} screenshot_height=${orig.height}`);
    }
    const attached = imageSize(images[0]);
    if (attached.width && orig.width && (attached.width !== orig.width || attached.height !== orig.height)) {
      bits.push(`attached ${attached.width}x${attached.height}; click x,y use screenshot_width/screenshot_height`);
    }
    if (bits.length) text = `${text}\n[${bits.join("; ")}]`.trim();
  }
  const payload = {
    ...publicMetadata,
    structuredContent: diagnostics,
    ...(result.isError ? { isError: true } : {}),
    ok: !result.isError,
    text,
    content: text ? [{ type: "text", text }] : [],
  };
  if (images.length) {
    payload.images = images.map((item) => ({
      mimeType: String(item.mimeType || "image/jpeg"),
      data: String(item.data),
    }));
  }
  if (result.isError) payload.error = text || "tool error";
  return payload;
}

module.exports = {
  ComputerUseRuntime,
  presentResult,
  compressImageForAgent,
  imageFromResult,
  imageSize,
  pickEditableElement,
  originFromBounds,
  localizeElements,
  mergeTreeCache,
  filterElements,
  hitTestElement,
  shouldUpgradePixelToAx,
  describeHit,
  isTypeIndexError,
  isBackgroundUnavailable,
  needsPasteFallback,
  trimTreeText,
  isPasteChord,
  parseKeyChord,
  keyNeedsEditorFocus,
  parseRegion,
};
