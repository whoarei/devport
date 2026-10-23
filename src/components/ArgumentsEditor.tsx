import { useId } from "react";
import { useTranslation } from "react-i18next";

export function ArgumentsEditor({ value, onChange, preview, disabled = false, autoFocus = false }: {
  value: string;
  onChange: (value: string) => void;
  preview: string[];
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation(), helpId = useId();
  return <>
    <label>{t("workspaceRun.arguments")}
      <textarea className="runner-arguments" rows={6} value={value} onChange={e => onChange(e.target.value)}
        disabled={disabled} autoFocus={autoFocus} spellCheck={false} autoCapitalize="off" autoCorrect="off"
        aria-describedby={helpId} placeholder={t("workspaceRun.argsPlaceholder")} />
    </label>
    <p id={helpId} className="secondary-text">{t("workspaceRun.argsHelp")}</p>
    <details className="runner-args-preview">
      <summary>{t("workspaceRun.argsPreview")}</summary>
      <pre className="runner-preview">{JSON.stringify(preview, null, 2)}</pre>
    </details>
  </>;
}
