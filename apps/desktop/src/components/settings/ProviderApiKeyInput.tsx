import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { IconEye, IconEyeOff } from "../icons";
import { Input } from "../ui";

export function ProviderApiKeyInput({
  inputRef,
  savedKeyProviderId,
  value,
  onChange,
  disabled,
  autoFocus,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  savedKeyProviderId?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [savedKey, setSavedKey] = useState<string>();
  const editedRef = useRef(false);
  const activeRef = useRef(false);
  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

  const toggle = async () => {
    if (disabled || loading) return;
    if (revealed) {
      setRevealed(false);
      return;
    }
    if (savedKeyProviderId && !value && !editedRef.current && savedKey === undefined) {
      setLoading(true);
      try {
        const result = await api.getProviderSecret(savedKeyProviderId);
        if (!activeRef.current) return;
        if (!editedRef.current) setSavedKey(result.value ?? "");
        setRevealed(true);
      } catch (error) {
        if (activeRef.current) {
          showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
        }
      } finally {
        if (activeRef.current) setLoading(false);
      }
      return;
    }
    setRevealed(true);
  };

  const label = t(revealed ? "settings.hideApiKey" : "settings.showApiKey");
  return (
    <span className="password-input">
      <Input
        ref={inputRef}
        type={revealed ? "text" : "password"}
        value={value || (editedRef.current ? "" : savedKey ?? "")}
        placeholder={savedKeyProviderId && !editedRef.current && savedKey === undefined ? "••••••••" : "sk-…"}
        className="font-mono text-sm-plus"
        autoComplete="off"
        autoFocus={autoFocus}
        disabled={disabled}
        onChange={(event) => {
          editedRef.current = true;
          setSavedKey(undefined);
          onChange(event.target.value);
        }}
      />
      <button
        type="button"
        className="password-input-toggle"
        aria-label={label}
        title={label}
        aria-pressed={revealed}
        aria-busy={loading}
        disabled={disabled || loading}
        onClick={() => void toggle()}
      >
        {revealed ? <IconEyeOff /> : <IconEye />}
      </button>
    </span>
  );
}
