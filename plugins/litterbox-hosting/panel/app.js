const $ = (id) => document.getElementById(id);
const invoke = (channel, args = {}) => window.pluginBridge.invoke(channel, args);
let polling;
function render(state) {
  const busy = state.status === "uploading";
  $("upload").disabled = busy; $("cancel").disabled = !busy;
  if (busy) $("status").textContent = "正在上传……关闭面板后可重新打开查看结果。";
  if (state.status === "done") {
    const result = state.result;
    $("url").value = result.url; $("result").hidden = false;
    $("status").textContent = `上传成功 · ${(result.size / 1_000_000).toFixed(2)} MB\n预计到期：${new Date(result.expiresAt).toLocaleString()}${result.warning ? "\n" + result.warning : ""}`;
  }
  if (state.status === "error") $("status").textContent = `上传未完成：${state.error}`;
  clearTimeout(polling);
  if (busy) polling = setTimeout(refresh, 1500);
}
async function refresh() {
  try { render(await invoke("status")); }
  catch (error) { $("status").textContent = error.message; $("upload").disabled = false; }
}
$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("upload").disabled = true; $("cancel").disabled = false; $("result").hidden = true;
  $("status").textContent = "正在上传，请保持面板开启……";
  try {
    render(await invoke("upload", { path:$("path").value, expiration:$("expiration").value }));
  } catch (error) { $("status").textContent = `上传未完成：${error.message || error}`; }
  finally { await refresh(); }
});
$("cancel").onclick = () => invoke("cancel").catch((error) => { $("status").textContent = error.message; });
$("copy").onclick = () => invoke("copy", { text:$("url").value }).then(() => { $("status").textContent = "链接已复制。"; }).catch((error) => { $("status").textContent = error.message; });
void refresh();
