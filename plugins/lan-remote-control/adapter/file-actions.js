(() => {
  let activePreview = null;
  const downloads = new Map();
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const read = async (context) => {
    if (typeof window.__piDesktopReadRemoteFile !== "function") throw new Error("远端文件读取服务不可用");
    return window.__piDesktopReadRemoteFile(context);
  };
  const releaseDownload = (url) => {
    clearTimeout(downloads.get(url));
    downloads.delete(url);
    URL.revokeObjectURL(url);
  };
  const save = (file) => {
    const url = URL.createObjectURL(file.blob);
    const link = element("a", "lan-file-download-link");
    link.href = url;
    link.download = file.name || "下载文件";
    document.body.append(link);
    // Chromium 的下载在点击返回后才接管 Blob，侧栏 iframe 也需要保留该 URL。
    downloads.set(url, setTimeout(() => releaseDownload(url), 60000));
    try { link.click(); }
    catch (error) { releaseDownload(url); throw error; }
    finally { link.remove(); }
  };
  const kindOf = (file) => {
    const mime = (file.mimeType || file.blob.type || "").split(";")[0].trim().toLowerCase();
    const extension = (file.name || "").split(".").pop().toLowerCase();
    if (mime === "text/html" || mime === "application/xhtml+xml" || ["html", "htm"].includes(extension)) return "html";
    if (mime === "application/pdf" || extension === "pdf") return "pdf";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("audio/")) return "audio";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("text/") || /^(application\/(json|[\w.+-]+\+json|xml|[\w.+-]+\+xml|javascript|x-javascript|sql|toml|yaml|x-yaml))$/.test(mime)
      || /^(txt|md|mdx|log|csv|tsv|json|jsonc|jsonl|yaml|yml|toml|xml|css|scss|less|js|jsx|mjs|cjs|ts|tsx|py|rs|go|java|c|h|cpp|hpp|cs|sh|bash|zsh|ps1|sql|ini|conf|cfg|env|vue|svelte|rb|php|swift|kt|r)$/.test(extension)) return "text";
    return "binary";
  };
  const preview = async (context) => {
    const previousFocus = activePreview?.previousFocus || document.activeElement;
    activePreview?.close(false);
    const dialog = element("dialog", "lan-file-dialog");
    const panel = element("section", "lan-file-panel");
    const header = element("header", "lan-file-header");
    const title = element("h2", "lan-file-title", context.path);
    const controls = element("div", "lan-file-controls");
    const download = element("button", "lan-file-button", "下载");
    const close = element("button", "lan-file-button", "关闭");
    const body = element("div", "lan-file-body");
    const status = element("p", "lan-file-status", "正在读取文件…");
    const urls = new Set();
    let closed = false;
    let loadedFile = null;
    title.id = "lan-file-preview-title";
    title.title = context.path;
    dialog.setAttribute("aria-labelledby", title.id);
    dialog.setAttribute("aria-modal", "true");
    status.setAttribute("role", "status");
    download.type = close.type = "button";
    download.disabled = true;
    controls.append(download, close);
    header.append(title, controls);
    body.append(status);
    panel.append(header, body);
    dialog.append(panel);
    const state = {
      previousFocus,
      close(restore = true) {
        if (closed) return;
        closed = true;
        for (const media of body.querySelectorAll("audio, video")) {
          media.pause();
          media.removeAttribute("src");
          media.load();
        }
        for (const frame of body.querySelectorAll("iframe")) frame.src = "about:blank";
        for (const image of body.querySelectorAll("img")) image.removeAttribute("src");
        dialog.close();
        dialog.remove();
        for (const url of urls) URL.revokeObjectURL(url);
        urls.clear();
        if (activePreview === state) activePreview = null;
        if (restore && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      },
    };
    activePreview = state;
    const showError = (error) => {
      status.textContent = `文件读取或预览失败：${error instanceof Error ? error.message : String(error)}`;
      status.setAttribute("role", "alert");
      if (!status.isConnected) body.append(status);
    };
    close.addEventListener("click", () => state.close());
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); state.close(); });
    dialog.addEventListener("click", (event) => { if (event.target === dialog) state.close(); });
    download.addEventListener("click", () => {
      try { save(loadedFile); }
      catch (error) { showError(error); }
    });
    document.body.append(dialog);
    dialog.showModal();
    close.focus({ preventScroll: true });
    try {
      const file = await read(context);
      if (closed) return;
      loadedFile = file;
      title.textContent = file.name || context.path;
      download.disabled = false;
      const kind = kindOf(file);
      if (kind === "binary") {
        status.textContent = "此文件类型无法预览，请下载后查看。";
        return;
      }
      let content;
      if (kind === "text" || kind === "html") {
        const bytes = new Uint8Array(await file.blob.arrayBuffer());
        if (closed) return;
        let text;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { text = null; }
        if (text === null || /[\u0000-\u0008\u000b\u000e-\u001f]/.test(text)) {
          status.textContent = "此文件包含二进制内容或不支持的文本编码，无法预览，请下载后查看。";
          return;
        }
        if (kind === "text") {
          content = element("pre", "lan-file-text");
          content.textContent = text;
          content.tabIndex = 0;
        }
      }
      if (!content) {
        const tag = { html: "iframe", pdf: "iframe", image: "img", audio: "audio", video: "video" }[kind];
        content = element(tag, `lan-file-media lan-file-${kind}`);
        if (kind === "html") content.setAttribute("sandbox", "allow-scripts");
        if (tag === "iframe") content.title = file.name || "文件预览";
        if (tag === "img") content.alt = file.name || "图片预览";
        if (tag === "audio" || tag === "video") { content.controls = true; content.preload = "metadata"; }
        content.addEventListener("error", () => { if (!closed) showError(new Error("无法显示文件，请下载后查看")); });
        if (kind === "html" && file.previewUrl) {
          content.src = file.previewUrl;
        } else {
          const blob = kind === "html" || kind === "pdf"
            ? new Blob([file.blob], { type: kind === "html" ? "text/html" : "application/pdf" }) : file.blob;
          const url = URL.createObjectURL(blob);
          urls.add(url);
          content.src = url;
        }
      }
      body.replaceChildren(content);
    } catch (error) {
      if (!closed) showError(error);
      throw error;
    }
  };
  window.addEventListener("pagehide", () => {
    activePreview?.close(false);
    for (const url of downloads.keys()) releaseDownload(url);
  });
  window.__piDesktopFileMenu = {
    actions(context) {
      const fileContext = { path: context.path };
      if (context.sessionId !== undefined) fileContext.sessionId = context.sessionId;
      return [
        { id: "preview", label: "预览", run: () => preview(fileContext) },
        { id: "download", label: "下载", run: async () => { save(await read(fileContext)); } },
      ];
    },
  };
})();
