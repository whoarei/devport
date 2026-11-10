import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage, type DeviceProfile } from "../api";
import { saveTemporaryDevice } from "../deviceActions";

export function SaveTemporaryDevice({ device }: { device: DeviceProfile }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <span className="temporary-device-notice">
    <span>{t("quickSsh.temporary")}</span>
    <button disabled={busy} onClick={() => {
      setBusy(true); setError(null);
      void saveTemporaryDevice(device.id).catch((error) => setError(errorMessage(error))).finally(() => setBusy(false));
    }}>{t(busy ? "quickSsh.saving" : "quickSsh.save")}</button>
    {error && <span role="alert" className="runtime-error">{error}</span>}
  </span>;
}
