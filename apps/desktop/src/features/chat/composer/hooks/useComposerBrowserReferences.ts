import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { browserReferenceClient } from "../../../../lib/browser-reference-client";
import { draftFileReference, writeComposerDraft } from "../../../../lib/composer-draft-cache";
import { activeComposerDraftKey } from "../../../../lib/temporary-drafts";
import { useAppStore } from "../../../../stores/app-store";
import { browserInsertionReferences, checkedBrowserReferenceMark, clampBrowserInsertionRange } from "../browser-references";
import { editorSelectionRange, type ComposerFileReference } from "../editor";
import { placePluginMark } from "../plugins/plugin-marks";

type SelectionRange = { start: number; end: number };
type Options = {
  editorRef: RefObject<HTMLDivElement | null>;
  draftKey: string;
  loadedDraftKeyRef: RefObject<string>;
  referenceSessionId: string;
  inputBlocked: boolean;
  composing: boolean;
  valueRef: RefObject<string>;
  referencesRef: RefObject<ComposerFileReference[]>;
  invalidate: () => void;
  apply: (text: string, references: ComposerFileReference[], caret: number, focus?: boolean) => void;
};

export function useComposerBrowserReferences(options: Options) {
  const [clientId] = useState(() => `composer-${crypto.randomUUID()}`);
  const latest = useRef(options);
  latest.current = options;
  const saved = useRef<{ draftKey: string; range: SelectionRange | null }>({ draftKey: options.draftKey, range: null });
  const completed = useRef(new Map<string, { ok: boolean; error?: string }>());
  const inFlight = useRef(new Set<string>());
  const revision = useRef(0);

  useLayoutEffect(() => {
    saved.current = { draftKey: options.draftKey, range: null };
  }, [options.draftKey]);

  const available = () => {
    const current = latest.current;
    const editor = current.editorRef.current;
    return !current.inputBlocked && !current.composing && !!editor?.isConnected
      && current.loadedDraftKeyRef.current === current.draftKey
      && activeComposerDraftKey(useAppStore.getState()) === current.draftKey
      && editor.getAttribute("contenteditable") !== "false"
      && !editor.closest("[hidden], [inert], [aria-hidden='true']")
      && editor.getClientRects().length > 0
      && getComputedStyle(editor).visibility !== "hidden";
  };
  const rememberSelection = () => {
    const { editorRef, draftKey, loadedDraftKeyRef } = latest.current;
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || loadedDraftKeyRef.current !== draftKey || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return;
    saved.current = { draftKey, range: editorSelectionRange(editor) };
  };
  const insertionRange = (length: number) => clampBrowserInsertionRange(
    saved.current.draftKey === latest.current.draftKey ? saved.current.range : null, length,
  );
  const rememberCaret = (caret: number) => {
    saved.current = { draftKey: latest.current.draftKey, range: { start: caret, end: caret } };
  };

  useEffect(() => {
    const editor = options.editorRef.current;
    if (!editor) return;
    const remember = (event: Event) => {
      if (event.type === "selectionchange"
        && (!document.hasFocus() || document.activeElement !== latest.current.editorRef.current)) return;
      rememberSelection();
    };
    document.addEventListener("selectionchange", remember);
    for (const event of ["keyup", "input", "blur"]) editor.addEventListener(event, remember);
    return () => {
      document.removeEventListener("selectionchange", remember);
      for (const event of ["keyup", "input", "blur"]) editor.removeEventListener(event, remember);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listeners read latest refs
  }, []);

  useEffect(() => {
    const editor = options.editorRef.current;
    if (!editor) return;
    let lastAvailable: boolean | null = null;
    const publish = (focused = false, force = false) => {
      const canCompose = available();
      if (!force && !focused && lastAvailable === canCompose) return;
      lastAvailable = canCompose;
      void browserReferenceClient.register({ clientId, draftKey: options.draftKey, available: canCompose,
        focused: canCompose && (focused || document.hasFocus() && document.activeElement === editor), revision: ++revision.current })
        .catch(() => undefined);
    };
    const claimFocus = () => {
      if (document.activeElement === editor) publish(true);
    };
    const refresh = () => publish();
    const reconnect = () => publish(false, true);
    editor.addEventListener("focusin", claimFocus);
    window.addEventListener("focus", claimFocus);
    window.addEventListener("pi-desktop:remote-reconnected", reconnect);
    document.addEventListener("visibilitychange", refresh);
    const observer = new MutationObserver(refresh);
    for (let ancestor: HTMLElement | null = editor; ancestor; ancestor = ancestor.parentElement) {
      observer.observe(ancestor, { attributes: true, attributeFilter: ["hidden", "inert", "style", "class", "aria-hidden", "contenteditable"] });
    }
    const heartbeat = window.setInterval(() => publish(false, true), 5000);
    publish(false, true);
    return () => {
      editor.removeEventListener("focusin", claimFocus);
      window.removeEventListener("focus", claimFocus);
      window.removeEventListener("pi-desktop:remote-reconnected", reconnect);
      document.removeEventListener("visibilitychange", refresh);
      observer.disconnect();
      window.clearInterval(heartbeat);
      void browserReferenceClient.register({ clientId, draftKey: options.draftKey, available: false, focused: false, revision: ++revision.current })
        .catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- heartbeat and listeners read latest refs
  }, [clientId, options.draftKey, options.inputBlocked, options.composing]);

  useEffect(() => browserReferenceClient.onInsertion(async insertion => {
    if (insertion.clientId !== clientId || inFlight.current.has(insertion.requestId)) return;
    const acknowledge = (result: { ok: boolean; error?: string }) => {
      void browserReferenceClient.acknowledge({
        requestId: insertion.requestId, clientId, draftKey: insertion.draftKey, ...result,
      }).catch(() => undefined);
    };
    const previous = completed.current.get(insertion.requestId);
    if (previous) { acknowledge(previous); return; }
    inFlight.current.add(insertion.requestId);
    let result: { ok: boolean; error?: string };
    try {
      const claim = await browserReferenceClient.claim(insertion);
      const current = latest.current;
      if (!claim.accepted) {
        throw new Error("浏览器引用请求已失效，请重新发送");
      }
      if (insertion.draftKey !== current.draftKey || !available()) {
        throw new Error("目标输入框已切换草稿或当前不可编辑，请重新选择输入框");
      }
      const mark = checkedBrowserReferenceMark(insertion.reference);
      const source = current.valueRef.current;
      const { start, end } = insertionRange(source.length);
      const text = source.slice(0, start) + source.slice(end);
      const references = browserInsertionReferences(current.referencesRef.current, text, current.referenceSessionId);
      const placed = placePluginMark(references, text, mark, current.referenceSessionId);
      const token = placed.token ?? "";
      const nextText = text.slice(0, start) + token + text.slice(start);
      current.invalidate();
      current.apply(nextText, placed.references, start + token.length, false);
      rememberCaret(start + token.length);
      writeComposerDraft(current.draftKey, { text: nextText, fileReferences: placed.references.map(draftFileReference) });
      result = { ok: true };
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    completed.current.set(insertion.requestId, result);
    acknowledge(result);
    inFlight.current.delete(insertion.requestId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one listener per client, options read through latest
  }), [clientId]);

  return { available, insertionRange, rememberCaret };
}
