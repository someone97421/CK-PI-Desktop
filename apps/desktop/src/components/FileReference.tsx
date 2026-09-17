import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { FsChatRefMatch } from "@pi-desktop/shared";
import { api } from "../lib/api";
import { safeDecodeUri, toWorkspaceRel } from "../lib/chat-links";
import { useAppStore } from "../stores/app-store";
import { useOpenChatFileRef } from "../hooks/use-preview-target";
import { PortalTooltip, useTooltip } from "./ui";
import {
  IconCopy,
  IconExternal,
  IconFileText,
  IconFolderOpen,
  IconPanelOpen,
} from "./icons";

/*
 * Local file references in chat markdown (links and inline-code chips).
 *
 * `FileRefTarget` wraps the existing anchor/button and adds two behaviors
 * without changing the click contract:
 *
 *   - hover/focus shows the reference's full path in the shared themed
 *     tooltip (`ui-tooltip-path`), not a native `title`;
 *   - right-click / Shift+F10 / ContextMenu opens a menu with the actions the
 *     existing IPC surface already supports (preview, open with the default
 *     application, copy path, copy text content, reveal in folder).
 *
 * Resolution is lazy; only simultaneous requests share a promise. Later
 * interactions resolve again so newly created files and project changes are
 * reflected. File operations remain subject to main-process path checks.
 */

type FileRefResolution =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "file"; match: FsChatRefMatch }
  | {
      /**
       * No regular file matched (e.g. the reference names a directory). Only
       * a canonical workspace-relative path may fall back here; open/reveal
       * are still validated by the main process, and content copy stays off.
       */
      status: "fallback";
      relativePath: string;
    };

const MAX_RESOLVE_CACHE_ENTRIES = 500;
const resolveCache = new Map<string, Promise<FsChatRefMatch | null>>();

function resolveChatFileRefCached(
  path: string,
  sessionId: string | null | undefined,
  root: string | null,
): Promise<FsChatRefMatch | null> {
  const key = JSON.stringify([sessionId, root, path]);
  const cached = resolveCache.get(key);
  if (cached) return cached;
  if (resolveCache.size >= MAX_RESOLVE_CACHE_ENTRIES) resolveCache.clear();
  const pending = api.fsResolveRef(path, sessionId ?? undefined)
    .then((result) => result.match)
    .catch(() => null)
    .finally(() => { if (resolveCache.get(key) === pending) resolveCache.delete(key); });
  resolveCache.set(key, pending);
  return pending;
}

/**
 * Normalize a raw chat token for display and resolution: URI-decode, drop the
 * composer `@` sigil and quotes, accept the `/I:/…` href spelling of a
 * Windows drive path, and split off a trailing `:line[:col]` — the suffix is
 * displayed but never takes part in an operation.
 */
export function cleanChatFileRef(rawRef: string): {
  path: string;
  lineSuffix: string;
} {
  let value = String(rawRef ?? "").trim();
  try { value = decodeURIComponent(value); } catch { value = safeDecodeUri(value); }
  if (value.startsWith("@")) value = value.slice(1).trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).trim();
  }
  value = value.replace(/^\/(?=[A-Za-z]:[/\\])/, "");
  const lineSuffix = /:\d+(?::\d+)?$/.exec(value)?.[0] ?? "";
  return {
    path: lineSuffix ? value.slice(0, -lineSuffix.length) : value,
    lineSuffix,
  };
}

function useFileRefResolution(
  rawRef: string,
  baseDir: string | undefined,
  active: boolean,
): FileRefResolution {
  const sessionId = useAppStore((s) => s.activeSessionId);
  const root = useAppStore((s) => s.workspace?.path ?? null);
  const key = JSON.stringify([sessionId, root, baseDir, rawRef]);
  const [state, setState] = useState<{ key: string; value: FileRefResolution }>({ key: "", value: { status: "loading" } });
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const update = (value: FileRefResolution) => { if (alive) setState({ key, value }); };
    const { path } = cleanChatFileRef(rawRef);
    const relativeToDocument = /^\.{1,2}[/\\]/.test(path);
    const lookup = relativeToDocument ? toWorkspaceRel(path, root, baseDir) : path;
    if (!lookup) {
      update({ status: "missing" });
      return;
    }
    update({ status: "loading" });
    void resolveChatFileRefCached(lookup, sessionId, root).then((match) => {
      if (!alive) return;
      if (match) {
        update({ status: "file", match });
        return;
      }
      // The resolver returns regular files only. A workspace-contained path
      // may still be a directory; main validates real containment on actions.
      const rel = root ? toWorkspaceRel(lookup, root) : null;
      update(rel ? { status: "fallback", relativePath: rel } : { status: "missing" });
    });
    return () => { alive = false; };
  }, [active, key, rawRef, baseDir, root, sessionId]);
  return state.key === key ? state.value : { status: "loading" };
}

/** Full path shown on hover; the `:line[:col]` suffix rides along. */
function fileRefDisplayPath(
  rawRef: string,
  resolution: FileRefResolution,
  root: string | null,
): string {
  const { path, lineSuffix } = cleanChatFileRef(rawRef);
  if (resolution.status === "file") {
    return `${resolution.match.absolutePath}${lineSuffix}`;
  }
  if (resolution.status === "fallback" && root) {
    const fullPath = `${root.replace(/[\\/]+$/, "")}/${resolution.relativePath}`;
    return `${/^[A-Za-z]:/.test(root) ? fullPath.replaceAll("/", "\\") : fullPath}${lineSuffix}`;
  }
  return path;
}

function FileRefMenu({
  rawRef,
  baseDir,
  position,
  onClose,
}: {
  rawRef: string;
  baseDir?: string;
  /** Requested cursor position; clamped into the viewport after measuring. */
  position: { x: number; y: number };
  onClose: (restoreFocus: boolean) => void;
}) {
  const { t } = useTranslation();
  const root = useAppStore((s) => s.workspace?.path ?? null);
  const openFileRef = useOpenChatFileRef();
  const showToast = useAppStore((s) => s.showToast);
  const resolution = useFileRefResolution(rawRef, baseDir, true);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [layout, setLayout] = useState(position);

  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect();
    if (!rect) return;
    setLayout({
      x: Math.min(
        Math.max(8, position.x),
        Math.max(8, window.innerWidth - rect.width - 8),
      ),
      y: Math.min(
        Math.max(8, position.y),
        Math.max(8, window.innerHeight - rect.height - 8),
      ),
    });
    // The row count changes when resolution lands, so re-clamp on status too.
  }, [position, resolution.status]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose(true);
    };
    const onScroll = () => onClose(false);
    const onResize = () => onClose(false);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose]);

  // Focus the first actionable row once one exists (a cached resolution may
  // only arrive after the menu painted its locating row).
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu || menu.contains(document.activeElement)) return;
    menu
      .querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
  }, [resolution.status]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") { onClose(false); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ),
    );
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
    items[next]?.focus();
  };

  const runAction = (action: () => Promise<unknown>) => {
    onClose(true);
    void action().catch(() => {
      showToast(t("chat.fileActionFailed"), { variant: "error" });
    });
  };

  const runCopy = (text: string, successLabel: string) => {
    onClose(true);
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
        showToast(successLabel, { variant: "success" });
      } catch {
        showToast(t("chat.fileCopyFailed"), { variant: "error" });
      }
    })();
  };

  const copyContent = (absolutePath: string) => {
    onClose(true);
    void (async () => {
      try {
        const result = await api.fsRead(absolutePath);
        // Only a complete text read is copied; binary, image, and oversized
        // results never reach the clipboard half-truncated.
        if (result.kind === "text" && typeof result.content === "string") {
          await navigator.clipboard.writeText(result.content);
          showToast(t("chat.fileContentCopied"), { variant: "success" });
        } else {
          showToast(t("chat.fileContentNotText"), { variant: "error" });
        }
      } catch {
        showToast(t("chat.fileCopyFailed"), { variant: "error" });
      }
    })();
  };

  let body: ReactNode;
  if (resolution.status === "loading") {
    body = (
      <button type="button" role="menuitem" disabled>
        <IconFileText size={14} />
        {t("chat.fileMenuResolving")}
      </button>
    );
  } else if (resolution.status === "missing") {
    body = (
      <button type="button" role="menuitem" disabled>
        <IconFileText size={14} />
        {t("chat.fileRefMissing", { name: cleanChatFileRef(rawRef).path })}
      </button>
    );
  } else {
    // The path every file action runs against: the resolved absolute path,
    // or the canonical workspace-relative fallback the main process
    // re-validates on each call.
    const actionPath =
      resolution.status === "file"
        ? resolution.match.absolutePath
        : resolution.relativePath;
    const displayPath = fileRefDisplayPath(rawRef, resolution, root);
    body = (
      <>
        {resolution.status === "file" ? (
          <>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onClose(true);
                openFileRef(resolution.match.absolutePath);
              }}
            >
              <IconPanelOpen size={14} />
              {t("chat.previewFile")}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => copyContent(resolution.match.absolutePath)}
            >
              <IconFileText size={14} />
              {t("chat.fileMenuCopyContent")}
            </button>
          </>
        ) : null}
        <button
          type="button"
          role="menuitem"
          onClick={() => runAction(() => api.fsOpen(actionPath))}
        >
          <IconExternal size={14} />
          {t("chat.openFile")}
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => runCopy(displayPath.replace(/:\d+(?::\d+)?$/, ""), t("chat.filePathCopied"))}
        >
          <IconCopy size={14} />
          {t("chat.fileMenuCopyPath")}
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={() => runAction(() => api.fsReveal(actionPath))}
        >
          <IconFolderOpen size={14} />
          {t("chat.fileMenuReveal")}
        </button>
      </>
    );
  }

  return createPortal(
    <div
      ref={menuRef}
      className="sidebar-row-menu sidebar-floating-menu"
      role="menu"
      onKeyDown={onMenuKeyDown}
      style={{ top: layout.y, left: layout.x }}
      onClick={(e) => e.stopPropagation()}
    >
      {body}
    </div>,
    document.body,
  );
}

/**
 * Wrap one rendered local file reference (an anchor or inline-code chip) with
 * the full-path hover/focus tooltip and the right-click file menu. Children
 * keep their own click behavior and styling; this wrapper only listens.
 */
export function FileRefTarget({
  fileRef,
  baseDir,
  children,
}: {
  /** The reference as written in chat (`@`, quotes, `:line[:col]` allowed). */
  fileRef: string;
  baseDir?: string;
  children: ReactNode;
}) {
  const root = useAppStore((s) => s.workspace?.path ?? null);
  const [resolveRequested, setResolveRequested] = useState(false);
  const sessionId = useAppStore((s) => s.activeSessionId);
  useEffect(() => { setMenu(null); setResolveRequested(false); }, [sessionId, root, fileRef, baseDir]);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const resolution = useFileRefResolution(
    fileRef,
    baseDir,
    resolveRequested || menu !== null,
  );
  const label = fileRefDisplayPath(fileRef, resolution, root);
  const tooltip = useTooltip<HTMLSpanElement>(label, false, 300, false, 100);
  const anchorRef = tooltip.anchorRef;

  const openMenuAt = (x: number, y: number) => {
    // The tooltip is gated out of rendering while the menu is open (below)
    // instead of being dismissed, so a hover that outlives the menu brings
    // the path back without a pointer round-trip.
    setResolveRequested(true);
    setMenu({ x, y });
  };

  const onContextMenu = (event: React.MouseEvent) => {
    // Keep the message-level context menu out of file references.
    event.preventDefault();
    event.stopPropagation();
    openMenuAt(event.clientX, event.clientY + 4);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const isMenuKey =
      event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
    if (!isMenuKey) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = anchorRef.current?.getBoundingClientRect();
    openMenuAt(rect?.left ?? 16, (rect?.bottom ?? 16) + 4);
  };

  const closeMenu = useCallback(
    (restoreFocus: boolean) => {
      setMenu(null);
      if (restoreFocus) {
        requestAnimationFrame(() => {
          anchorRef.current
            ?.querySelector<HTMLElement>("a, button")
            ?.focus();
        });
      }
    },
    [anchorRef],
  );

  return (
    <>
      <span
        ref={anchorRef}
        onPointerEnter={() => {
          setResolveRequested(true);
          tooltip.onPointerEnter();
        }}
        onPointerLeave={() => {
          if (!anchorRef.current?.contains(document.activeElement)) setResolveRequested(false);
          tooltip.onPointerLeave();
        }}
        onFocus={() => {
          setResolveRequested(true);
          tooltip.onFocus();
        }}
        onBlur={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setResolveRequested(false);
          tooltip.onBlur();
        }}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
      >
        {children}
      </span>
      {tooltip.open && tooltip.position && !menu ? (
        <PortalTooltip
          label={label}
          position={tooltip.position}
          className="ui-tooltip-path"
        />
      ) : null}
      {menu ? (
        <FileRefMenu
          rawRef={fileRef}
          baseDir={baseDir}
          position={menu}
          onClose={closeMenu}
        />
      ) : null}
    </>
  );
}
