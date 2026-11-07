import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionTodo, TodoStatus } from "@pi-desktop/shared";
import { Button } from "./ui";
import { IconCheck, IconChevronDown, IconChevronUp } from "./icons";
import { useSessionTodosRecovery } from "../features/chat/todos/useSessionTodosRecovery";
import { useAppStore } from "../stores/app-store";

export type TodoProgress = { label: string; symbol: string; current: SessionTodo | undefined };

export function todoProgress(todos: readonly SessionTodo[], t: (key: string, options?: Record<string, unknown>) => string): TodoProgress {
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const cancelled = todos.filter((todo) => todo.status === "cancelled").length;
  const denominator = todos.length - cancelled;
  const current = todos.find((todo) => todo.status === "in_progress");
  const allCancelled = todos.length > 0 && cancelled === todos.length;
  const finished = todos.every((todo) => todo.status === "completed" || todo.status === "cancelled");
  return {
    label: allCancelled ? t("chat.todo.status.cancelled") : finished
      ? t("chat.todo.completed", { completed, total: denominator })
      : t("chat.todo.progress", { completed, total: denominator }),
    symbol: allCancelled ? "⊘" : finished ? "✓" : "◐",
    current,
  };
}

export function TodoPanel({ todos, listId, interactive, labelledBy }: {
  todos: readonly SessionTodo[]; listId: string; interactive: boolean; labelledBy?: string;
}) {
  return (
    <div id={listId} className="dock-panel" role="tabpanel" aria-labelledby={labelledBy} hidden={!interactive}>
      <div className="todo-dock-list" role="list" tabIndex={interactive ? 0 : -1}>
        {todos.map((todo, index) => <TodoRow key={`${index}:${todo.content}`} todo={todo} shimmer={interactive} />)}
      </div>
    </div>
  );
}

function statusSymbol(status: TodoStatus): string {
  switch (status) {
    case "in_progress":
      return "•";
    case "cancelled":
      return "−";
    default:
      return "";
  }
}

export function TodoDock({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const snapshot = useAppStore((state) => state.sessionTodos[sessionId]);
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();

  useEffect(() => {
    setExpanded(false);
  }, [sessionId]);

  useSessionTodosRecovery(sessionId);
  if (!snapshot || snapshot.todos.length === 0) return null;
  const progress = todoProgress(snapshot.todos, t);
  const current = progress.current;
  const currentShimmers = !expanded && current !== undefined;
  return (
    <div className={`todo-dock${expanded ? " is-expanded" : ""}`}>
      <div className="todo-dock-header">
        <span className="todo-dock-header-symbol" aria-hidden>
          {progress.symbol}
        </span>
        <div className="todo-dock-header-copy">
          <span className="todo-dock-header-text">{progress.label}</span>
          {current ? (
            <span
              className={`todo-dock-header-current${currentShimmers ? " todo-dock-shimmer" : ""}`}
              title={current.content}
            >
              {current.content}
            </span>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          className="todo-dock-toggle"
          aria-label={expanded ? t("chat.todo.collapse") : t("chat.todo.expand")}
          title={expanded ? t("chat.todo.collapse") : t("chat.todo.expand")}
          aria-controls={contentId}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <IconChevronDown size={18} /> : <IconChevronUp size={18} />}
        </Button>
      </div>
      <div id={contentId} className="todo-dock-content" aria-hidden={!expanded}>
        <div className="todo-dock-clip">
          {/* The expanded dock lists every row (#1319): the list scrolls
              inside its own box instead of truncating to a static "N more"
              line, and a keyboard user can reach that scrollport only while
              the disclosure is open. */}
          <div
            className="todo-dock-list"
            role="list"
            tabIndex={expanded ? 0 : -1}
          >
            {snapshot.todos.map((todo, index) => (
              <TodoRow key={`${index}:${todo.content}`} todo={todo} shimmer={expanded} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* `shimmer` is only true while the list is open: the collapsed header already
   carries the working step's text, and the list stays mounted behind the
   disclosure, so without this gate the same text would sweep twice. */
function TodoRow({ todo, shimmer }: { todo: SessionTodo; shimmer: boolean }) {
  const { t } = useTranslation();
  const label = t(`chat.todo.status.${todo.status}`);
  const working = shimmer && todo.status === "in_progress";
  return (
    <div className={`todo-dock-row todo-dock-row-${todo.status}`} role="listitem">
      <span className="todo-dock-row-symbol" role="img" aria-label={label} title={label}>
        {todo.status === "completed" ? <IconCheck size={13} aria-hidden /> : statusSymbol(todo.status)}
      </span>
      <span
        className={`todo-dock-row-content${working ? " todo-dock-shimmer" : ""}`}
        title={todo.content}
      >
        {todo.content}
      </span>
    </div>
  );
}
