import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage, type AuthMethod, type HostKeyChange } from "../api";
import { activateQuickSsh, closeQuickSsh, connectQuickSsh, useQuickSshStore } from "../quickSsh";
import { useAppStore } from "../store";
import { SshHostKeyDialog, type HostKeyPrompt } from "./SshHostKeyDialog";
import "./QuickSshDialog.css";

type AuthChoice = "key" | "customKey" | "password";

export function QuickSshDialog() {
  const initialAddress = useQuickSshStore((state) => state.initialAddress);
  return initialAddress === null ? null : <QuickSshForm initialAddress={initialAddress} />;
}

function QuickSshForm({ initialAddress }: { initialAddress: string }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const addressInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const response = useRef<((confirmed: boolean) => void) | null>(null);
  const locked = useRef(false);
  const [address, setAddress] = useState(initialAddress);
  const [method, setMethod] = useState<AuthChoice>("key");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const recent = useQuickSshStore((state) => state.recentAddresses);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<HostKeyPrompt | null>(null);
  const updating = useAppStore((state) => state.updating);
  const canConnect = !!address.trim() && (method !== "customKey" || !!keyPath.trim()) && !updating;
  useEffect(() => {
    dialog.current?.showModal();
    addressInput.current?.focus();
    return () => { response.current?.(false); };
  }, []);
  const close = () => { if (!locked.current) closeQuickSsh(); };
  const confirm = (change: HostKeyChange) => new Promise<boolean>((resolve) => {
    const respond = (value: boolean) => { response.current = null; setPrompt(null); resolve(value); };
    response.current = respond;
    setPrompt({ change, respond });
  });
  const connect = async () => {
    if (locked.current || !canConnect) return;
    locked.current = true; setBusy(true); setError(null);
    try {
      const auth: AuthMethod = method === "password" ? { type: "password", password }
        : { type: "key", key_path: method === "customKey" ? keyPath.trim() : null };
      const device = await connectQuickSsh(address, auth, confirm);
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
        <h2 id="quick-ssh-title">{t("quickSsh.title")}</h2>
        <fieldset disabled={busy || updating}>
          <label>{t("quickSsh.address")}<input ref={addressInput} value={address} onChange={(event) => setAddress(event.target.value)}
            list="quick-ssh-recent" placeholder="root@host:22" autoComplete="off" spellCheck={false} required /></label>
          <datalist id="quick-ssh-recent">{recent.map((item) => <option key={item} value={item} />)}</datalist>
          <label>{t("device.auth")}<select value={method} onChange={(event) => setMethod(event.target.value as AuthChoice)}>
            <option value="key">{t("quickSsh.key")}</option>
            <option value="customKey">{t("quickSsh.customKey")}</option>
            <option value="password">{t("device.password")}</option>
          </select></label>
          {method === "password" && <label>{t("device.password")}<input ref={passwordInput} type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} /></label>}
          {method === "customKey" && <label>{t("quickSsh.keyPath")}<input value={keyPath} onChange={(event) => setKeyPath(event.target.value)} required /></label>}
        </fieldset>
        <details className="quick-ssh-help">
          <summary>{t("quickSsh.help")}</summary>
          <p>{t("quickSsh.addressHint")}</p>
          <p>{t("quickSsh.privacy")}</p>
        </details>
        {error && <p role="alert" className="runtime-error">{error}</p>}
        <div className="dialog-actions"><button type="button" disabled={busy} onClick={close}>{t("dialog.cancel")}</button>
          <button className="primary" type="submit" disabled={busy || !canConnect}>{t(busy ? "quickSsh.connecting" : "quickSsh.connect")}</button></div>
      </form>
    </dialog>
    <SshHostKeyDialog request={prompt} />
  </>;
}
