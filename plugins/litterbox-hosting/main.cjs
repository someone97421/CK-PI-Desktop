"use strict";
const { uploadFile } = require("./upload.cjs");
const manifest = require("./manifest.json");
const active = new Set();
let panelUpload;
let panelState = { status:"idle" };
async function upload(args, signal) {
  const controller = new AbortController();
  active.add(controller);
  try { return await uploadFile(pi.fs, args, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal); }
  finally { active.delete(controller); }
}
async function onLoad() {
  await pi.commands.register({ id:"litterbox.open", title:"Litterbox 文件托管", run:() => pi.ui.openPanel({ title:"Litterbox 文件托管" }) });
  await pi.agent.registerTool({ ...manifest.contributes.agentTools[0], execute:(args, context) => upload(args, context?.signal) });
  await pi.agent.registerTool({ ...manifest.contributes.agentTools[1], execute:async (args) => {
    const url = new URL(args.url);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("请提供无账号密码的公网 HTTPS 媒体直链。");
    if (!/^(image|audio|video)\/[a-z0-9.+-]+$/.test(args.mimeType)) throw new Error("请指定图片、音频或视频的 MIME 类型。");
    if (args.size !== undefined && (!Number.isSafeInteger(args.size) || args.size < 0 || args.size > 100_000_000)) throw new Error("媒体文件不能超过 100 MB。");
    return { ok:true, mediaUrl:{ url:url.href, mimeType:args.mimeType, ...(args.size !== undefined ? { size:args.size } : {}) } };
  } });
}
async function onPanelInvoke(channel, args) {
  if (channel === "upload") {
    if (panelUpload) throw new Error("已有上传正在进行。");
    panelUpload = new AbortController();
    panelState = { status:"uploading" };
    // 面板 RPC 只有 30 秒；上传状态独立保存，查询不占用长连接。
    void upload(args, panelUpload.signal).then(
      result => { panelState = { status:"done", result }; },
      error => { panelState = { status:"error", error:String(error.message || error) }; },
    ).finally(() => { panelUpload = undefined; });
    return panelState;
  }
  if (channel === "status") return panelState;
  if (channel === "cancel") { panelUpload?.abort(); return { ok:true }; }
  if (channel === "copy") { await pi.clipboard.writeText(String(args.text || "")); return { ok:true }; }
  throw new Error("未知面板操作。");
}
async function onUnload() {
  for (const controller of active) controller.abort();
  for (const tool of manifest.contributes.agentTools) await pi.agent.unregisterTool(tool.name);
  await pi.commands.unregister("litterbox.open");
}
module.exports = { onLoad, onUnload, onPanelInvoke };
