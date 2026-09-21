import { useId } from "react";
import { useTranslation } from "react-i18next";
import { subagentObserverLocation, type SubagentPanelSelection } from "../../lib/subagent-panel";
import { useAppStore } from "../../stores/app-store";
import { PluginViewTab } from "./PluginViewTab";

/** 观测内容由内置插件维护；宿主只保留现有入口和工作面板生命周期。 */
export function SubagentPanel({ selection, blocked = false }: {
  selection: SubagentPanelSelection;
  blocked?: boolean;
}) {
  const { t } = useTranslation();
  const openId = useId();
  const focus = useAppStore((state) => state.transcriptViews[selection.sessionId]?.focus);
  return (
    <section id="subagent-panel" className="work-panel-tabpane" role="complementary"
      aria-label={t("panel.subagent")} data-testid="subagent-panel">
      <PluginViewTab
        pluginId="local.subagent-observer"
        viewId="observer"
        title={t("panel.subagent")}
        sessionId={selection.sessionId}
        location={`${subagentObserverLocation(selection, focus)}&open=${encodeURIComponent(openId)}`}
        blocked={blocked}
      />
    </section>
  );
}
