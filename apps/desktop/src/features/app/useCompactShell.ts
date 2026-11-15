import { useEffect, useState } from "react";

export function useCompactShell() {
  const [compact, setCompact] = useState(() =>
    document.documentElement.dataset.webRemote === "true" || window.matchMedia("(max-width: 720px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 720px)");
    const update = () => setCompact(document.documentElement.dataset.webRemote === "true" || media.matches);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-web-remote"] });
    media.addEventListener("change", update);
    update();
    return () => { observer.disconnect(); media.removeEventListener("change", update); };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.compactShell = String(compact);
    return () => { delete document.documentElement.dataset.compactShell; };
  }, [compact]);
  return compact;
}
