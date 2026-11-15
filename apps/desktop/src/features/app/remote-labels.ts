import { useTranslation } from "react-i18next";

const words = {
  "zh-CN": {
    projects: "项目列表", temporary: "临时会话", search: "搜索项目或会话", refresh: "刷新",
    refreshed: "已刷新", refreshing: "刷新中…", newChat: "新建会话", more: "加载更多",
    empty: "暂无会话", noResults: "没有匹配的项目或会话", backProjects: "◄ 返回项目列表",
    backChat: "◄ 返回对话", panel: "工作面板", continueChat: "继续对话", chooseDirectory: "选择目录并新建临时会话",
    directory: "电脑工作目录（可选）", directoryHint: "填写电脑上的绝对路径；留空使用会话临时目录。",
  },
  en: {
    projects: "Projects", temporary: "Temporary chats", search: "Search projects or chats", refresh: "Refresh",
    refreshed: "Refreshed", refreshing: "Refreshing…", newChat: "New chat", more: "Load more",
    empty: "No chats yet", noResults: "No matching projects or chats", backProjects: "◄ Back to projects",
    backChat: "◄ Back to chat", panel: "Work panel", continueChat: "Continue chat", chooseDirectory: "Choose a folder and start a temporary chat",
    directory: "Computer working directory (optional)", directoryHint: "Enter an absolute path on the computer. Leave empty to use the session's temporary directory.",
  },
};
export function useRemoteLabels() {
  const { i18n } = useTranslation();
  return words[i18n.resolvedLanguage?.startsWith("zh") ? "zh-CN" : "en"];
}
