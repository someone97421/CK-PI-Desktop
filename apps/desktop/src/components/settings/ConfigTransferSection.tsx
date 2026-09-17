import { useState } from "react";
import { CONFIG_SCOPES, type ConfigScope } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { flushSettingsWrites } from "../../lib/settings-save";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../ui";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";

const labels: Record<ConfigScope, string> = {
  appearance: "外观", shortcuts: "快捷键", instructions: "指令", models: "模型", subagents: "子智能体",
};

export function ConfigTransferSection() {
  const [scopes, setScopes] = useState<ConfigScope[]>([...CONFIG_SCOPES]);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [message, setMessage] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const run = async (action: "export" | "import") => {
    if (busy) return;
    setBusy(action);
    setMessage("");
    setWarnings([]);
    try {
      await flushSettingsWrites();
      const result = action === "export" ? await api.exportConfig(scopes) : await api.importConfig();
      if (result.canceled) return;
      setWarnings(result.warnings);
      setMessage(action === "export" ? `已导出 ${result.applied} 类配置。` :
        `导入完成：已应用 ${result.applied} 项，跳过 ${result.skipped} 项，失败 ${result.failed} 项。`);
      if (action === "import") {
        try {
          const settings = await api.getSettings();
          useAppStore.setState({ settings });
          await useAppStore.getState().refreshProviders();
        } catch {
          setWarnings((current) => [...current, "配置处理已完成，界面刷新失败，请重新打开设置。"]);
        }
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "配置处理失败，请重试。");
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsCard title="配置导入导出">
      <SettingsRow title="导出范围" description="勾选需要备份或迁移的配置。指令包含全局指令，子智能体包含自定义配置与内置开关。">
        <div className="flex flex-wrap gap-3" role="group" aria-label="导出范围">
          {CONFIG_SCOPES.map((scope) => (
            <label key={scope} className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={scopes.includes(scope)} disabled={!!busy}
                onChange={(event) => setScopes((current) => event.target.checked ? [...current, scope] : current.filter((s) => s !== scope))} />
              <span>{labels[scope]}</span>
            </label>
          ))}
        </div>
      </SettingsRow>
      <SettingsRow title="导出配置" description={scopes.includes("models")
        ? "模型配置包含手动添加的提供商及其 API 密钥，请妥善保管导出文件。OAuth 授权需在目标机器重新登录。"
        : "将选中的范围保存为 JSON 文件。"}>
        <Button variant="secondary" disabled={!!busy || scopes.length === 0} onClick={() => void run("export")}>
          {busy === "export" ? "正在导出…" : "导出配置"}
        </Button>
      </SettingsRow>
      <SettingsRow title="导入配置" description="读取文件包含的全部范围；导入前检测冲突，可选择覆盖、跳过冲突或取消。">
        <Button variant="secondary" disabled={!!busy} onClick={() => void run("import")}>
          {busy === "import" ? "正在导入…" : "导入配置"}
        </Button>
      </SettingsRow>
      {message && <div className="settings-form-grid" role="status" aria-live="polite">
        <p className="settings-row-desc">{message}</p>
        {warnings.length > 0 && <ul className="settings-row-desc">{warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
      </div>}
    </SettingsCard>
  );
}
