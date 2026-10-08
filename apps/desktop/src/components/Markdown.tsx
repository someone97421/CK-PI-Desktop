import {
  createContext,
  Fragment,
  isValidElement,
  memo,
  Profiler,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ComponentProps,
  type RefObject,
  type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type Options } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import {
  advanceMarkdownBlocks,
  emptyMarkdownBlockCache,
  markdownRemarkPlugins,
} from "../lib/markdown-blocks";
import {
  MAX_STREAMING_MARKDOWN_TAIL_CODE_UNITS,
  MAX_SYNC_MARKDOWN_CODE_UNITS,
} from "../lib/render-content-limits";
import {
  beginRenderDiagnostic,
  recordRenderDiagnostic,
} from "../lib/render-diagnostics";
import { useTranslation } from "react-i18next";
import type { ThemedToken } from "shiki";
import "katex/dist/katex.min.css";
import { parseSessionLinkToken } from "@pi-desktop/shared";
import { SessionLinkChip } from "../features/chat/transcript/shared";
import {
  IconCheck,
  IconCircleAlert,
  IconCode,
  IconCopy,
  IconExternal,
  IconFileText,
  IconGlobe,
  IconImage,
  IconWorkflow,
} from "./icons";
import { TooltipButton } from "./ui";
import { cleanChatFileRef, FileRefTarget } from "./FileReference";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import { MarkdownTable } from "./MarkdownTable";
import { markdownTableData } from "../lib/markdown-table";
import { PluginBlockRenderer } from "./PluginBlockRenderer";
import { blockRendererCandidate } from "../lib/block-renderer";
import { useSlotEntryForKey } from "../plugins/renderer-slots/use-slots";
import { api } from "../lib/api";
import { openHttpUrl } from "../lib/open-http-url";
import {
  rehypeSourcePositions,
  sourcePositionProps,
  type SourcePositionProps,
} from "../lib/markdown-source";
import {
  normalizeLatexMathDelimiters,
  remarkLatexBracketDisplay,
} from "../lib/latex-math";
import { sessionWorkspacePath } from "../lib/session-workspace";
import { useAppStore } from "../stores/app-store";
import { useReferencedImageDataUrl } from "../lib/use-referenced-image-data-url";
import { absoluteImagePath, remarkLocalImagePaths } from "../lib/markdown-image-paths";
import { remarkNormalizeWrappedMarkdownLinkDestinations } from "../lib/markdown-link-destinations";
import { useOpenChatFileRef } from "../hooks/use-preview-target";
import {
  useChatFileMenuItems,
  type ChatFileMenuTarget,
} from "../hooks/use-chat-file-menu";
import {
  isLocalFileHref,
  handleMarkdownFileLinkClick,
  remarkChatFileLinks,
  rehypeWindowsFileLinks,
  resolvePreviewTarget,
  safeDecodeUri,
  toWorkspaceRel,
} from "../lib/chat-links";
import { annotationMarkerToken, splitAnnotationMarkerTokens } from "../lib/response-annotations";
import {
  isClosedFencedCodeBlock,
  MAX_MERMAID_SOURCE_LENGTH,
  MermaidSourceTooLargeError,
  renderMermaidSvg,
} from "../lib/mermaid";
import type { ThemeMode } from "../lib/shiki";
import { useHighlightedTokens } from "../hooks/use-highlighted-tokens";

/*
 * Streaming-optimized chat markdown renderer.
 *
 * The source is split with the rendering grammar, and each block renders
 * through a memoized <ReactMarkdown>. Streaming re-parses the growing tail
 * while retaining the completed prefix; a long unclosed block still has to
 * be parsed in full until its boundary is known. A source carrying link or
 * footnote definitions opts out of splitting altogether — `markdown-blocks`
 * states why, and why that trade is the right one.
 */

export function useCopy() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    });
  }, []);
  return { copied, copy };
}

/* ---------- theme (follows documentElement[data-theme]) ---------- */

const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | null = null;

function subscribeTheme(listener: () => void): () => void {
  if (!themeObserver) {
    themeObserver = new MutationObserver(() => {
      for (const cb of themeListeners) cb();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  }
  themeListeners.add(listener);
  return () => {
    themeListeners.delete(listener);
  };
}

function getThemeSnapshot(): ThemeMode {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeSnapshot);
}

/* ---------- syntax highlighting ---------- */

function tokenStyle(token: ThemedToken): CSSProperties | undefined {
  const fontStyle = token.fontStyle ?? 0;
  if (!token.color && !fontStyle) return undefined;
  const style: CSSProperties = {};
  if (token.color) style.color = token.color;
  if (fontStyle & 1) style.fontStyle = "italic";
  if (fontStyle & 2) style.fontWeight = "var(--appearance-code-strong, 700)";
  if (fontStyle & 4) style.textDecoration = "underline";
  return style;
}

/* Rows are cached by reference in the line cache, so settled lines memo-skip. */
const TokenLine = memo(function TokenLine({ line }: { line: ThemedToken[] }) {
  return (
    <>
      {line.map((token, i) => (
        <span key={i} style={tokenStyle(token)}>
          {token.content}
        </span>
      ))}
    </>
  );
});

/**
 * Tokenized code body (no chrome). Shared with the transcript's tool result
 * blocks so both use the one incremental highlighter cache.
 */
export function HighlightedCode({
  code,
  lang,
}: {
  code: string;
  lang: string;
}) {
  const mode = useThemeMode();
  const tokens = useHighlightedTokens(code, lang, mode);
  if (!tokens) return <>{code}</>;
  return (
    <>
      {tokens.map((line, i) => (
        <Fragment key={i}>
          {i > 0 ? "\n" : null}
          <TokenLine line={line} />
        </Fragment>
      ))}
    </>
  );
}

function CodeBlock({ code, lang, ...position }: { code: string; lang: string } & SourcePositionProps) {
  const { t } = useTranslation();
  const { copied, copy } = useCopy();
  return (
    <div className="code-block" {...position}>
      <div className="code-block-head">
        <span className="code-block-lang">{lang || "text"}</span>
        <TooltipButton
          className={`code-copy-btn ${copied ? "copied" : ""}`}
          tooltip={copied ? t("chat.copied") : t("chat.copy")}
          ariaLabel={t("chat.copy")}
          onClick={() => copy(code)}
        >
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
        </TooltipButton>
      </div>
      <pre>
        <code>
          <HighlightedCode code={code} lang={lang} />
        </code>
      </pre>
    </div>
  );
}

function useNearViewport(ref: RefObject<HTMLDivElement | null>): boolean {
  const [nearViewport, setNearViewport] = useState(false);
  useEffect(() => {
    if (nearViewport) return;
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setNearViewport(true);
        observer.disconnect();
      },
      { rootMargin: "240px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [nearViewport, ref]);
  return nearViewport;
}

function MermaidBlock({ code, ...position }: { code: string } & SourcePositionProps) {
  const { t } = useTranslation();
  const theme = useThemeMode();
  const reactId = useId();
  const renderId = useMemo(
    () => `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    [reactId],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const nearViewport = useNearViewport(rootRef);
  const renderedSourceRef = useRef("");
  const [svg, setSvg] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<"invalid" | "too-large" | null>(null);
  const [showSource, setShowSource] = useState(false);
  const { copied, copy } = useCopy();

  useEffect(() => {
    setShowSource(false);
  }, [code]);

  useEffect(() => {
    if (!nearViewport) return;
    if (code.length > MAX_MERMAID_SOURCE_LENGTH) {
      setSvg("");
      setLoading(false);
      setError("too-large");
      return;
    }

    let active = true;
    if (renderedSourceRef.current !== code) setSvg("");
    setLoading(true);
    setError(null);
    void renderMermaidSvg({ id: renderId, source: code, theme })
      .then((nextSvg) => {
        if (!active) return;
        renderedSourceRef.current = code;
        setSvg(nextSvg);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setSvg("");
        setLoading(false);
        setError(
          cause instanceof MermaidSourceTooLargeError ? "too-large" : "invalid",
        );
      });
    return () => {
      active = false;
    };
  }, [code, nearViewport, renderId, theme]);

  const sourceVisible = showSource || error !== null;
  const statusLabel =
    error === "too-large"
      ? t("chat.diagramTooLarge")
      : t("chat.diagramUnavailable");

  return (
    <div
      ref={rootRef}
      {...position}
      className={`mermaid-block${error ? " error" : ""}`}
      aria-busy={loading}
    >
      <div className="mermaid-block-head">
        <span className="mermaid-block-title">
          <IconWorkflow size={13} aria-hidden />
          <span>mermaid</span>
        </span>
        <div className="mermaid-block-actions">
          {svg && !error ? (
            <TooltipButton
              type="button"
              className={`mermaid-action-btn${showSource ? " active" : ""}`}
              tooltip={
                showSource ? t("chat.showDiagram") : t("chat.showDiagramSource")
              }
              ariaLabel={
                showSource ? t("chat.showDiagram") : t("chat.showDiagramSource")
              }
              aria-pressed={showSource}
              onClick={() => setShowSource((value) => !value)}
            >
              {showSource ? (
                <IconWorkflow size={13} />
              ) : (
                <IconCode size={13} />
              )}
            </TooltipButton>
          ) : null}
          <TooltipButton
            type="button"
            className={`mermaid-action-btn${copied ? " copied" : ""}`}
            tooltip={copied ? t("chat.copied") : t("chat.copyDiagramSource")}
            ariaLabel={t("chat.copyDiagramSource")}
            onClick={() => copy(code)}
          >
            {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          </TooltipButton>
        </div>
      </div>
      <div className="mermaid-block-body">
        {error ? (
          <div className="mermaid-block-error" role="status">
            <IconCircleAlert size={14} aria-hidden />
            <span>{statusLabel}</span>
          </div>
        ) : null}
        {sourceVisible ? (
          <pre className="mermaid-source">
            <code>{code}</code>
          </pre>
        ) : svg ? (
          <div
            className={`mermaid-svg${loading ? " refreshing" : ""}`}
            role="img"
            aria-label={t("chat.mermaidDiagram")}
            // Mermaid strict mode output is sanitized again in renderMermaidSvg.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div
            className="mermaid-loading"
            role="status"
            aria-label={t("chat.diagramRendering")}
          >
            <span aria-hidden />
            <span aria-hidden />
            <span aria-hidden />
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- react-markdown component overrides ---------- */

const MarkdownBlockContext = createContext({
  closedFence: false,
  renderDiagrams: true,
  originalRaw: "",
});

const MarkdownBaseDirContext = createContext("");
/** 本地图片及其占位按钮共享菜单；链接和行内代码由 FileRefTarget 提供文件操作。 */
const MarkdownFileMenuContext = createContext<OpenMarkdownFileMenu | null>(null);

type OpenMarkdownFileMenu = (
  event: React.MouseEvent<HTMLElement>,
  target: ChatFileMenuTarget,
) => void;

function extractCode(children: ReactNode): { code: string; lang: string } | null {
  const element = Array.isArray(children)
    ? children.find((child) => isValidElement(child))
    : children;
  if (!isValidElement(element)) return null;
  const props = element.props as { className?: unknown; children?: unknown };
  const className = typeof props.className === "string" ? props.className : "";
  const lang = /language-(\S+)/.exec(className)?.[1] ?? "";
  const raw = props.children;
  const code =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw) && raw.every((part) => typeof part === "string")
        ? raw.join("")
        : null;
  if (code === null) return null;
  return { code: code.replace(/\n$/, ""), lang };
}

function PreBlock({
  node: _node,
  children,
  ...rest
}: ComponentProps<"pre"> & SourcePositionProps & { node?: unknown }) {
  const { closedFence, renderDiagrams } = useContext(MarkdownBlockContext);
  const info = extractCode(children);
  // Hooks stay unconditional: the fence language and closed-ness can flip
  // between streaming renders, so the lookup must run on every render.
  const blockEntry = useSlotEntryForKey(
    "blockRenderer",
    closedFence ? blockRendererCandidate(info?.lang ?? "") : undefined,
  );
  if (!info) return <pre {...rest}>{children}</pre>;
  if (
    renderDiagrams &&
    closedFence &&
    info.lang.toLowerCase() === "mermaid"
  ) {
    return <MermaidBlock code={info.code} {...sourcePositionProps(rest)} />;
  }
  if (blockEntry) {
    return (
      <PluginBlockRenderer
        key={blockEntry.id}
        entry={blockEntry}
        language={info.lang}
        source={info.code}
        sourcePosition={sourcePositionProps(rest)}
        fallback={
          <CodeBlock code={info.code} lang={info.lang} {...sourcePositionProps(rest)} />
        }
      />
    );
  }
  return <CodeBlock code={info.code} lang={info.lang} {...sourcePositionProps(rest)} />;
}

function useMarkdownWorkspaceRoot() {
  return useAppStore((state) => sessionWorkspacePath(
    state.sessions.find((session) => session.id === state.activeSessionId),
    state.workspace?.path,
  ));
}

/** Preview-in-panel tooltip for file and URL chat references. */
function usePreviewTitle(kind: "file" | "url"): string {
  const { t } = useTranslation();
  return kind === "file" ? t("chat.previewFile") : t("chat.previewUrl");
}

/**
 * Inline code that names a workspace file (or URL) opens in the work panel;
 * everything else stays a plain code chip. Fenced blocks never reach this
 * component — PreBlock intercepts them.
 */
function InlineCode({
  node: _node,
  className,
  children,
  ...rest
}: ComponentProps<"code"> & { node?: unknown }) {
  const root = useMarkdownWorkspaceRoot();
  const baseDir = useContext(MarkdownBaseDirContext);
  const openFileRef = useOpenChatFileRef();
  const text = typeof children === "string" ? children : null;
  const target =
    text && !className && !text.includes("\n")
      ? resolvePreviewTarget(text, root, baseDir)
      : null;
  const urlTitle = usePreviewTitle("url");
  if (!target) {
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  }
  if (target.kind === "file") {
    // The themed tooltip shows the resolved full path; the native title is
    // gone so the two never stack.
    return (
      <FileRefTarget fileRef={text ?? target.path} baseDir={baseDir}>
        <button
          type="button"
          className="chat-code-link"
          onClick={() => openFileRef(cleanChatFileRef(text ?? target.path).path, baseDir, undefined, target)}
        >
          <code className={className} {...rest}>
            {children}
          </code>
        </button>
      </FileRefTarget>
    );
  }
  if (target.kind === "session") {
    return <SessionLinkChip sessionId={target.sessionId} {...sourcePositionProps(rest)} />;
  }
  return (
    <button
      type="button"
      className="chat-code-link"
      title={urlTitle}
      onClick={() => openHttpUrl(target.url)}
    >
      <code className={className} {...rest}>
        {children}
      </code>
    </button>
  );
}

/**
 * Inline numbered marker for one response annotation (ADR response-annotations / D-LOCAL-response-annotations).
 *
 * It mirrors the reference overlay's marker: the number of the annotation in
 * array order, with the annotated excerpt as its tooltip.
 */
function AnnotationMarker({ index }: { index: number }) {
  const { t } = useTranslation();
  const annotation = useAppStore((state) =>
    state.activeSessionId
      ? (state.responseAnnotations[state.activeSessionId] ?? [])[index - 1]
      : undefined,
  );
  const excerpt = annotation?.text ?? "";
  const comment = annotation?.annotation?.trim() ?? "";
  const tooltip = [
    `${t("chat.annotationSelectedText")} ${excerpt}`,
    comment ? `${t("chat.annotationComment")} ${comment}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return (
    <button
      type="button"
      className="response-annotation-marker"
      data-annotation-index={index}
      aria-label={t("chat.annotationMarker", { index })}
      title={tooltip || undefined}
      onClick={() => undefined}
    >
      {index}
    </button>
  );
}

function Anchor({
  node: _node,
  children,
  href,
  ...rest
}: ComponentProps<"a"> & { node?: unknown }) {
  const { t } = useTranslation();
  const root = useMarkdownWorkspaceRoot();
  const baseDir = useContext(MarkdownBaseDirContext);
  const openFileRef = useOpenChatFileRef();
  const openUrl = useAppStore((s) => s.openUrlInWorkPanel);
  const showToast = useAppStore((s) => s.showToast);

  const annotationIndex = annotationMarkerIndexFromHref(href);
  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu();

  /*
    Copying reports through the toast host: the menu closes the moment the item
    runs, so there is no button left to carry its own copied state.
  */
  const copyLink = async (target: string) => {
    try {
      await navigator.clipboard.writeText(target);
      showToast(t("settings.linkCopied", { defaultValue: "Link copied to clipboard" }), {
        variant: "success",
      });
    } catch {
      showToast(
        t("settings.linkCopyFailed", { defaultValue: "Couldn't copy link address" }),
        { variant: "error" },
      );
    }
  };

  // An annotated pass carries its number here instead of a link: the marker is
  // an inline reference, not a destination. Every hook above still runs, so
  // the marker branch cannot change hook order.
  if (annotationIndex !== null) {
    return <AnnotationMarker index={annotationIndex} />;
  }

  /*
    A link keeps the renderer's own menu so both destinations the app can send
    it to stay one press away. File links use FileRefTarget; HTTP links
    keep the external, work-panel, and copy actions below.
  */
  const onContextMenu = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!href || !/^https?:\/\//i.test(href)) return;
    const target = href;
    openContextMenu(event, {
      items: [
        {
          id: "open-external",
          label: t("settings.linkContextMenuOpenExternal", {
            defaultValue: "Open in default browser",
          }),
          icon: <IconExternal size={14} />,
          onSelect: () => void api.browserOpenExternal(target),
        },
        {
          id: "open-workpanel",
          label: t("settings.linkContextMenuOpenWorkpanel", {
            defaultValue: "Open in work panel",
          }),
          icon: <IconGlobe size={14} />,
          onSelect: () => openUrl(target),
        },
        {
          id: "copy-address",
          label: t("settings.linkContextMenuCopy", {
            defaultValue: "Copy link address",
          }),
          icon: <IconCopy size={14} />,
          separatorBefore: true,
          onSelect: () => void copyLink(target),
        },
      ],
    });
  };

  // Plain click follows Settings → AI → Link open destination (work panel by
  // default); modifier clicks fall through to _blank, which main routes to
  // shell.openExternal.
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!href) return;
    if (/^https?:\/\//i.test(href)) {
      e.preventDefault();
      openHttpUrl(href);
      return;
    }
    const sessionId = parseSessionLinkToken(href);
    if (sessionId) {
      e.preventDefault();
      void useAppStore.getState().selectSession(sessionId).catch(() => undefined);
      return;
    }
    handleMarkdownFileLinkClick(e, href, root, baseDir, openFileRef);
  };
  // Local file references (relative, POSIX-absolute, or Windows `I:/…` /
  // `/I:/…` hrefs) get the full-path hover tooltip and the file context menu;
  // URLs and scheme links keep the existing behavior below. The icon stays
  // inline so wrapped link text reflows unchanged.
  if (href && isLocalFileHref(href)) {
    return (
      <FileRefTarget fileRef={href} baseDir={baseDir}>
        <a
          {...rest}
          title={undefined}
          href={href}
          onClick={onClick}
          target="_blank"
          rel="noopener noreferrer"
        >
          <IconFileText
            size={13}
            className="chat-file-link-icon"
            aria-hidden
          />
          {children}
        </a>
      </FileRefTarget>
    );
  }

  const sessionId = href ? parseSessionLinkToken(href) : null;
  if (sessionId) {
    return <SessionLinkChip sessionId={sessionId} {...sourcePositionProps(rest)} />;
  }

  return (
    <>
      <a
        {...rest}
        href={href}
        onClick={onClick}
        onContextMenu={onContextMenu}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
      <ContextMenu state={contextMenu} onClose={closeContextMenu} />
    </>
  );
}

/**
 * Local image references can't load over the renderer origin; the host
 * resolves them into a bounded data URL so they render inline. Missing,
 * escaped, or oversized files fall back to a chip. Remote images render
 * inline and click through to the browser tab.
 */
function MarkdownImage({
  node: _node,
  src,
  alt,
  ...rest
}: ComponentProps<"img"> & SourcePositionProps & { node?: unknown }) {
  const root = useMarkdownWorkspaceRoot();
  const baseDir = useContext(MarkdownBaseDirContext);
  const openFileRef = useOpenChatFileRef();
  const openFileMenu = useContext(MarkdownFileMenuContext);
  const fileTitle = usePreviewTitle("file");
  const urlTitle = usePreviewTitle("url");
  const source = typeof src === "string" ? src : "";
  const isRemote = /^https?:/i.test(source);
  const decoded = safeDecodeUri(source).replaceAll("\\", "/").replace(/^\/(?=[A-Za-z]:\/)/, "");
  const rel = isRemote ? null : toWorkspaceRel(decoded, root, baseDir);
  const attachmentRef =
    !isRemote && /^attachments\/[0-9a-f]{64}$/i.test(decoded.replace(/\\/g, "/"))
      ? decoded.replace(/\\/g, "/")
      : null;
  // Scratch and other allowed absolute paths are resolved by the host, which
  // checks both containment and real paths before returning image data.
  const localRef = (isRemote ? null : absoluteImagePath(source)) ?? rel ?? attachmentRef;
  // Always run the hook before any branch so hook order stays stable when a
  // streaming src flips between remote and local. Remote images pass null.
  const dataUrl = useReferencedImageDataUrl(isRemote ? null : localRef);

  /*
    A file the renderer can already show is still a file whose folder the user
    may want, so a local image carries the same menu its chip fallback does.
  */
  const onLocalContextMenu =
    localRef && openFileMenu
      ? (event: React.MouseEvent<HTMLElement>) =>
          openFileMenu(event, { path: localRef, baseDir })
      : undefined;
  if (isRemote) {
    return (
      <img
        {...rest}
        src={source}
        alt={alt ?? ""}
        className="chat-image-remote"
        title={urlTitle}
        onClick={() => openHttpUrl(source)}
      />
    );
  }
  if (dataUrl) {
    return (
      <img
        {...rest}
        src={dataUrl}
        alt={alt ?? ""}
        className="chat-image-local"
        title={rel ? fileTitle : source}
        onClick={localRef ? () => openFileRef(localRef, baseDir) : undefined}
        onContextMenu={onLocalContextMenu}
      />
    );
  }
  if (localRef) {
    return (
      <button
        type="button"
        className="chat-image-chip"
        {...sourcePositionProps(rest)}
        title={fileTitle}
        onClick={() => openFileRef(localRef, baseDir)}
        onContextMenu={onLocalContextMenu}
      >
        <IconImage size={14} aria-hidden />
        <span>{alt || localRef.split("/").pop()}</span>
      </button>
    );
  }
  return <img {...rest} src={source} alt={alt ?? ""} />;
}

function Table({
  node,
  children,
  ...rest
}: ComponentProps<"table"> & { node?: Parameters<typeof markdownTableData>[0] }) {
  const { originalRaw } = useContext(MarkdownBlockContext);
  const data = useMemo(
    () => node ? markdownTableData(node, originalRaw) : null,
    [node, originalRaw],
  );
  const table = (
    <div className="table-wrap">
      <table {...rest}>{children}</table>
    </div>
  );
  return data ? <MarkdownTable {...data}>{table}</MarkdownTable> : table;
}

/** Inline audio player for audio URLs in markdown. */
function AudioBlock({
  node: _node,
  src,
  ...rest
}: ComponentProps<"audio"> & { node?: unknown }) {
  const source = typeof src === "string" ? src : "";
  return (
    <div className="chat-audio">
      <audio controls preload="metadata" src={source} {...rest} />
    </div>
  );
}

/** Inline video player for video URLs in markdown. */
function VideoBlock({
  node: _node,
  src,
  ...rest
}: ComponentProps<"video"> & { node?: unknown }) {
  const source = typeof src === "string" ? src : "";
  return (
    <div className="chat-video">
      <video controls preload="metadata" src={source} {...rest} />
    </div>
  );
}

const markdownComponents: Components = {
  pre: PreBlock,
  code: InlineCode,
  a: Anchor,
  img: MarkdownImage,
  audio: AudioBlock,
  video: VideoBlock,
  table: Table,
};

/** Href scheme the annotation markers travel on through the markdown pipeline. */
const ANNOTATION_MARKER_SCHEME = "annotation:";

/** Url resolved for one annotation number. */
export function annotationMarkerHref(index: number): string {
  return `${ANNOTATION_MARKER_SCHEME}${index}`;
}
/** The annotation number one rendered marker element carries, or null. */
export function annotationMarkerIndexFromHref(href: string | undefined): number | null {
  if (!href || !href.startsWith(ANNOTATION_MARKER_SCHEME)) return null;
  const index = Number(href.slice(ANNOTATION_MARKER_SCHEME.length));
  return Number.isSafeInteger(index) && index > 0 ? index : null;
}

type MdastLike = {
  type?: string;
  value?: string;
  url?: string;
  children?: MdastLike[];
};

/**
 * Turn `:codex-annotation{index="N"}` tokens into numbered marker elements
 * (ADR response-annotations / D-LOCAL-response-annotations). The token is the reference implementation's own syntax,
 * so an answer that echoes one renders as a marker instead of raw text.
 */
export function annotationMarkerMdastTree(tree: MdastLike | null | undefined): void {
  walk(tree);

  function walk(node: MdastLike | null | undefined) {
    if (!node?.children) return;
    const next: MdastLike[] = [];
    for (const child of node.children) {
      if (child.type === "text" && typeof child.value === "string") {
        const segments = splitAnnotationMarkerTokens(child.value);
        if (segments.length === 1 && segments[0].kind === "text") {
          next.push(child);
          continue;
        }
        for (const segment of segments) {
          if (segment.kind === "text") {
            if (segment.value) next.push({ type: "text", value: segment.value });
            continue;
          }
          next.push({
            type: "link",
            url: annotationMarkerHref(segment.index),
            children: [
              { type: "text", value: annotationMarkerToken(segment.index) },
            ],
          });
        }
        continue;
      }
      walk(child);
      next.push(child);
    }
    node.children = next;
  }
}

function remarkAnnotationMarkers() {
  return (tree: MdastLike) => {
    annotationMarkerMdastTree(tree);
  };
}

// 渲染阶段的链接规范化与批注转换都不改变分块边界。
const staticRemarkPlugins = [
  ...markdownRemarkPlugins,
  remarkNormalizeWrappedMarkdownLinkDestinations,
  remarkAnnotationMarkers,
  remarkLocalImagePaths,
];

// Extend the default schema only for the media elements rendered above, plus
// `remark-math`'s math classes on `<code>`: the default `language-*` allow list
// drops `math-display`, which leaves `rehype-katex` rendering TeX `\[ … \]`
// (single-line or mid-paragraph) as inline math instead of display math.
const sanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    // The annotation markers travel on their own scheme; without it the
    // sanitizer drops the href and the raw directive renders as link text.
    href: [...(defaultSchema.protocols?.href ?? []), "pi-desktop", ANNOTATION_MARKER_SCHEME.replace(/:$/, "")],
  },
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
    img: [...(defaultSchema.attributes?.img || []), "src", "alt", "title", "className"],
    audio: ["src", "controls", "preload", "className"],
    video: ["src", "controls", "preload", "className", "poster"],
    source: ["src", "type"],
  },
  tagNames: [
    ...(defaultSchema.tagNames || []),
    "audio",
    "video",
    "source",
  ],
};

const rehypePlugins = [rehypeRaw, rehypeWindowsFileLinks, [rehypeSanitize, sanitizeSchema], rehypeKatex] as Options["rehypePlugins"];

/* ---------- block splitting ---------- */

/*
 * Splitting and its streaming reuse live in `markdown-blocks`, which owns the
 * rules a slice has to satisfy before it can be parsed on its own.
 */
function useBlocks(source: string, maxTailCodeUnits: number): string[] {
  const cacheRef = useRef(emptyMarkdownBlockCache);
  return useMemo(() => {
    cacheRef.current = advanceMarkdownBlocks(
      cacheRef.current,
      source,
      maxTailCodeUnits,
    );
    return cacheRef.current.blocks;
  }, [source, maxTailCodeUnits]);
}

const Block = memo(function MarkdownBlock({
  raw,
  originalRaw,
  sourceOffset,
  renderDiagrams,
  workspaceRoot,
  baseDir,
}: {
  raw: string;
  originalRaw: string;
  sourceOffset: number;
  renderDiagrams: boolean;
  workspaceRoot?: string | null;
  baseDir?: string;
}) {
  const context = useMemo(
    () => ({
      closedFence: isClosedFencedCodeBlock(raw),
      renderDiagrams,
      originalRaw,
    }),
    [raw, originalRaw, renderDiagrams],
  );
  const remarkPlugins = useMemo(
    () => [
      ...staticRemarkPlugins,
      // `originalRaw` still carries the TeX `\[ … \]` delimiters so the
      // bracket-display plugin can promote them to display math after
      // remark-math parses the pre-normalized `$$ … $$` form.
      remarkLatexBracketDisplay(originalRaw),
      remarkChatFileLinks(workspaceRoot, baseDir),
    ],
    [originalRaw, workspaceRoot, baseDir],
  );
  const positionedRehypePlugins = useMemo(
    () => [...rehypePlugins!, [rehypeSourcePositions, { offset: sourceOffset }]] as Options["rehypePlugins"],
    [sourceOffset],
  );
  return (
    <Profiler
      id="transcript-markdown-block"
      onRender={(_id, phase, actualDuration, baseDuration, startTime, commitTime) => {
        recordRenderDiagnostic("markdown-react-render", {
          sourceLength: raw.length,
          durationMs: actualDuration,
          baseDurationMs: baseDuration,
          startTime,
          commitTime,
          renderPhase: phase,
        });
      }}
    >
      <MarkdownBlockContext.Provider value={context}>
        <ReactMarkdown
          urlTransform={(url) => parseSessionLinkToken(url) || annotationMarkerIndexFromHref(url) !== null ? url : defaultUrlTransform(url)}
          remarkPlugins={remarkPlugins}
          rehypePlugins={positionedRehypePlugins}
          components={markdownComponents}
        >
          {raw}
        </ReactMarkdown>
      </MarkdownBlockContext.Provider>
    </Profiler>
  );
});

export const Markdown = memo(function Markdown({
  source,
  renderDiagrams = true,
  baseDir,
  streaming = false,
}: {
  source: string;
  renderDiagrams?: boolean;
  /** True only while an assistant message is still receiving text. */
  streaming?: boolean;
  /** Workspace-relative directory of the source file, for `./` / `../` links. */
  baseDir?: string;
}) {
  const workspaceRoot = useMarkdownWorkspaceRoot();

  // 图片菜单由整个 Markdown 树持有，流式块替换不会卸载菜单。
  const fileMenuItems = useChatFileMenuItems();
  const {
    contextMenu: fileMenu,
    openContextMenu: openFileMenu,
    closeContextMenu: closeFileMenu,
  } = useContextMenu();
  const openMarkdownFileMenu = useCallback<OpenMarkdownFileMenu>(
    (event, target) => openFileMenu(event, { items: fileMenuItems(target) }),
    [fileMenuItems, openFileMenu],
  );
  const { t } = useTranslation();
  const fullSourceTooLarge = source.length > MAX_SYNC_MARKDOWN_CODE_UNITS;
  const markdownTailLimit = streaming
    ? MAX_STREAMING_MARKDOWN_TAIL_CODE_UNITS
    : MAX_SYNC_MARKDOWN_CODE_UNITS;
  // Keep normalization length-preserving so source anchors and the bracket
  // display plugin still address the original text. Block splitting uses the
  // same math grammar as rendering, including unclosed streaming math blocks.
  const normalizedSource = useMemo(
    () => {
      const finishDiagnostic = beginRenderDiagnostic("markdown-normalize", {
        sourceLength: source.length,
      });
      if (fullSourceTooLarge) {
        finishDiagnostic({ reason: "source-limit" });
        return "";
      }
      const normalized = normalizeLatexMathDelimiters(source);
      finishDiagnostic();
      return normalized;
    },
    [fullSourceTooLarge, source],
  );
  const blocks = useBlocks(
    fullSourceTooLarge ? "" : normalizedSource,
    markdownTailLimit,
  );
  let sourceOffset = 0;
  return (
    <MarkdownFileMenuContext.Provider value={openMarkdownFileMenu}>
      <MarkdownBaseDirContext.Provider value={baseDir ?? ""}>
        {fullSourceTooLarge ? (
          <div
            className="markdown-plain-fallback"
            data-source-start={0}
            data-source-end={source.length}
          >
            <div role="status">{t("chat.markdownPlainTextFallback")}</div>
            <pre>{source}</pre>
          </div>
        ) : blocks.map((raw, i) => {
          const start = sourceOffset;
          sourceOffset = start + raw.length;
          const originalRaw = source.slice(start, start + raw.length);
          const tailTooLarge = streaming && raw.length > markdownTailLimit;
          if (tailTooLarge) {
            return (
              <div
                className="markdown-plain-fallback"
                key={i}
                data-source-start={start}
                data-source-end={start + raw.length}
              >
                <div role="status">{t("chat.markdownPlainTextFallback")}</div>
                <pre>{originalRaw}</pre>
              </div>
            );
          }
          return (
            <Block
              key={i}
              raw={raw}
              originalRaw={originalRaw}
              sourceOffset={start}
              renderDiagrams={renderDiagrams}
              workspaceRoot={workspaceRoot}
              baseDir={baseDir}
            />
          );
        })}
      </MarkdownBaseDirContext.Provider>
      <ContextMenu state={fileMenu} onClose={closeFileMenu} />
    </MarkdownFileMenuContext.Provider>
  );
});
