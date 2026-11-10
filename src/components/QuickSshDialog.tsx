import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage, type HostKeyChange } from "../api";
import { activateQuickSsh, connectQuickSsh, recentSshAddresses, useQuickSshStore } from "../quickSsh";
import { useAppStore } from "../store";
import { SshHostKeyDialog, type HostKeyPrompt } from "./SshHostKeyDialog";
import "./QuickSshDialog.css";

export function QuickSshDialog() {
  const open = useQuickSshStore((state) => state.open);
  return open ? <QuickSshForm /> : null;
}

function QuickSshForm() {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const response = useRef<((confirmed: boolean) => void) | null>(null);
  const locked = useRef(false);
  const [address, setAddress] = useState("");
  const [method, setMethod] = useState<"key" | "password">("key");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [recent] = useState(recentSshAddresses);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<HostKeyPrompt | null>(null);
  const updating = useAppStore((state) => state.updating);
  useEffect(() => {
    dialog.current?.showModal();
    addressInput.current?.focus();
    return () => { response.current?.(false); };
  }, []);
  const close = () => { if (!locked.current) useQuickSshStore.setState({ open: false }); };
  const confirm = (change: HostKeyChange) => new Promise<boolean>((resolve) => {
    const respond = (value: boolean) => { response.current = null; setPrompt(null); resolve(value); };
    response.current = respond;
    setPrompt({ change, respond });
  });
  const connect = async () => {
    if (locked.current || !address.trim() || updating) return;
    locked.current = true; setBusy(true); setError(null);
    try {
      const device = await connectQuickSsh(address, method === "password" ? { type: "password", password } : { type: "key", key_path: keyPath.trim() || null }, confirm);
      if (device) { setPassword(""); activateQuickSsh(device); }
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ssh_auth_failed") {
        setMethod("password"); setError(t("quickSsh.authFailed"));
        setTimeout(() => passwordInput.current?.focus(), 0);
      } else setError(errorMessage(error));
    } finally { locked.current = false; setBusy(false); }
  };
  return <>
    <dialog ref={dialog} className="quick-ssh-dialog" aria-labelledby="quick-ssh-title"
      onCancel={(event) => { event.preventDefault(); close(); }}>
      <form onSubmit={(event) => { event.preventDefault(); void connect(); }}>
        <h3 id="quick-ssh-title">{t("quickSsh.title")}</h3>
        <p className="secondary-text">{t("quickSsh.description")}</p>
        <fieldset disabled={busy || updating}>
          <label>{t("quickSsh.address")}<input ref={addressInput} value={address} onChange={(event) => setAddress(event.target.value)}
            list="quick-ssh-recent" placeholder="root@192.168.1.20:22" autoComplete="off" spellCheck={false} required /></label>
          <datalist id="quick-ssh-recent">{recent.map((item) => <option key={item} value={item} />)}</datalist>
          <small className="secondary-text">{t("quickSsh.addressHint")}</small>
          <label>{t("device.auth")}<select value={method} onChange={(event) => setMethod(event.target.value as "key" | "password")}>
            <option value="key">{t("quickSsh.key")}</option><option value="password">{t("device.password")}</option>
          </select></label>
          {method === "password" ? <label>{t("device.password")}<input ref={passwordInput} type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
            : <details><summary>{t("quickSsh.customKey")}</summary><label>{t("quickSsh.keyPath")}<input value={keyPath} onChange={(event) => setKeyPath(event.target.value)} placeholder={t("quickSsh.keyPathHint")} /></label></details>}
        </fieldset>
        <p className="secondary-text">{t("quickSsh.privacy")}</p>
        {error && <p role="alert" className="runtime-error">{error}</p>}
        <div className="dialog-actions"><button type="button" disabled={busy} onClick={close}>{t("dialog.cancel")}</button>
          <button className="primary" type="submit" disabled={busy || updating || !address.trim()}>{t(busy ? "quickSsh.connecting" : "quickSsh.connect")}</button></div>
      </form>
    </dialog>
    <SshHostKeyDialog request={prompt} />
  </>;
}
