import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import { CONFIG_SCOPES, CONFIG_SCOPE_LABELS, type ConfigScope } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { flushSettingsWrites } from "../../lib/settings-save";
import { refreshAppearanceMedia } from "../../lib/appearance-media";
import { useAppStore } from "../../stores/app-store";
import { Button, cx } from "../ui";
import { IconCheck, IconChevronDown } from "../icons";
import { AnchoredMenu } from "./AnchoredMenu";
import { SettingsCard, SettingsRow } from "../../features/settings/primitives";

const DEFAULT_EXPORT_SCOPES: ConfigScope[] = ["general", "instructions", "models", "ai", "subagents"];

export function ConfigTransferSection() {
  const [scopes, setScopes] = useState<ConfigScope[]>(DEFAULT_EXPORT_SCOPES);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const scopeTriggerRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [message, setMessage] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const closeScopeMenu = useCallback(() => {
    setScopeMenuOpen(false);
    scopeTriggerRef.current?.focus({ preventScroll: true });
  }, []);
  const onScopeMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      closeScopeMenu();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]'));
    const index = items.findIndex((item) => item === event.target);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  const run = async (action: "export" | "import") => {
    if (busy) return;
    setScopeMenuOpen(false);
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
          await refreshAppearanceMedia();
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
      <SettingsRow title="导出范围">
        <AnchoredMenu
          open={scopeMenuOpen}
          onClose={closeScopeMenu}
          anchorRef={scopeTriggerRef}
          restoreFocus={false}
          role="menu"
          label="导出范围"
          align="end"
          menuClassName="settings-menu-select-menu"
          onMenuKeyDown={onScopeMenuKeyDown}
          trigger={() => (
            <button
              ref={scopeTriggerRef}
              type="button"
              className="settings-menu-select-trigger"
              aria-haspopup="menu"
              aria-expanded={scopeMenuOpen}
              aria-label={`导出范围，已选 ${scopes.length} 项`}
              disabled={!!busy}
              onClick={() => setScopeMenuOpen((open) => !open)}
              title="备份选中的应用配置。全局指令和自定义子智能体包含正文；插件、技能、MCP 和 OAuth 授权需另行迁移。"
            >
              <span className="settings-menu-select-trigger-label">已选 {scopes.length} 项</span>
              <IconChevronDown size={14} aria-hidden />
            </button>
          )}
        >
          <div className="settings-menu-select-results">
            {CONFIG_SCOPES.map((scope) => {
              const checked = scopes.includes(scope);
              return (
                <button
                  key={scope}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  tabIndex={-1}
                  className={cx("settings-menu-select-option", checked && "is-current")}
                  onClick={() => setScopes((current) => current.includes(scope)
                    ? current.filter((item) => item !== scope)
                    : [...current, scope])}
                >
                  <span className="settings-menu-select-option-label">{CONFIG_SCOPE_LABELS[scope]}</span>
                  {checked && <IconCheck className="settings-menu-select-check" size={14} aria-hidden />}
                </button>
              );
            })}
          </div>
        </AnchoredMenu>
      </SettingsRow>
      <SettingsRow title="导出配置">
        <Button variant="secondary" disabled={!!busy || scopes.length === 0} onClick={() => void run("export")}
          title="导出文件可能包含模型密钥、代理认证及语音附加参数，请妥善保管。OAuth 授权需重新登录。">
          {busy === "export" ? "正在导出…" : "导出配置"}
        </Button>
      </SettingsRow>
      <SettingsRow title="导入配置">
        <Button variant="secondary" disabled={!!busy} onClick={() => void run("import")}
          title="选择完整覆盖、合并更新或仅添加新项。完整覆盖只还原文件包含的类别，并列出将移除的条目。">
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
