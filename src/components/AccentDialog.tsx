import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ACCENT_PRESETS, accentSwatch, isAccentPreset, parseCustomAccent } from "../accentPalette";
import { useThemeStore } from "../theme";
import { Icon } from "./Icon";
import "./AccentDialog.css";

const presets = Object.keys(ACCENT_PRESETS).filter(isAccentPreset);

export function AccentDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const theme = useThemeStore(state => state.theme);
  const accent = useThemeStore(state => state.accent);
  const setAccent = useThemeStore(state => state.setAccent);
  const [draft, setDraft] = useState(() => isAccentPreset(accent) ? "" : accent);
  const custom = parseCustomAccent(draft);
  const invalid = draft.trim() !== "" && !custom;
  const selectedSwatch = accentSwatch(theme, accent);

  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal();
  }, []);

  return <dialog className="accent-dialog" ref={dialog} aria-labelledby="accent-title" onClose={onClose}>
    <h2 id="accent-title">{t("accent.title")}</h2>
    <fieldset className="accent-presets" aria-label={t("accent.presets")}>
      {presets.map(preset => (
        <label className="accent-option" key={preset}>
          <input type="radio" name="devport-accent" value={preset} checked={accent === preset} onChange={() => setAccent(preset)} />
          <span>
            <span className="accent-swatch" style={{ backgroundColor: accentSwatch(theme, preset) }} />
            {t(`accent.${preset}`)}
            {accent === preset && <Icon name="check" className="accent-check" />}
          </span>
        </label>
      ))}
    </fieldset>
    <form onSubmit={event => {
      event.preventDefault();
      if (custom) {
        setAccent(custom);
        setDraft(custom);
      }
    }}>
      <label className="accent-custom-label" htmlFor="accent-hex">{t("accent.custom")}</label>
      <div className="accent-custom">
        <input type="color" aria-label={t("accent.pick")} value={custom ?? selectedSwatch}
          onChange={event => setDraft(event.target.value)} />
        <input type="text" id="accent-hex" value={draft} spellCheck={false} autoComplete="off" placeholder={selectedSwatch.toUpperCase()}
          aria-invalid={invalid || undefined} aria-describedby={invalid ? "accent-invalid" : undefined}
          onChange={event => setDraft(event.target.value)} />
        <button type="submit" className="primary" disabled={!custom || accent === custom}>{t("accent.apply")}</button>
      </div>
      {invalid && <p id="accent-invalid" role="status">{t("accent.invalid")}</p>}
    </form>
    <div className="dialog-actions">
      <button type="button" onClick={() => dialog.current?.close()}>{t("accent.done")}</button>
    </div>
  </dialog>;
}
