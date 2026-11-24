import { useState } from "react";
import { useTranslation } from "react-i18next";
import { errorMessage, type DeviceProfile } from "../api";
import { saveTemporaryDevice } from "../deviceActions";
import { Icon } from "./Icon";

export function SaveTemporaryDevice({ device, onSaveErrorChange }: {
  device: DeviceProfile;
  onSaveErrorChange?: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reportError = onSaveErrorChange ?? setError;
  const label = t(busy ? "quickSsh.saving" : "quickSsh.save");
  return <span className="temporary-device-notice">
    <span className="temporary-device-label">{t("quickSsh.temporary")}</span>
    <button type="button" disabled={busy} aria-label={label} title={label} onClick={() => {
      setBusy(true);
      reportError(null);
      void saveTemporaryDevice(device.id).catch((error) => reportError(errorMessage(error))).finally(() => setBusy(false));
    }}><Icon name="save" /><span>{label}</span></button>
    {error && <span role="alert" className="runtime-error">{error}</span>}
  </span>;
}
