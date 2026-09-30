import { useEffect, useRef, useState } from "react";

/**
 * Progressively reveals `source` text at an adaptive rate.
 *
 * Streaming display commits are coalesced to 50 ms. Disabling the reveal
 * animation still batches incoming chunks; finished text is returned immediately.
 *
 * The release speed adapts to the backlog. When streaming ends, all
 * remaining text is shown immediately; unmount cancels pending frames.
 */
export function useSmoothText(
  source: string,
  streaming: boolean,
  enabled: boolean,
): string {
  const [revealed, setRevealed] = useState(source.length);
  const revealedRef = useRef(source.length);
  const rafRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);
  const fractionalAdvanceRef = useRef(0);

  // A completed message always shows the full source.
  useEffect(() => {
    if (!streaming) {
      revealedRef.current = source.length;
      lastFrameRef.current = 0;
      fractionalAdvanceRef.current = 0;
      setRevealed(source.length);
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    }
  }, [streaming, source.length]);

  // Core release loop
  useEffect(() => {
    if (!streaming) return;

    const tick = (now: number) => {
      const backlog = source.length - revealedRef.current;
      if (backlog <= 0) {
        // The source dependency restarts this effect when more text arrives.
        rafRef.current = null;
        lastFrameRef.current = 0;
        fractionalAdvanceRef.current = 0;
        return;
      }

      const elapsed = now - lastFrameRef.current;
      // Batch Markdown layout updates, including when reveal animation is off.
      if (elapsed < 50) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      lastFrameRef.current = now;

      // Base speed: ~60 chars/sec. Adapt: if backlog > ~30 chars (~500ms),
      // increase speed proportionally so we catch up within 500ms.
      const baseCharsPerSec = 60;
      const maxLagChars = 30;
      const speed =
        backlog > maxLagChars
          ? backlog / 0.5 // clear backlog in 500ms
          : baseCharsPerSec;

      const dt = Math.min(elapsed, 100) / 1000; // cap dt to avoid big jumps
      // Carry fractional characters so skipped frames do not slow the reveal.
      const exactAdvance = fractionalAdvanceRef.current + speed * dt;
      const advance = enabled ? Math.floor(exactAdvance) : backlog;
      fractionalAdvanceRef.current = enabled ? exactAdvance - advance : 0;
      if (advance === 0) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const next = Math.min(revealedRef.current + advance, source.length);

      revealedRef.current = next;
      setRevealed(next);

      rafRef.current = requestAnimationFrame(tick);
    };

    if (lastFrameRef.current === 0) {
      lastFrameRef.current = performance.now();
    }
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [enabled, streaming, source]);

  // Cancel any pending release on unmount.
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  if (!streaming) return source;
  // Avoid slicing in the middle of a UTF-16 surrogate pair.
  let end = revealed;
  if (end < source.length && end > 0) {
    const code = source.charCodeAt(end - 1);
    // High surrogate without its low surrogate: include both.
    if (code >= 0xd800 && code <= 0xdbff) end = Math.min(end + 1, source.length);
  }
  return source.slice(0, end);
}
