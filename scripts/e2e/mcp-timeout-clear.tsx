import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import {
  draftFromRecord,
  draftToInput,
  McpEditorSheet,
} from "../../apps/desktop/src/components/extensions/McpEditorSheet";

const record = {
  id: "slow-server",
  label: "Slow server",
  transport: "stdio" as const,
  command: "npx",
  enabled: true,
  timeoutSeconds: 45,
};

const i18n = createInstance();

function Harness() {
  const [draft, setDraft] = useState(() => draftFromRecord(record));
  const save = () => {
    window.__mcpTimeoutSaved = draftToInput(draft).timeoutSeconds;
  };

  return (
    <I18nextProvider i18n={i18n}>
      <McpEditorSheet
        draft={draft}
        setDraft={setDraft}
        editing={record}
        saving={false}
        testing={false}
        projects={[]}
        onClose={() => {}}
        onSave={save}
        onTest={() => {}}
      />
    </I18nextProvider>
  );
}

declare global {
  interface Window {
    __mcpTimeoutSaved?: number | null;
    mcpTimeoutClearProbe: () => Promise<{
      originalValue: string;
      invalidValueBlocked: boolean;
      clearedValueEnabled: boolean;
      savedTimeoutSeconds: number | null | undefined;
    }>;
  }
}

void i18n
  .use(initReactI18next)
  .init({
    lng: "en",
    fallbackLng: "en",
    keySeparator: false,
    resources: { en: { translation: flattenCatalog(catalogs.en) } },
    interpolation: { escapeValue: false },
  })
  .then(() => {
    const root = createRoot(document.getElementById("root")!);
    flushSync(() => root.render(<Harness />));

    window.mcpTimeoutClearProbe = async () => {
      const input = document.querySelector<HTMLInputElement>(
        'input[type="number"]',
      );
      if (!input) throw new Error("MCP timeout input was not rendered");
      const originalValue = input.value;
      const save = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Save",
      );
      if (!save) throw new Error("MCP save button was not rendered");

      const setInputValue = (value: string) => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        if (!setter) throw new Error("HTML input value setter is unavailable");
        flushSync(() => {
          setter.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        });
      };

      setInputValue("601");
      const invalidValueBlocked = save.disabled;

      setInputValue("");
      const clearedValueEnabled = !save.disabled;
      if (clearedValueEnabled) {
        flushSync(() => save.click());
      }

      return {
        originalValue,
        invalidValueBlocked,
        clearedValueEnabled,
        savedTimeoutSeconds: window.__mcpTimeoutSaved,
      };
    };
  })
  .catch((error: unknown) => {
    console.error(error);
    throw error;
  });
