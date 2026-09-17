import { button, el } from "../dom.js";
import { DEVICE_NAME_STORAGE_KEY, suggestDeviceName } from "../protocol.js";

/** 手机直接输入主机密码登录，不再等待电脑二次批准。 */
export function createLoginView({ login, onSuccess, onError }) {
  let savedName = "";
  try { savedName = localStorage.getItem(DEVICE_NAME_STORAGE_KEY) || ""; } catch {}
  const name = el("input", { value: savedName || suggestDeviceName(navigator.userAgent),
    attrs: { maxlength: 64, required: true, "aria-label": "设备名称", autocomplete: "nickname" } });
  const password = el("input", { type: "password", attrs: { required: true, maxlength: 256, "aria-label": "访问密码", placeholder: "输入电脑设置的访问密码", autocomplete: "current-password" } });
  const submit = button("登录", { type: "submit", variant: "primary", iconName: "login" });
  const form = el("form", { className: "connect-card login-form" }, el("h1", { text: "连接你的助手" }),
    el("p", { text: "输入主机密码；登录后记住这台设备。" }),
    el("label", {}, "设备名称", name), el("label", {}, "访问密码", password), submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    try {
      const result = await login(password.value, name.value);
      password.value = "";
      try { localStorage.setItem(DEVICE_NAME_STORAGE_KEY, name.value); } catch {}
      await onSuccess(result);
    } catch (error) {
      password.value = "";
      onError(error.code === "UNAUTHORIZED" ? new Error("访问密码错误，请重新输入。") : error);
      password.focus();
    }
    finally { submit.disabled = false; }
  });
  return form;
}
