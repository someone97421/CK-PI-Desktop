import { useLayoutEffect, useRef } from "react";

// Controls are not message text; media at the tail has no text caret position.
function findTextTail(node: Node): Text | null | undefined {
  if (node instanceof Text) return node.data.trim() ? node : undefined;
  if (node instanceof HTMLElement || node instanceof SVGElement) {
    if (node.matches("button, [role='button'], [aria-hidden='true'], [hidden]")) return undefined;
    if (node.getClientRects().length === 0) return undefined;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") return undefined;
    if (node.matches("img, svg, canvas, video, audio, iframe, hr, .katex")) return null;
  }
  for (let child = node.lastChild; child; child = child.previousSibling) {
    const tail = findTextTail(child);
    if (tail !== undefined) return tail;
  }
  return undefined;
}

export function useStreamingCursor(source: string, visible: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.removeAttribute("data-cursor-ready");
    if (!visible) return;

    const measure = () => {
      const text = findTextTail(root);
      if (!text) {
        root.removeAttribute("data-cursor-ready");
        return;
      }
      const end = text.data.trimEnd().length;
      const range = document.createRange();
      const last = text.data.charCodeAt(end - 1);
      const length = last >= 0xdc00 && last <= 0xdfff && end > 1 ? 2 : 1;
      range.setStart(text, end - length);
      range.setEnd(text, end);
      const rects = range.getClientRects();
      const tail = rects[rects.length - 1];
      if (!tail || tail.width === 0 || tail.height === 0) {
        root.removeAttribute("data-cursor-ready");
        return;
      }
      const box = root.getBoundingClientRect();
      const rtl = getComputedStyle(text.parentElement!).direction === "rtl";
      const x = (rtl ? tail.left - 4 : tail.right + 2) - box.left + root.scrollLeft - root.clientLeft;
      const y = tail.top - box.top + root.scrollTop - root.clientTop;
      const cursorX = Math.max(0, Math.min(x, root.clientWidth - 2));
      root.style.setProperty("--stream-cursor-x", `${cursorX}px`);
      root.style.setProperty("--stream-cursor-y", `${y}px`);
      root.style.setProperty("--stream-cursor-height", `${tail.height}px`);
      root.setAttribute("data-cursor-ready", "");
    };

    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(root);
    // Lazy syntax highlighting may replace text without changing block height.
    const mutation = new MutationObserver(measure);
    mutation.observe(root, { subtree: true, childList: true, characterData: true });
    root.addEventListener("scroll", measure, true);
    return () => {
      resize.disconnect();
      mutation.disconnect();
      root.removeEventListener("scroll", measure, true);
      root.removeAttribute("data-cursor-ready");
    };
  }, [source, visible]);
  return ref;
}
