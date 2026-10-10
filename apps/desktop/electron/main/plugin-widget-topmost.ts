import type { BrowserWindow } from "electron";

const WM_WINDOWPOSCHANGED = 0x0047;
const preferences = new WeakMap<BrowserWindow, { alwaysOnTop: boolean; repairFailed: boolean }>();

function applyTopmost(window: BrowserWindow, value: boolean) {
  // Windows 的 floating 会把窗口排到任务栏后，任务栏非置顶时会连带降级。
  if (process.platform === "win32" && value && preferences.has(window)) window.setAlwaysOnTop(true, "screen-saver");
  else window.setAlwaysOnTop(value);
}

/** Windows 原生层级变化不能覆盖用户选择的 widget 置顶状态。 */
export function installWidgetTopmost(window: BrowserWindow, alwaysOnTop: boolean) {
  if (process.platform !== "win32" || preferences.has(window)) return;
  const preference = { alwaysOnTop, repairFailed: false };
  preferences.set(window, preference);
  let pending: NodeJS.Immediate | undefined;
  let lastRepairAt = -Infinity;
  const reconcile = () => {
    pending = undefined;
    if (
      !preference.alwaysOnTop || window.isDestroyed() ||
      !window.isVisible() || window.isMinimized()
    ) return;
    if (window.isAlwaysOnTop()) {
      preference.repairFailed = false;
      return;
    }
    // 一次恢复失败后停止重试，防止原生层级消息形成自激循环。
    if (preference.repairFailed || Date.now() - lastRepairAt < 1000) return;
    // 异步到达的外部降级消息也不能引发高速恢复循环。
    lastRepairAt = Date.now();
    preference.repairFailed = true;
    applyTopmost(window, true);
    preference.repairFailed = !window.isAlwaysOnTop();
  };
  const schedule = () => {
    if (!preference.alwaysOnTop || pending || window.isDestroyed()) return;
    // 等原生消息处理完成后再检查；同一轮变化合并，恢复成功后不会重复写入。
    pending = setImmediate(reconcile);
  };
  const resume = () => {
    preference.repairFailed = false;
    lastRepairAt = -Infinity;
    schedule();
  };
  window.hookWindowMessage(WM_WINDOWPOSCHANGED, schedule);
  window.on("show", resume);
  window.on("restore", resume);
  // 创建选项只有布尔值，显示前统一切换到 Windows 的稳定层级。
  if (alwaysOnTop) applyTopmost(window, true);
  window.once("closed", () => {
    if (pending) clearImmediate(pending);
    preferences.delete(window);
    window.removeListener("show", resume);
    window.removeListener("restore", resume);
    // 原生消息 hook 随窗口销毁释放，closed 后不再调用原生窗口方法。
  });
}

/** 菜单和插件接口先更新用户意图，再改变原生状态，避免关闭置顶被自动撤销。 */
export function setWidgetAlwaysOnTop(window: BrowserWindow, value: boolean) {
  const preference = preferences.get(window);
  if (preference) {
    preference.alwaysOnTop = value;
    preference.repairFailed = false;
  }
  applyTopmost(window, value);
}
