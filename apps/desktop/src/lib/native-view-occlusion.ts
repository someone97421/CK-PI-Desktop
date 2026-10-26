import { useLayoutEffect, useState, type RefObject } from "react";

/** 原生插件页面位于 DOM 之上；与全局浮层相交时暂时让出显示区域。 */
export function useNativeViewOcclusion(surfaceRef: RefObject<HTMLElement | null>, enabled = true) {
  const [occluded, setOccluded] = useState(false);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!enabled || !surface) {
      setOccluded(false);
      return;
    }
    let frame = 0;
    let disposed = false;
    const schedule = () => {
      if (!frame && !disposed) frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    const observed = new Set<Element>();
    const portals = new MutationObserver(schedule);
    const hosts = new MutationObserver(schedule);
    hosts.observe(document.body, { childList: true });
    hosts.observe(document.documentElement, { childList: true });

    function measure() {
      frame = 0;
      portals.disconnect();
      const overlayHost = document.getElementById("pi-desktop-overlays");
      if (overlayHost) hosts.observe(overlayHost, { childList: true });
      const roots = [
        ...Array.from(document.body.children).filter((element) => element.id !== "root" && element !== overlayHost),
        ...Array.from(overlayHost?.children ?? []),
      ];
      const bounds = surface!.getBoundingClientRect();
      const panel = surface!.closest(".work-panel");
      const panelLayer = panel ? Number(getComputedStyle(panel).zIndex) || 0 : 0;
      const nextObserved = new Set<Element>([surface!, ...Array.from(panel?.parentElement?.children ?? [])]);
      let covered = false;
      for (const root of roots) {
        if (!(root instanceof HTMLElement) || ["SCRIPT", "STYLE", "LINK"].includes(root.tagName)) continue;
        portals.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "hidden", "open"] });
        for (const element of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
          if (!(element instanceof HTMLElement)) continue;
          const style = getComputedStyle(element);
          if (!["fixed", "absolute"].includes(style.position) || !(Number(style.zIndex) > panelLayer)) continue;
          nextObserved.add(element);
          if (!element.checkVisibility({ checkVisibilityCSS: true })) continue;
          const rect = element.getBoundingClientRect();
          if (bounds.width > 0 && bounds.height > 0 && rect.width > 0 && rect.height > 0
            && rect.left < bounds.right && rect.right > bounds.left
            && rect.top < bounds.bottom && rect.bottom > bounds.top) covered = true;
        }
      }
      for (const element of observed) {
        if (!nextObserved.has(element)) {
          resize.unobserve(element);
          observed.delete(element);
        }
      }
      for (const element of nextObserved) {
        if (!observed.has(element)) {
          resize.observe(element);
          observed.add(element);
        }
      }
      setOccluded(covered);
    }

    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    document.addEventListener("animationend", schedule, true);
    document.addEventListener("transitionend", schedule, true);
    measure();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      hosts.disconnect();
      portals.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      document.removeEventListener("animationend", schedule, true);
      document.removeEventListener("transitionend", schedule, true);
    };
  }, [surfaceRef, enabled]);

  return occluded;
}
