import { useTranslation } from "react-i18next";
import { configSyncErrorKind } from "../../features/settings/config-sync-error";
import { IconTriangleAlert } from "../icons";

export function ConfigSyncError({ message }: { message: string }) {
  const { t } = useTranslation();
  return (
    <div className="settings-config-sync-alert" role="alert">
      <IconTriangleAlert
        aria-hidden
        className="settings-config-sync-alert-icon"
        size={16}
      />
      <div className="settings-config-sync-alert-copy">
        <p className="settings-config-sync-alert-title">
          {t("settings.configSync.errorTitle")}
        </p>
        <p className="settings-config-sync-alert-text">
          {t(`settings.configSync.errors.${configSyncErrorKind(message)}`)}
        </p>
        <details className="settings-config-sync-alert-details">
          <summary>{t("settings.configSync.errorDetails")}</summary>
          <pre>{message}</pre>
        </details>
      </div>
    </div>
  );
}
