"use strict";

const DENY_RULES = [
  {
    id: "password-manager",
    patterns: ["1password", "bitwarden", "dashlane", "lastpass", "nordpass", "proton pass", "protonpass"],
  },
  {
    id: "terminal",
    patterns: [
      "windows terminal",
      "windowsterminal",
      "command prompt",
      "cmd.exe",
      "powershell",
      "pwsh",
      "windows powershell",
    ],
  },
  { id: "lock", patterns: ["lockapp", "lock app"] },
  {
    id: "security",
    patterns: ["windows security", "windows defender", "virus & threat"],
  },
  {
    id: "self",
    patterns: ["pi-desktop", "pi desktop", "chatgpt", "codex"],
  },
];

function normalize(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function parseAllowlist(raw) {
  return String(raw || "")
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function recordHaystack(record) {
  if (record == null) return "";
  if (typeof record === "string" || typeof record === "number") return normalize(record);
  return normalize(
    [
      record.name,
      record.app,
      record.app_name,
      record.title,
      record.bundle_id,
      record.launch_path,
      record.path,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function deniedReason(appOrRecord) {
  const name = recordHaystack(appOrRecord);
  if (!name) return "app is required";
  for (const rule of DENY_RULES) {
    if (rule.patterns.some((pattern) => name.includes(pattern))) {
      const label = typeof appOrRecord === "object" && appOrRecord
        ? appOrRecord.name || appOrRecord.app_name || appOrRecord.title || JSON.stringify(appOrRecord)
        : appOrRecord;
      return `blocked app (${rule.id}): ${label}`;
    }
  }
  return null;
}

function allowedByUser(appOrRecord, allowlist) {
  if (!allowlist.length) return true;
  const name = recordHaystack(appOrRecord);
  return allowlist.some((item) => {
    const token = normalize(item);
    return token && (name === token || name.includes(token));
  });
}

function selfPids() {
  const pids = new Set();
  const pid = Number(process.pid);
  const ppid = Number(process.ppid);
  if (pid) pids.add(pid);
  if (ppid) pids.add(ppid);
  return pids;
}

function isSelfPid(pid, extra) {
  const value = Number(pid);
  if (!value) return false;
  if (selfPids().has(value)) return true;
  if (extra && extra.has(value)) return true;
  return false;
}

function gateApp(app, settings) {
  const reason = deniedReason(app);
  if (reason) return reason;
  const allowlist = parseAllowlist(settings?.allowlist);
  if (!allowedByUser(app, allowlist)) {
    return `app is not on the allowlist: ${typeof app === "object" ? app.name || app.app_name : app}`;
  }
  return null;
}

function gateRecord(record, settings) {
  if (!record) return "target is required";
  if (isSelfPid(record.pid)) return `blocked self pid: ${record.pid}`;
  return gateApp(record.name || record.app_name || record.title || record, settings);
}

function filterRecords(records, settings) {
  const allowlist = parseAllowlist(settings?.allowlist);
  return (records || []).filter((record) => {
    if (isSelfPid(record.pid)) return false;
    if (deniedReason(record)) return false;
    return allowedByUser(record, allowlist);
  });
}

function namesMatch(query, record) {
  const needle = normalize(query);
  if (!needle) return false;
  const hay = recordHaystack(record);
  return hay === needle || hay.includes(needle) || needle.includes(normalize(record.name || record.app_name || ""));
}

module.exports = {
  DENY_RULES,
  parseAllowlist,
  deniedReason,
  allowedByUser,
  gateApp,
  gateRecord,
  filterRecords,
  selfPids,
  isSelfPid,
  namesMatch,
  normalize,
};
