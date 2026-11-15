"use strict";

const RESOURCE_SCHEMES = new Set(["pi-genui", "plugin-renderer", "plugin-asset", "appearance-media"]);
const SCHEMES = "(?:pi-genui|plugin-renderer|plugin-asset|appearance-media)";

function resourceProxyUrl(value, token) {
  const url = new URL(value);
  if (!RESOURCE_SCHEMES.has(url.protocol.slice(0, -1)) || !url.hostname || url.username || url.password || url.port) return null;
  return `/api/resource/${encodeURIComponent(token)}/${url.protocol.slice(0, -1)}/${encodeURIComponent(url.hostname)}${url.pathname || "/"}${url.search}${url.hash}`;
}

function rewriteResourceCsp(value) {
  return value.replace(new RegExp(`${SCHEMES}:(?:\\/\\/[^\\s;"']+)?`, "gi"), "'self'");
}

function rewriteResourceText(value, { token, url, html = false }) {
  let content = value;
  if (html) {
    content = content.replace(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => {
      if (!/\bhttp-equiv\s*=\s*(["'])Content-Security-Policy\1/i.test(tag)) return tag;
      return tag.replace(/(\bcontent\s*=\s*)(["'])([\s\S]*?)\2/i, (_, prefix, quote, policy) => {
        const rewritten = rewriteResourceCsp(policy);
        return `${prefix}${quote}${quote === "'" ? rewritten.replace(/'/g, "&#39;") : rewritten}${quote}`;
      });
    });
  }
  content = content.replace(new RegExp(`\\b${SCHEMES}:\\/\\/[^\\s"'<>\x60\\\\)]+`, "gi"), (value) => {
    try { return resourceProxyUrl(value, token) ?? value; } catch { return value; }
  });
  const relative = (match, prefix, reference) => {
    if (reference.startsWith("/api/resource/")) return match;
    try { return `${prefix}${resourceProxyUrl(new URL(reference, url), token) ?? reference}`; }
    catch { return match; }
  };
  return content.replace(/(["'`])((?:\/|\.{1,2}\/)[^\s"'`<>\\)]*)/g, relative)
    .replace(/(url\(\s*)((?:\/|\.{1,2}\/)[^\s"'<>\\)]*)/gi, relative);
}

module.exports = { RESOURCE_SCHEMES, resourceProxyUrl, rewriteResourceCsp, rewriteResourceText };
