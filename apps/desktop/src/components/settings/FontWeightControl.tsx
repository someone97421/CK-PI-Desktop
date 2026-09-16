import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FontMetadata } from "@pi-desktop/shared";
import { loadFontMetadata, supportsFontWeight, weightFaces } from "../../lib/fonts";
import { IconCheck, IconChevronDown } from "../icons";
import { AnchoredMenu } from "./AnchoredMenu";

export function FontWeightControl({ family, value, label, onChange }: {
  family: string;
  value: number | undefined;
  label: string;
  onChange: (weight: number | undefined) => Promise<void>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [loaded, setLoaded] = useState<{ family: string; metadata: FontMetadata }>();
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  const refreshMetadata = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false;
    let request = 0;
    const refresh = () => {
      const current = ++request;
      // The shared loader owns TTL and inflight deduplication, including failures.
      void loadFontMetadata(family).then((metadata) => {
        if (!cancelled && current === request) setLoaded({ family, metadata });
      });
    };
    refreshMetadata.current = refresh;
    refresh();
    return () => { cancelled = true; refreshMetadata.current = () => {}; };
  }, [family]);
  useEffect(() => { setDraft(value === undefined ? "" : String(value)); }, [value, family]);
  const metadata = loaded?.family === family ? loaded.metadata : undefined;
  const faces = metadata ? weightFaces(metadata) : [];
  const generic = Boolean(metadata && (metadata.status !== "known" || !faces.length));
  const validWeight = (weight: number) => Number.isFinite(weight) && weight >= 1 && weight <= 1000 &&
    (generic || supportsFontWeight(faces, weight));
  const unsupported = metadata && !generic && value !== undefined && !validWeight(value);
  const choices = new Map<number, string>();
  for (const face of faces) {
    if (face.wght) {
      const { min, max, default: normal } = face.wght;
      for (const weight of [min, max, normal, ...Array.from({ length: 10 }, (_, i) => (i + 1) * 100)]) {
        if (weight >= min && weight <= max) choices.set(weight, t("settings.appearanceVariableValue", { weight }));
      }
    } else if (!choices.has(face.weight)) {
      choices.set(face.weight, face.variable ? t("settings.appearanceVariableFixed", { name: face.name, weight: face.weight }) : `${face.name} (${face.weight})`);
    }
  }
  if (generic) {
    for (const weight of [100, 200, 300, 400, 500, 600, 700, 800, 900]) choices.set(weight, t("settings.appearanceCssWeight", { weight }));
  }
  if (value !== undefined && !choices.has(value)) {
    choices.set(value, unsupported ? t("settings.appearanceUnsupportedValue", { weight: value })
      : generic ? t("settings.appearanceCssWeight", { weight: value })
        : metadata ? t("settings.appearanceVariableValue", { weight: value }) : String(value));
  }
  const defaultLabel = t("settings.appearanceDefaultWeight");
  const isDefault = draft.trim() === "" || draft === defaultLabel;
  const draftInvalid = Boolean(metadata && !isDefault && !validWeight(Number(draft)));
  const commit = () => {
    if (!metadata || draftInvalid) return;
    const next = isDefault ? undefined : Number(draft);
    if (next !== value) void onChange(next).catch(() => setDraft(value === undefined ? "" : String(value)));
  };
  const options = [
    { weight: undefined, text: defaultLabel },
    ...[...choices.keys()].sort((a, b) => a - b).filter(validWeight)
      .map((weight) => ({ weight, text: String(weight) })),
  ];
  const choose = (weight: number | undefined) => {
    setDraft(weight === undefined ? "" : String(weight));
    setOpen(false);
    inputRef.current?.focus();
    if (weight !== value) void onChange(weight).catch(() => setDraft(value === undefined ? "" : String(value)));
  };
  return <div className="appearance-weight-control" aria-busy={!metadata}
    onFocusCapture={() => refreshMetadata.current()} onPointerDownCapture={() => refreshMetadata.current()}>
    <AnchoredMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef}
      menuClassName="settings-font-menu appearance-weight-menu" label={label}
      matchAnchorWidth restoreFocus={false}
      onMenuKeyDown={(event) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}
      trigger={(ref) => <div ref={anchorRef} className="settings-font-trigger appearance-weight-trigger"
        data-invalid={draftInvalid || undefined}>
        <input ref={inputRef} type="text" inputMode="decimal" autoComplete="off"
          className="appearance-weight" aria-label={label} aria-invalid={draftInvalid}
          title={draftInvalid ? t("settings.appearanceWeightInvalid") : label}
          disabled={!metadata} value={draft} placeholder={defaultLabel}
          onChange={(event) => { setDraft(event.target.value); setOpen(false); }}
          onBlur={(event) => {
            if (!open && !anchorRef.current?.contains(event.relatedTarget)) commit();
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault(); setOpen(true);
            }
            if (event.key === "Enter") { event.preventDefault(); commit(); setOpen(false); }
            if (event.key === "Escape") { setDraft(value === undefined ? "" : String(value)); setOpen(false); }
          }} />
        <button ref={ref} type="button" className="appearance-weight-toggle"
          disabled={!metadata} aria-label={label} aria-haspopup="listbox" aria-expanded={open}
          aria-controls={open ? `${id}-choices` : undefined}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setOpen((current) => !current)}>
          <IconChevronDown size={14} aria-hidden />
        </button>
      </div>}>
      <div id={`${id}-choices`} className="settings-font-list">
        {options.map(({ weight, text }) => <button key={weight ?? "default"} type="button"
          role="option" aria-selected={weight === value}
          className={`settings-font-item${weight === value ? " active" : ""}`}
          onClick={() => choose(weight)}>
          <span className="settings-font-item-label">{text}</span>
          {weight === value && <IconCheck size={14} className="settings-font-check" />}
        </button>)}
      </div>
    </AnchoredMenu>
  </div>;
}
