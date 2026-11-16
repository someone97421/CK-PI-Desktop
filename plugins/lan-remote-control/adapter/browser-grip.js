(() => {
  const parentOrigin = new URLSearchParams(location.search).get("parentOrigin");
  if (parent === window || !/^chrome-extension:\/\/[a-p]{32}$/.test(parentOrigin || "")) return;
  const marker = "lan-composer-grip";
  let pending = null;
  let frame = null;
  let hint = null;
  let hintTimer = null;
  let flight = null;
  const post = (action, sessionId, cancel = false) => parent.postMessage({
    type: "pi-desktop:element-picker", action, sessionId, ...(action === "end" ? { cancel } : {}),
  }, parentOrigin);
  function hideHint() { clearTimeout(hintTimer); hint?.remove(); hint = null; }
  function showHint(button, text, error = false) {
    hideHint();
    if (!button.isConnected) return;
    const rect = button.getBoundingClientRect();
    hint = document.createElement("div");
    hint.className = "lan-grip-hint";
    hint.setAttribute("role", error ? "alert" : "tooltip");
    hint.textContent = text;
    hint.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 220))}px`;
    hint.style.top = `${Math.max(8, rect.top - 42)}px`;
    document.body.append(hint);
    if (error) hintTimer = setTimeout(hideHint, 4500);
  }
  function clearPending(cancel = false) {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.button.removeAttribute("data-dragging");
    if (cancel) post("end", pending.id, true);
    pending = null;
  }
  function animate(button) {
    flight?.remove(); flight = null;
    if (!button.isConnected || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const input = button.closest(".composer-shell")?.querySelector(".composer-input");
    if (!input) return;
    const from = button.getBoundingClientRect(), to = input.getBoundingClientRect();
    const icon = document.createElement("span");
    icon.className = "lan-grip-flight";
    icon.setAttribute("aria-hidden", "true");
    icon.append(button.firstElementChild.cloneNode(true));
    icon.style.left = `${from.left + from.width / 2 - 8}px`;
    icon.style.top = `${from.top + from.height / 2 - 8}px`;
    document.body.append(icon); flight = icon;
    const animation = icon.animate([
      { transform: "translate(0,0) scale(1)", opacity: 0.8 },
      { transform: `translate(${to.left + Math.min(32, to.width / 2) - from.left}px,${to.top + Math.min(20, to.height / 2) - from.top}px) scale(.35)`, opacity: 0 },
    ], { duration: 380, easing: "ease-out", fill: "forwards" });
    animation.onfinish = () => { icon.remove(); if (flight === icon) flight = null; };
  }
  function mount() {
    frame = null;
    for (const left of document.querySelectorAll(".composer-toolbar .composer-left")) {
      if (left.querySelector(`.${marker}`)) continue;
      const plus = left.querySelector(".composer-plus");
      if (!plus) continue;
      const button = document.createElement("button");
      button.type = "button"; button.draggable = true;
      button.className = `icon-btn icon-btn-square ${marker}`;
      button.setAttribute("aria-label", "拖动捕捉网页元素");
      button.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M22 12h-4M6 12H2M12 6V2M12 22v-4"/></svg>';
      const help = () => showHint(button, "按住拖到网页，松手添加元素引用；Esc 取消");
      button.addEventListener("pointerenter", help);
      button.addEventListener("focus", help);
      button.addEventListener("pointerleave", hideHint);
      button.addEventListener("blur", hideHint);
      button.addEventListener("click", (event) => event.preventDefault());
      button.addEventListener("dragstart", (event) => {
        if (!event.dataTransfer) { event.preventDefault(); return; }
        hideHint(); clearPending(true);
        const id = crypto.randomUUID();
        pending = { id, button, timer: setTimeout(() => {
          if (pending?.id !== id) return;
          clearPending(true); showHint(button, "捕捉未完成，请重试", true);
        }, 80000) };
        button.dataset.dragging = "true";
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(`application/x-browse-element-${id}`, id);
        const dragImage = document.createElement("canvas");
        dragImage.width = dragImage.height = 1;
        dragImage.setAttribute("aria-hidden", "true");
        dragImage.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none";
        document.body.append(dragImage);
        event.dataTransfer.setDragImage(dragImage, 0, 0);
        requestAnimationFrame(() => dragImage.remove());
        post("start", id);
      });
      button.addEventListener("dragend", (event) => {
        if (pending?.button !== button) return;
        button.removeAttribute("data-dragging");
        if (event.dataTransfer?.dropEffect === "copy") post("end", pending.id, false);
        else clearPending(true);
      });
      left.insertBefore(button, plus.nextSibling);
    }
  }
  const observer = new MutationObserver(() => { if (frame === null) frame = requestAnimationFrame(mount); });
  const observe = () => { observer.observe(document.body, { childList: true, subtree: true }); mount(); };
  window.addEventListener("message", (event) => {
    if (!pending || event.source !== parent || event.origin !== parentOrigin || event.data?.type !== "pi-desktop:element-picker-result" || event.data.sessionId !== pending.id) return;
    const button = pending.button;
    clearPending();
    if (event.data.ok === true) animate(button);
    else showHint(button, typeof event.data.error === "string" ? event.data.error : "元素引用添加失败", true);
  });
  window.addEventListener("keydown", (event) => { if (event.key === "Escape") { clearPending(true); hideHint(); } }, true);
  window.addEventListener("pagehide", () => {
    clearPending(true); hideHint(); flight?.remove(); flight = null;
    observer.disconnect(); if (frame !== null) cancelAnimationFrame(frame); frame = null;
  });
  window.addEventListener("pageshow", observe);
  if (document.body) observe();
  else document.addEventListener("DOMContentLoaded", observe, { once: true });
})();
