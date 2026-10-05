import { useEffect, useState, type RefObject } from "react";

export type ComposerImageHoverTarget = {
  id: string;
  /** Viewport rect of the hovered chip, used to place the preview card. */
  anchor: { left: number; top: number; bottom: number; width: number };
};

/** Pointer dwell before a chip reveals its preview. */
const HOVER_DELAY_MS = 180;

const IMAGE_CHIP_SELECTOR = ".composer-chip[data-image]";

/**
 * Track the image chip under the pointer inside the composer editor. Chips are
 * painted imperatively, so the editor delegates pointer movement here instead
 * of every chip owning preview state.
 */
export function useComposerImageHover(
  editorRef: RefObject<HTMLDivElement | null>,
  idForToken: (token: string) => string | null,
): ComposerImageHoverTarget | null {
  const [target, setTarget] = useState<ComposerImageHoverTarget | null>(null);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    let timer: number | null = null;
    let pending: string | null = null;
    const cancel = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      pending = null;
    };
    const hide = () => {
      cancel();
      setTarget(null);
    };
    const chipOf = (node: EventTarget | null): HTMLElement | null =>
      node instanceof Element ? node.closest<HTMLElement>(IMAGE_CHIP_SELECTOR) : null;
    const reveal = (chip: HTMLElement, id: string) => {
      const rect = chip.getBoundingClientRect();
      setTarget({
        id,
        anchor: { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width },
      });
    };
    const onPointerOver = (event: PointerEvent) => {
      const chip = chipOf(event.target);
      const id = chip ? idForToken(chip.dataset.token ?? "") : null;
      if (!chip || !id) {
        hide();
        return;
      }
      if (pending === id) return;
      cancel();
      pending = id;
      timer = window.setTimeout(() => {
        timer = null;
        if (pending === id) reveal(chip, id);
      }, HOVER_DELAY_MS);
    };
    const onPointerOut = (event: PointerEvent) => {
      const chip = chipOf(event.target);
      if (!chip || chipOf(event.relatedTarget) === chip) return;
      hide();
    };
    editor.addEventListener("pointerover", onPointerOver);
    editor.addEventListener("pointerout", onPointerOut);
    // A chip that moves under the pointer (typing, wrapping, scrolling) must
    // never leave a stale card behind.
    editor.addEventListener("input", hide);
    editor.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      cancel();
      editor.removeEventListener("pointerover", onPointerOver);
      editor.removeEventListener("pointerout", onPointerOut);
      editor.removeEventListener("input", hide);
      editor.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, [editorRef, idForToken]);

  return target;
}
