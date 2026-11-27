import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui";
import { portalToBody } from "../lib/portal-visibility";
import { presenceMetrics, type SubagentPresenceItem } from "../lib/subagent-presence";
import { formatToolDuration } from "../lib/tool-display";
import { SubagentStopButton } from "../features/chat/transcript/SubagentStopButton";
import { subagentExecutionIdentity } from "../features/chat/transcript/SubagentSupervision";
import "../styles/subagent-presence.css";

const VISIBLE = 6;
const numberFormat = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const tokens = (value: number | null) => value === null ? "—" : numberFormat.format(value);
type Popup = { id: string | null; anchor: HTMLButtonElement };

export function SubagentPresenceBar({ sessionId, items, onOpen }: {
  sessionId: string;
  items: readonly SubagentPresenceItem[];
  onOpen: (item: SubagentPresenceItem) => void;
}) {
  const { t } = useTranslation();
  const dialogId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [now, setNow] = useState(Date.now);
  const selected = popup && items.find((item) => item.id === popup.id);
  const roster = popup?.id === null && items.length > VISIBLE;
  const visiblePopup = Boolean(selected || roster);
  const cancelHover = () => clearTimeout(hoverTimer.current);
  const delayClose = () => {
    cancelHover();
    hoverTimer.current = setTimeout(() => setPopup(null), 160);
  };
  const show = (id: string | null, anchor: HTMLButtonElement, immediate: boolean) => {
    cancelHover();
    const open = () => { setNow(Date.now()); setPopup({ id, anchor }); };
    if (immediate) open();
    else hoverTimer.current = setTimeout(open, 120);
  };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  useLayoutEffect(() => {
    if (!popup) return;
    const layer = panel.current;
    if (!layer || !popup.anchor.isConnected) {
      setPopup(null);
      return;
    }
    const place = () => {
      const anchor = popup.anchor.getBoundingClientRect();
      const top = anchor.top - layer.offsetHeight - 6;
      layer.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - layer.offsetWidth - 8))}px`;
      layer.style.top = `${Math.max(8, top >= 8 ? top : Math.min(anchor.bottom + 6, innerHeight - layer.offsetHeight - 8))}px`;
    };
    const close = () => { clearTimeout(hoverTimer.current); setPopup(null); };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (layer.contains(document.activeElement) || popup.anchor === document.activeElement) {
        event.stopPropagation();
        popup.anchor.focus();
      }
      close();
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !layer.contains(event.target) && !popup.anchor.contains(event.target)) close();
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(layer);
    observer.observe(popup.anchor);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("pointerdown", outside);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(tick);
      observer.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [popup, visiblePopup]);

  const name = (item: SubagentPresenceItem) => item.agent || t("chat.subagentUnnamed");
  const status = (item: SubagentPresenceItem) => item.status === "queued" ? t("chat.subagentCreating") : t(`chat.subagentStatus.${item.status}`);
  const openRecord = (item: SubagentPresenceItem) => { cancelHover(); setPopup(null); onOpen(item); };
  const stopTargets = Object.fromEntries(items.flatMap((item) => {
    const identity = subagentExecutionIdentity(item.call);
    return item.status === "running" && identity.delegationId && identity.execution !== undefined &&
      (!identity.sessionId || identity.sessionId === sessionId) ? [[identity.delegationId, identity.execution] as const] : [];
  }));
  const selectedIdentity = selected ? subagentExecutionIdentity(selected.call) : undefined;
  const metricText = (item: SubagentPresenceItem) => {
    const { elapsed, speed } = presenceMetrics(item, now);
    return {
      time: elapsed === null ? "—" : formatToolDuration(elapsed / 1000),
      usage: `↑${tokens(item.inputTokens)} ↓${tokens(item.outputTokens)}`,
      speed: speed === null ? "—" : t("chat.usageThroughput", { count: Math.round(speed) }),
      tools: item.toolCalls === null ? "—" : t("chat.subagentToolCalls", { count: item.toolCalls }),
    };
  };
  const trigger = (item?: SubagentPresenceItem) => {
    const id = item?.id ?? null;
    const expanded = visiblePopup && popup?.id === id;
    return <button key={id ?? "more"} type="button" className={item ? "presence-avatar" : "presence-more"}
      data-status={item?.status} aria-label={item ? `${name(item)} · ${status(item)}` : t("chat.subagentCount", { count: items.length })}
      aria-haspopup="dialog" aria-expanded={expanded} aria-controls={expanded ? dialogId : undefined}
      onPointerEnter={(event) => show(id, event.currentTarget, false)} onPointerLeave={delayClose}
      onClick={(event) => show(id, event.currentTarget, true)}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || (expanded && event.key === "Tab" && !event.shiftKey)) {
          event.preventDefault();
          if (!expanded) show(id, event.currentTarget, true);
          requestAnimationFrame(() => panel.current?.querySelector("button")?.focus());
        }
      }}>
      {item ? Array.from(name(item).split("-").at(-1) || name(item)).slice(0, 2).join("").toUpperCase() : `+${items.length - VISIBLE}`}
    </button>;
  };
  const details = selected ? metricText(selected) : undefined;

  return <div className="subagent-bar" role="group" aria-label={t("chat.subagentTopology")}>
    {items.slice(0, VISIBLE).map(trigger)}{items.length > VISIBLE ? trigger() : null}
    {visiblePopup && portalToBody(<div id={dialogId} role="dialog" aria-label={selected ? name(selected) : t("chat.subagentTopology")}
      className={`presence-popup${roster ? " presence-roster" : ""}`} ref={panel}
      onPointerEnter={cancelHover} onPointerLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) delayClose();
      }} onFocus={cancelHover} onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) delayClose();
      }}>
      {selected && details ? <>
        <header><strong>{name(selected)}</strong><span>{status(selected)}</span></header>
        {selected.task ? <p>{selected.task}</p> : null}
        {selected.detail ? <p>{t(selected.status === "running" ? "chat.presenceCurrent" : "chat.presenceResult")}: {selected.detail}</p> : null}
        <p className="presence-model">{selected.model || "—"}</p>
        <dl><dt>{t("chat.usageTotal")}</dt><dd>{details.usage}</dd>
          <dt>{t("chat.usageThroughputLabel")}</dt><dd>{details.speed}</dd></dl>
        <div className="presence-pair"><span>{t("modes.run.elapsed", { duration: details.time })}</span><span>{details.tools}</span></div>
        <footer>
          <Button size="sm" variant="ghost" onClick={() => openRecord(selected)}>{t("chat.presenceRecord")}</Button>
          <SubagentStopButton sessionId={sessionId} name={name(selected)} delegationId={selectedIdentity?.delegationId}
            execution={selectedIdentity?.execution} running={selected.status === "running" && (!selectedIdentity?.sessionId || selectedIdentity.sessionId === sessionId)} />
        </footer>
      </> : <>
        <header><strong>{t("chat.subagentCount", { count: items.length })}</strong></header>
        {items.map((item) => {
          const metric = metricText(item);
          return <button type="button" className="presence-row" key={item.id} onClick={() => openRecord(item)}>
            <span><strong>{name(item)}</strong> · {status(item)}</span><span>{metric.time} · {metric.tools}</span>
            <span className="presence-model">{item.model || "—"}</span><span>{metric.usage} · {metric.speed}</span>
          </button>;
        })}
        <footer><span>{t("chat.presenceRecord")}</span>
          <SubagentStopButton sessionId={sessionId} expectedExecutions={stopTargets} running={Object.keys(stopTargets).length > 0} />
        </footer>
      </>}
    </div>)}
  </div>;
}
