export function createLanPasswordGate(authenticate: (password: string) => Promise<void>) {
  const form = document.createElement("form");
  const field = document.createElement("input");
  field.type = "password";
  field.name = "password";
  field.autocomplete = "current-password";
  field.placeholder = "主机密码";
  field.setAttribute("aria-label", "主机密码");
  field.required = true;
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "连接";
  const status = document.createElement("output");
  status.className = "hint";
  status.setAttribute("aria-live", "polite");
  form.append(field, submit, status);
  const root = document.getElementById("root");
  if (!root) throw new Error("root element missing");
  root.replaceChildren(form);

  const setPending = (pending: boolean, message: string) => {
    field.disabled = pending;
    submit.disabled = pending;
    status.textContent = message;
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const password = field.value;
    field.value = "";
    setPending(true, "正在认证…");
    void authenticate(password).catch((error: unknown) => {
      setPending(false, error instanceof Error ? error.message : String(error));
      field.focus();
    });
  });
  field.focus();
  return {
    connecting: () => setPending(true, "正在连接…"),
    reconnecting: () => setPending(true, "正在重连…"),
    dispose: () => form.remove(),
  };
}
