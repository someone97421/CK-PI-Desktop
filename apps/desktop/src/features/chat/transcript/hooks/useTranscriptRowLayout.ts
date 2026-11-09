import { useLayoutEffect, useRef, type RefObject } from "react";

/** 视口外一屏提前完成消息布局；远处继续使用浏览器记忆的离屏高度。 */
export function useTranscriptRowLayout(
  scrollRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  visible: boolean,
) {
  const rowsRef = useRef(new Set<HTMLElement>());
  const observerRef = useRef<IntersectionObserver | null>(null);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!visible || !scroller || typeof IntersectionObserver === "undefined") return;
    let margin = -1;
    const observe = () => {
      const next = Math.ceil(scroller.clientHeight);
      if (margin === next) return;
      margin = next;
      observerRef.current?.disconnect();
      const observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (rowsRef.current.has(entry.target as HTMLElement)) {
            entry.target.toggleAttribute("data-transcript-nearby", entry.isIntersecting);
          }
        }
      }, { root: scroller, rootMargin: `${margin}px 0px` });
      observerRef.current = observer;
      for (const row of rowsRef.current) observer.observe(row);
    };
    observe();
    const resize = new ResizeObserver(observe);
    resize.observe(scroller);
    return () => {
      resize.disconnect();
      observerRef.current?.disconnect();
      observerRef.current = null;
      for (const row of rowsRef.current) row.removeAttribute("data-transcript-nearby");
      rowsRef.current.clear();
    };
  }, [scrollRef, visible]);

  // 只预布局顶层消息，不穿透折叠内容，也不唤醒远处消息的 Markdown。
  useLayoutEffect(() => {
    const content = contentRef.current;
    const observer = observerRef.current;
    if (!visible || !content || !observer) return;
    const rows = new Set(content.querySelectorAll<HTMLElement>(":scope > [data-reading-anchor]"));
    for (const row of rowsRef.current) if (!rows.has(row)) {
      observer.unobserve(row);
      row.removeAttribute("data-transcript-nearby");
    }
    for (const row of rows) if (!rowsRef.current.has(row)) observer.observe(row);
    rowsRef.current = rows;
  });
}
