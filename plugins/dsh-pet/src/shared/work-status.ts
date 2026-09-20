// 工作状态联动（workStatus）—— 两端共用的纯逻辑（src/shared 单一来源）。
//
// 移植说明（CK-PI-Desktop）：原版这里还有一个 `fetchWorkStatus()`，通过 DSH 宿主的
// `/dsh-pet-7340/work-status` 端点轮询。移植后聚合状态改由插件主进程（main.cjs）
// 直接读取这是一个助手的会话事件得到，并随 `pet.sync` 一起下发——所以本模块只保留：
//   档位常量（WORK_STATUS_STATES / WORK_STATUS_INDEX，与 events.workStatus 数组索引一致）
//   + 下发改包的解析（normalizeWorkStatus）。
// 气泡文案仍不在代码里：读配置的 workStatusTexts（与上游同一套语义）。
// 纯函数无副作用；不依赖 React/DOM。
/** 工作状态档位（对应 animations.events.workStatus 数组索引，顺序即档位，勿在中间插入新档） */
export const WORK_STATUS_STATES = ['thinking', 'working', 'result', 'waiting', 'success', 'error'] as const;
export type WorkStatusState = (typeof WORK_STATUS_STATES)[number];

/** 档位 → workStatus 数组索引（与 events.workStatus 数组顺序严格一致） */
export const WORK_STATUS_INDEX: Record<WorkStatusState, number> = {
  thinking: 0, // turn/start → 思考
  working: 1, // tool/call → 工作
  result: 2, // tool/result → 整理
  waiting: 3, // approval/asked → 等待
  success: 4, // turn/end completed → 完成
  error: 5, // turn/end error/max-tokens → 出错
};

/** 工作状态快照（插件主进程 → 宠物窗口下发的形状；两端按此结构校验）。
 *  text 不在此：气泡文案由渲染端读配置 workStatusTexts，主进程不生成。 */
export interface WorkStatusSnapshot {
  state: WorkStatusState | null; // null = 空闲
  task: string | null; // 当前任务详情（会话进行中的工具/待办描述，可 null）
  ts: number; // 最近一次变化的时间戳（轮询侧检测变化用）
}

/** 下发改包 → 快照；结构非法/未知档位显式回落为空闲，绝不伪造状态 */
export function normalizeWorkStatus(raw: unknown): WorkStatusSnapshot {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const state = value.state;
  return {
    state:
      typeof state === 'string' && (WORK_STATUS_STATES as readonly string[]).includes(state)
        ? (state as WorkStatusState)
        : null,
    task: typeof value.task === 'string' && value.task ? value.task : null,
    ts: Number(value.ts) || 0,
  };
}
