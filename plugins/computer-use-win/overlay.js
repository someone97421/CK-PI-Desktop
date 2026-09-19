"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const BANNER_TEXT = "AI 正在控制你的电脑进行作业，可以按 ESC 强行打断";

class ControlBanner {
  constructor() {
    this.child = null;
    this.buf = "";
  }

  get active() {
    return Boolean(this.child);
  }

  start({ env, onEsc }) {
    if (process.platform !== "win32") return;
    if (this.child) return;
    const script = path.join(__dirname, "scripts", "windows-banner.ps1");
    if (!fs.existsSync(script)) return;
    const childEnv = { ...(env || process.env), OCU_BANNER_TEXT: BANNER_TEXT };
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-STA",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
    ], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      this.buf += chunk;
      for (;;) {
        const i = this.buf.indexOf("\n");
        if (i < 0) return;
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line === "esc" || line.toLowerCase() === "esc") {
          try { onEsc && onEsc(); } catch { /* ignore */ }
        }
      }
    });
    const clear = () => {
      if (this.child === child) this.child = null;
    };
    child.on("exit", clear);
    child.on("error", clear);
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { child.kill(); } catch { /* ignore */ }
  }
}

module.exports = { ControlBanner, BANNER_TEXT };
