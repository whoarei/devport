import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { APP_SHORTCUTS, isMacPlatform, shortcutLabel, shortcutScopeKey, type AppCommandId } from "../shortcuts";
import { useCommandUiStore } from "../commandUiStore";

export function ShortcutsDialog() {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const open = useCommandUiStore(state => state.shortcutsOpen);
  const close = () => useCommandUiStore.setState({ shortcutsOpen: false });
  const mod = isMacPlatform() ? "⌘" : "Ctrl";
  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) {
      dialog.current.showModal();
      heading.current?.focus();
      dialog.current.scrollTop = 0;
    }
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  return <dialog ref={dialog} className="shortcuts-dialog" aria-labelledby="shortcuts-title"
    onCancel={event => { event.preventDefault(); close(); }} onClose={close}>
    <h2 id="shortcuts-title" ref={heading} tabIndex={-1}>{t("shortcuts.title")}</h2>
    <p className="secondary-text">{t("shortcuts.hint")}</p>
    <table><thead><tr><th>{t("shortcuts.action")}</th><th>{t("shortcuts.keys")}</th><th>{t("shortcuts.scope")}</th></tr></thead>
      <tbody>{(Object.keys(APP_SHORTCUTS) as AppCommandId[]).map(id => <tr key={id}>
        <td>{t(`shortcuts.${id}`)}</td><td><kbd>{shortcutLabel(id)}</kbd></td><td>{t(shortcutScopeKey(id))}</td>
      </tr>)}
        <tr><td>{t("shortcuts.cycleTabs")}</td><td><kbd>Ctrl+Tab / Ctrl+Shift+Tab</kbd></td><td>{t("shortcuts.scope_tabs")}</td></tr>
        <tr><td>{t("shortcuts.zoom")}</td><td><kbd>{mod}++ / {mod}+- / {mod}+0</kbd></td><td>{t("shortcuts.scope_navigation")}</td></tr>
        <tr><td>{t("shortcuts.find")}</td><td><kbd>{mod}+F</kbd></td><td>{t("shortcuts.scope_editor")}</td></tr>
        <tr><td>{t("shortcuts.clipboard")}</td><td><kbd>Ctrl+Shift+C / Ctrl+Shift+V</kbd></td><td>{t("shortcuts.scope_terminal")}</td></tr>
      </tbody></table>
    <p className="secondary-text">{t("shortcuts.terminalHint")}</p>
    <div className="dialog-actions"><button type="button" onClick={close}>{t("workspaceRun.close")}</button></div>
  </dialog>;
}
