import type { CSSProperties } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { Sidebar } from "../../src/components/Sidebar";
import { useAppStore } from "../../src/stores/app-store";
import "../../src/styles/globals.css";

async function renderSidebar() {
  await i18n.use(initReactI18next).init({
    lng: "en",
    resources: { en: { translation: catalogs.en } },
  });

  const projectPath = "/fixture/project";
  const sidebarWidth = 275;
  const calls: string[] = [];
  const sessions = Array.from({ length: 27 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, 1, 0, 27 - index)).toISOString();
    return {
      id: `session-${index}`,
      title: `Session ${index}`,
      projectPath: index < 19 ? projectPath : null,
      createdAt: date,
      updatedAt: date,
    };
  });
  useAppStore.setState({
    page: "chat",
    sessions,
    sessionView: { sort: "recent", archived: false },
    openProjectPaths: [projectPath],
    sessionMeta: Object.fromEntries([sessions[0], ...sessions.slice(13, 19)]
      .map(({ id }) => [id, { pinned: true }])),
    prefetchSession: async () => {},
    selectSession: async (id) => { calls.push(id); },
  });
  const root = createRoot(document.getElementById("root")!);
  flushSync(() => root.render(
    <div className="app-shell" style={{ "--ds-sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <div className="app-chat-shell">
        <Sidebar
          sidebarWidth={sidebarWidth}
          sidebarToggleShortcut=""
          onToggleSidebar={() => {}}
          onWidthChange={() => {}}
          onWidthCommit={() => {}}
        />
      </div>
    </div>,
  ));
  return { calls };
}

Object.assign(window, { sidebarProbe: renderSidebar() });
