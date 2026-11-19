import "./lan-password-gate.css";

export function createLanPasswordGate(authenticate: (username: string, password: string) => Promise<void>, options: { sidepanel?: boolean } = {}) {
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const page = element("main", "lan-password-gate");
  const card = element("section", "lan-gate-card");
  card.setAttribute("aria-labelledby", "lan-gate-title");
  const header = element("header", "lan-gate-header");
  const mark = element("span", "lan-gate-mark");
  mark.setAttribute("aria-hidden", "true");
  mark.append(element("span", "lan-gate-screen", "✓"));
  const identity = element("div", "lan-gate-identity");
  identity.append(element("p", "lan-gate-eyebrow", "这是一个助手"), element("p", "lan-gate-product", options.sidepanel ? "浏览器侧栏" : "局域网远控"));
  header.append(mark, identity);
  const title = element("h1", "lan-gate-title", "连接你的主机");
  title.id = "lan-gate-title";
  const endpoint = element("div", "lan-gate-endpoint");
  endpoint.append(element("span", "lan-gate-endpoint-label", "主机"));
  const address = element("span", "lan-gate-address");
  try {
    const server = new URL(new URLSearchParams(window.location.search).get("server") || window.location.origin);
    address.textContent = server.host;
  } catch { address.textContent = "当前主机"; }
  endpoint.append(address);

  const form = element("form", "lan-gate-form");
  const usernameLabel = element("label", "lan-gate-label", "用户名");
  usernameLabel.htmlFor = "lan-gate-username";
  const usernameField = element("input", "lan-gate-input");
  usernameField.id = "lan-gate-username";
  usernameField.name = "username";
  usernameField.autocomplete = "username";
  usernameField.autocapitalize = "none";
  usernameField.spellcheck = false;
  usernameField.placeholder = "默认用户名：admin";
  usernameField.required = true;
  usernameField.setAttribute("aria-describedby", "lan-gate-hint lan-gate-status");
  const label = element("label", "lan-gate-label", "访问密码");
  label.htmlFor = "lan-gate-password";
  const fieldGroup = element("div", "lan-gate-field");
  const field = element("input", "lan-gate-input");
  field.id = "lan-gate-password";
  field.type = "password";
  field.name = "password";
  field.autocomplete = "current-password";
  field.placeholder = "输入主机访问密码";
  field.setAttribute("aria-describedby", "lan-gate-hint lan-gate-status");
  field.required = true;
  const reveal = element("button", "lan-gate-reveal", "显示");
  reveal.type = "button";
  reveal.setAttribute("aria-label", "显示密码");
  reveal.setAttribute("aria-pressed", "false");
  fieldGroup.append(field, reveal);
  const hint = element("p", "lan-gate-hint", "使用桌面端远控设置中的用户名和密码。");
  hint.id = "lan-gate-hint";
  const submit = element("button", "lan-gate-submit", "连接主机");
  submit.type = "submit";
  const status = element("output", "lan-gate-status lan-gate-hint");
  status.id = "lan-gate-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  form.append(usernameLabel, usernameField, label, fieldGroup, hint, submit, status);
  const footer = element("p", "lan-gate-footer", "远程连接 · V2");
  card.append(header, title, endpoint, form, footer);
  page.append(card);
  const root = document.getElementById("root");
  if (!root) throw new Error("root element missing");
  root.replaceChildren(page);

  let disposed = false;
  let pending = false;
  const hidePassword = () => {
    field.type = "password";
    reveal.textContent = "显示";
    reveal.setAttribute("aria-label", "显示密码");
    reveal.setAttribute("aria-pressed", "false");
  };
  const setPending = (value: boolean, message: string) => {
    if (disposed) return;
    pending = value;
    usernameField.disabled = value;
    field.disabled = value;
    submit.disabled = value;
    reveal.disabled = value;
    form.setAttribute("aria-busy", String(value));
    status.textContent = message;
    status.setAttribute("data-tone", value ? "pending" : "error");
    usernameField.setAttribute("aria-invalid", String(!value && !!message));
    field.setAttribute("aria-invalid", String(!value && !!message));
    submit.textContent = value ? message : "连接主机";
  };
  const onReveal = () => {
    if (pending || disposed) return;
    if (field.type === "text") hidePassword();
    else {
      field.type = "text";
      reveal.textContent = "隐藏";
      reveal.setAttribute("aria-label", "隐藏密码");
      reveal.setAttribute("aria-pressed", "true");
    }
  };
  const onInput = () => {
    if (pending || disposed) return;
    status.textContent = "";
    usernameField.setAttribute("aria-invalid", "false");
    field.setAttribute("aria-invalid", "false");
  };
  const onSubmit = (event: Event) => {
    event.preventDefault();
    if (pending || disposed) return;
    const username = usernameField.value.trim();
    if (!username) {
      usernameField.value = "";
      usernameField.reportValidity();
      return;
    }
    const password = field.value;
    field.value = "";
    hidePassword();
    setPending(true, "正在认证…");
    void Promise.resolve().then(() => authenticate(username, password)).catch((error: unknown) => {
      if (disposed) return;
      setPending(false, error instanceof Error ? error.message : String(error));
      field.focus();
    });
  };
  reveal.addEventListener("click", onReveal);
  usernameField.addEventListener("input", onInput);
  field.addEventListener("input", onInput);
  form.addEventListener("submit", onSubmit);
  if (!options.sidepanel) usernameField.focus();
  return {
    connecting: () => setPending(true, "正在连接…"),
    reconnecting: () => setPending(true, "正在重连…"),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      field.value = "";
      form.removeEventListener("submit", onSubmit);
      usernameField.removeEventListener("input", onInput);
      field.removeEventListener("input", onInput);
      reveal.removeEventListener("click", onReveal);
      page.remove();
    },
  };
}
