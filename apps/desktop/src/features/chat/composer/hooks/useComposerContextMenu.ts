import type { MouseEvent, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useContextMenu, type ContextMenuItem } from "../../../../components/ContextMenu";
import { api } from "../../../../lib/api";
import { useAppStore } from "../../../../stores/app-store";
import { editorSelectionRange, setEditorCaret } from "../editor";

export function useComposerContextMenu({
  inputRef,
  inputBlocked,
  onInsert,
}: {
  inputRef: RefObject<HTMLDivElement | null>;
  inputBlocked: boolean;
  onInsert?: (kind: "commands" | "skills", selection: { start: number; end: number }) => void;
}) {
  const { t } = useTranslation();
  const menu = useContextMenu();

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const editor = inputRef.current;
    if (!editor) return;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const savedRange = range && editor.contains(range.startContainer) && editor.contains(range.endContainer)
      ? range.cloneRange()
      : null;
    const hasSelection = savedRange !== null && !savedRange.collapsed;
    editor.focus({ preventScroll: true });
    if (!savedRange) setEditorCaret(editor, editorSelectionRange(editor).end);
    const offsets = editorSelectionRange(editor);
    const restore = () => {
      if (!editor.isConnected) return false;
      editor.focus({ preventScroll: true });
      if (savedRange) {
        const current = window.getSelection();
        current?.removeAllRanges();
        current?.addRange(savedRange);
      } else {
        setEditorCaret(editor, offsets.start);
      }
      return true;
    };
    const edit = (action: "undo" | "redo" | "cut" | "copy" | "paste") => {
      if (!restore()) return;
      void api.nativeMenuAction(action).catch((error: unknown) => {
        useAppStore.getState().showToast(String(error));
      });
    };
    const items: ContextMenuItem[] = [
      { id: "undo", label: t("menu.undo"), disabled: inputBlocked || !document.queryCommandEnabled("undo"), onSelect: () => edit("undo") },
      { id: "redo", label: t("menu.redo"), disabled: inputBlocked || !document.queryCommandEnabled("redo"), onSelect: () => edit("redo") },
      { id: "cut", label: t("menu.cut"), separatorBefore: true, disabled: inputBlocked || !hasSelection, onSelect: () => edit("cut") },
      { id: "copy", label: t("menu.copy"), disabled: !hasSelection, onSelect: () => edit("copy") },
      { id: "paste", label: t("menu.paste"), disabled: inputBlocked, onSelect: () => edit("paste") },
      {
        id: "selectAll", label: t("menu.selectAll"), separatorBefore: true,
        onSelect: () => {
          if (!restore()) return;
          const all = document.createRange();
          all.selectNodeContents(editor);
          const current = window.getSelection();
          current?.removeAllRanges();
          current?.addRange(all);
        },
      },
    ];
    if (onInsert) {
      for (const kind of ["commands", "skills"] as const) {
        items.push({
          id: `insert-${kind}`,
          label: t(kind === "commands" ? "chat.insertCommand" : "chat.insertSkill"),
          separatorBefore: kind === "commands",
          disabled: inputBlocked,
          onSelect: () => {
            if (restore()) onInsert(kind, offsets);
          },
        });
      }
    }
    menu.openContextMenu(event, { label: t("chat.inputMenu"), items });
  };

  return { ...menu, onContextMenu };
}
