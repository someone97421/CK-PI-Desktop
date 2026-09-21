import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PluginInlineNode, PluginInlineViewContext, PluginInlineViewMeta } from "@pi-desktop/shared";
import { api } from "../lib/api";
import { usePluginInlineViews } from "../lib/plugin-inline-views";
import { useDisclosureAnchorNotifier } from "../lib/disclosure-anchor-context";
import { IconStop } from "./icons";
import { TooltipButton } from "./ui";
import "../styles/plugin-inline.css";

function InlineContent({ node, disabled, onAction }: {
  node: PluginInlineNode;
  disabled: boolean;
  onAction: (action: string) => void;
}): ReactNode {
  const notifyAnchor = useDisclosureAnchorNotifier();
  const children = node.children?.map((child, index) => (
    <InlineContent key={child.key ?? index} node={child} disabled={disabled} onAction={onAction} />
  ));
  switch (node.kind) {
    case "row": return <div className="plugin-inline-row" title={node.title}>{children}</div>;
    case "column": return <div className="plugin-inline-column" title={node.title}>{children}</div>;
    case "text": return <span title={node.title}>{node.text}</span>;
    case "pre": return <pre className="selectable" title={node.title}>{node.text}</pre>;
    case "list": return <ol>{children}</ol>;
    case "item": return <li>{children}</li>;
    case "details": return (
      <details>
        <summary onClick={(event) => { notifyAnchor?.(event.currentTarget); }}>{node.text}</summary>
        <div className="plugin-inline-column">{children}</div>
      </details>
    );
    case "action": return (
      <TooltipButton type="button" className="plugin-inline-action" tooltip={node.title ?? node.text ?? ""}
        aria-label={node.text} disabled={disabled || node.disabled}
        onClick={(event) => { event.stopPropagation(); if (node.action) onAction(node.action); }}>
        {node.icon === "stop" ? <IconStop size={12} aria-hidden /> : node.text}
      </TooltipButton>
    );
  }
}

function InlineView({ view, context }: { view: PluginInlineViewMeta; context: PluginInlineViewContext }) {
  const [model, setModel] = useState<{ node: PluginInlineNode | null; context: PluginInlineViewContext }>();
  const [renderError, setRenderError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const active = useRef(false);
  const acting = useRef(false);
  const generation = useRef(0);
  const currentContext = useRef(context);
  currentContext.current = context;

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; generation.current += 1; };
  }, []);

  useEffect(() => {
    if (acting.current) return;
    const request = ++generation.current;
    let cancelled = false;
    void api.pluginInlineView({ ...view, context }).then((node) => {
      if (!cancelled && request === generation.current) {
        setModel({ node, context });
        setRenderError("");
      }
    }).catch((failure) => {
      if (!cancelled && request === generation.current) {
        setModel({ node: null, context });
        setRenderError(failure instanceof Error ? failure.message : String(failure));
      }
    });
    return () => { cancelled = true; };
  }, [view, context, refresh]);

  const onAction = async (action: string) => {
    if (acting.current || model?.context !== context) return;
    acting.current = true;
    generation.current += 1;
    setBusy(true);
    setError("");
    try {
      const node = await api.pluginInlineView({ ...view, context, action });
      if (active.current && currentContext.current === context) setModel({ node, context });
    } catch (failure) {
      if (active.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      acting.current = false;
      if (active.current) { setBusy(false); setRefresh((value) => value + 1); }
    }
  };

  if (!model?.node && !error && !renderError) return null;
  return (
    <div className={`plugin-inline-view${context.compact ? " compact" : ""}`} aria-busy={busy}>
      {model?.node ? <InlineContent node={model.node} disabled={busy || model.context !== context} onAction={onAction} /> : null}
      {renderError || error ? <div role="alert">{renderError || error}</div> : null}
    </div>
  );
}

/** 仅负责贡献生命周期和声明式节点，观测业务逻辑由插件实现。 */
export function PluginInlineSlot({ slot, context }: {
  slot: PluginInlineViewMeta["slot"];
  context: PluginInlineViewContext;
}) {
  const catalog = usePluginInlineViews();
  return <>
    {catalog.error ? <div role="alert">{catalog.error}</div> : null}
    {catalog.views.filter((view) => view.slot === slot).map((view) => (
      <InlineView key={`${catalog.revision}:${view.pluginId}:${view.viewId}:${context.sessionId}:${context.delegationId}:${context.execution ?? ""}`}
        view={view} context={context} />
    ))}
  </>;
}
