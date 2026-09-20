// src/shared —— 移植自 dsh-pet 的纯逻辑层（上游 src/shared 的子集）。
// 打包脚本用 esbuild 把它打成 widget/shared-core.js（IIFE，挂到 window.PetShared），
// 供透明宠物窗口以经典 script 加载（file:// 页面不能用 ESM，与上游同一原因）。
//
// 与上游的差异（只删不改）：原版的 balance / whisper / chat / notify 依赖 DSH 专用能力
// （服务商余额端点、DSH 会话对话 API、DSH 系统通知），移植时整体移除，见根目录 README 的移植矩阵。
export * from './types';
export * from './constants';
export * from './pickers';
export * from './displays';
export * from './motion';
export * from './config';
export * from './menu';
export * from './physics';
export * from './score';
export * from './score-popup';
export * from './work-status';
