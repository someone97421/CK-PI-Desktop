import { useEffect, useRef, type ReactNode } from "react";
import { useRemoteLabels } from "./remote-labels";

export function RemotePanelSheet({ children, exiting, onBack, onExited }: {
  children: ReactNode; exiting: boolean; onBack: () => void; onExited: () => void;
}) {
  const labels = useRemoteLabels();
  const backButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    backButton.current?.focus({ preventScroll: true });
    return () => {
      requestAnimationFrame(() => {
        if (previous?.isConnected && !previous.closest("[inert], [hidden]")) previous.focus({ preventScroll: true });
      });
    };
  }, []);
  return <div className={`remote-panel-sheet${exiting ? " is-exiting" : ""}`} role="dialog" aria-modal="true" aria-label={labels.panel}
    inert={exiting ? true : undefined}
    onAnimationEnd={(event) => {
      if (event.target === event.currentTarget && event.animationName === "remote-sheet-out") onExited();
    }}
    onKeyDown={(event) => {
      if (event.key === "Escape" && !event.defaultPrevented) { event.stopPropagation(); onBack(); }
    }}>
    <header className="remote-sheet-header"><button ref={backButton} type="button" className="remote-back" onClick={onBack}>{labels.backChat}</button></header>
    {children}
  </div>;
}
