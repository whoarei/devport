//! Windows host USB ownership management, independent of workload execution.
pub mod remote;
#[cfg(windows)]
mod windows;

use serde::{Deserialize, Serialize};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
};

const OUTPUT_LIMIT: usize = 1024 * 1024;
static OPERATIONS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Serialize)]
pub struct UsbError {
    pub code: &'static str,
    pub message: String,
}
pub type Result<T> = std::result::Result<T, UsbError>;
fn error(code: &'static str, message: impl ToString) -> UsbError {
    UsbError {
        code,
        message: message.to_string(),
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all(deserialize = "PascalCase"))]
pub struct UsbDevice {
    pub instance_id: String,
    pub description: String,
    pub bus_id: Option<String>,
    pub persisted_guid: Option<String>,
    #[serde(rename(deserialize = "ClientIPAddress"))]
    pub client_ip_address: Option<String>,
    #[serde(default)]
    pub is_forced: bool,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct State {
    devices: Vec<UsbDevice>,
}

#[derive(Debug, Serialize)]
pub struct Distribution {
    pub name: String,
    pub version: u32,
}
#[derive(Debug, Serialize)]
pub struct Snapshot {
    pub supported: bool,
    pub executable: Option<String>,
    pub version: Option<String>,
    pub problem: Option<UsbError>,
    pub wsl_problem: Option<UsbError>,
    pub distributions: Vec<Distribution>,
    pub devices: Vec<UsbDevice>,
}

/// A fresh BUSID is not an identity: it may be reused after a device is unplugged.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceSelector {
    pub instance_id: String,
    pub bus_id: Option<String>,
    pub persisted_guid: Option<String>,
}
impl DeviceSelector {
    fn validate(&self) -> Result<()> {
        if self.instance_id.is_empty()
            || self.instance_id.len() > 1024
            || self.instance_id.chars().any(char::is_control)
        {
            return Err(error("invalid_input", "invalid USB instance ID"));
        }
        if let Some(bus) = &self.bus_id {
            validate_bus(bus)?;
        }
        if let Some(guid) = &self.persisted_guid {
            let parsed = uuid::Uuid::parse_str(guid)
                .map_err(|_| error("invalid_input", "invalid persisted GUID"))?;
            if parsed.hyphenated().to_string() != guid.to_ascii_lowercase() {
                return Err(error(
                    "invalid_input",
                    "GUID must use canonical hyphenated form",
                ));
            }
        }
        Ok(())
    }
}

fn validate_bus(bus: &str) -> Result<()> {
    let parts: Vec<_> = bus.split('-').collect();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || part.len() > 5
                || !part.bytes().all(|b| b.is_ascii_digit())
                || part.parse::<u16>().ok().filter(|n| *n > 0).is_none()
        })
    {
        return Err(error("invalid_input", "invalid USB BUSID"));
    }
    Ok(())
}

fn select(devices: Vec<UsbDevice>, selector: &DeviceSelector) -> Result<UsbDevice> {
    selector.validate()?;
    let device = devices
        .into_iter()
        .find(|d| d.instance_id == selector.instance_id)
        .ok_or_else(|| error("device_changed", "USB device is no longer present"))?;
    if device.bus_id != selector.bus_id || device.persisted_guid != selector.persisted_guid {
        return Err(error(
            "device_changed",
            "USB identity or sharing state changed; refresh and retry",
        ));
    }
    Ok(device)
}

async fn read_bounded(mut stream: impl AsyncRead + Unpin) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    (&mut stream)
        .take((OUTPUT_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| error("command_failed", e))?;
    if bytes.len() > OUTPUT_LIMIT {
        return Err(error("output_limit", "USB command output exceeded 1 MiB"));
    }
    Ok(bytes)
}

async fn capture(command: Command, input: Option<Vec<u8>>) -> Result<Vec<u8>> {
    capture_with_timeout(command, input, Duration::from_secs(30)).await
}

async fn capture_with_timeout(
    mut command: Command,
    input: Option<Vec<u8>>,
    timeout: Duration,
) -> Result<Vec<u8>> {
    command
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|e| error("command_failed", e))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let work = async {
        let write = async {
            if let Some(bytes) = input {
                stdin
                    .write_all(&bytes)
                    .await
                    .map_err(|e| error("command_failed", e))?;
            }
            drop(stdin);
            Ok(())
        };
        let wait = async { child.wait().await.map_err(|e| error("command_failed", e)) };
        let (out, err, status, ()) =
            tokio::try_join!(read_bounded(stdout), read_bounded(stderr), wait, write)?;
        if !status.success() {
            return Err(error(
                "command_failed",
                format!(
                    "{} {}",
                    crate::wsl::decode_wsl_text(&out),
                    crate::wsl::decode_wsl_text(&err)
                )
                .trim(),
            ));
        }
        Ok(out)
    };
    tokio::time::timeout(timeout, work)
        .await
        .map_err(|_| error("timeout", "USB command timed out"))?
}

fn executable() -> Result<PathBuf> {
    #[cfg(windows)]
    {
        windows::executable()
    }
    #[cfg(not(windows))]
    {
        Err(error(
            "unsupported",
            "USB forwarding is supported on Windows only",
        ))
    }
}
async fn usb_command(args: &[&str]) -> Result<Vec<u8>> {
    let mut command = Command::new(executable()?);
    command.args(args);
    capture(command, None).await
}
fn parse_state(bytes: &[u8]) -> Result<Vec<UsbDevice>> {
    serde_json::from_slice::<State>(bytes)
        .map(|state| state.devices)
        .map_err(|e| error("invalid_state", e))
}
async fn devices() -> Result<Vec<UsbDevice>> {
    parse_state(&usb_command(&["state"]).await?)
}

async fn ready() -> Result<String> {
    let version = String::from_utf8_lossy(&usb_command(&["--version"]).await?)
        .trim()
        .to_owned();
    let parsed =
        semver::Version::parse(&version).map_err(|_| error("unsupported_version", &version))?;
    if parsed.major != 5 {
        return Err(error("unsupported_version", &version));
    }
    #[cfg(windows)]
    windows::service_ready()?;
    Ok(version)
}

pub async fn snapshot() -> Snapshot {
    let mut snapshot = Snapshot {
        supported: cfg!(windows),
        executable: None,
        version: None,
        problem: None,
        wsl_problem: None,
        distributions: Vec::new(),
        devices: Vec::new(),
    };
    match executable() {
        Ok(path) => snapshot.executable = Some(path.to_string_lossy().into_owned()),
        Err(e) => {
            snapshot.problem = Some(e);
            return snapshot;
        }
    }
    match ready().await {
        Ok(version) => snapshot.version = Some(version),
        Err(e) => snapshot.problem = Some(e),
    }
    #[cfg(windows)]
    match windows::distributions() {
        Ok(list) => snapshot.distributions = list,
        Err(e) => snapshot.wsl_problem = Some(e),
    }
    if snapshot.problem.is_none() {
        match devices().await {
            Ok(list) => snapshot.devices = list,
            Err(e) => snapshot.problem = Some(e),
        }
    }
    snapshot
}

fn validate_config(config: &crate::device::WslConfig) -> Result<()> {
    config.validate().map_err(|e| error("invalid_input", e))?;
    #[cfg(windows)]
    {
        if !windows::distributions()?
            .iter()
            .any(|d| d.name == config.distribution && d.version == 2)
        {
            return Err(error(
                "wsl2_required",
                "select an installed WSL2 distribution",
            ));
        }
    }
    #[cfg(not(windows))]
    return Err(error(
        "unsupported",
        "USB forwarding is supported on Windows only",
    ));
    #[cfg(windows)]
    Ok(())
}

fn wsl(config: &crate::device::WslConfig) -> Result<Command> {
    let mut command = crate::wsl::wsl_command().map_err(|e| error("wsl_failed", e))?;
    command.arg("--distribution").arg(&config.distribution);
    if !config.user.is_empty() {
        command.arg("--user").arg(&config.user);
    }
    Ok(command)
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum PrivilegedAction {
    Bind,
    Unbind,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PrivilegedRequest {
    action: PrivilegedAction,
    selector: DeviceSelector,
}

async fn elevate(action: PrivilegedAction, selector: DeviceSelector) -> Result<()> {
    #[cfg(windows)]
    {
        use base64::Engine;
        let path = std::env::current_exe().map_err(|e| error("command_failed", e))?;
        let payload = base64::engine::general_purpose::STANDARD.encode(
            serde_json::to_vec(&PrivilegedRequest { action, selector })
                .map_err(|e| error("invalid_input", e))?,
        );
        tokio::task::spawn_blocking(move || windows::elevate(&path, &payload))
            .await
            .map_err(|e| error("command_failed", e))?
    }
    #[cfg(not(windows))]
    {
        let _ = (action, selector);
        Err(error(
            "unsupported",
            "USB forwarding is supported on Windows only",
        ))
    }
}

/// Narrow privileged entry point runs BEFORE Tauri/single-instance initialization.
/// The child rechecks identity AFTER the user accepts UAC; BUSID may have changed
/// while the prompt was open. No shell, arbitrary executable, or force mode.
pub fn elevated_entry(args: &[String]) -> Option<i32> {
    if args.get(1).map(String::as_str) != Some("--usb-elevated") {
        return None;
    }
    let run = || -> Result<()> {
        use base64::Engine;
        if args.len() != 3 || args[2].len() > 8192 {
            return Err(error("invalid_input", "invalid elevated USB request"));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&args[2])
            .map_err(|e| error("invalid_input", e))?;
        let request: PrivilegedRequest =
            serde_json::from_slice(&bytes).map_err(|e| error("invalid_input", e))?;
        request.selector.validate()?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| error("command_failed", e))?;
        runtime.block_on(async {
            ready().await?;
            let device = select(devices().await?, &request.selector)?;
            if device.client_ip_address.is_some() {
                return Err(error("attached", "device is attached"));
            }
            match request.action {
                PrivilegedAction::Bind => {
                    let bus = device
                        .bus_id
                        .ok_or_else(|| error("unplugged", "device is unplugged"))?;
                    validate_bus(&bus)?;
                    if device.persisted_guid.is_none() {
                        usb_command(&["bind", "--busid", &bus]).await?;
                    }
                }
                PrivilegedAction::Unbind => {
                    if let Some(guid) = device.persisted_guid {
                        usb_command(&["unbind", "--guid", &guid]).await?;
                    }
                }
            }
            Ok(())
        })
    };
    Some(match run() {
        Ok(()) => 0,
        Err(e) if e.code == "device_changed" => 3,
        Err(_) => 1,
    })
}

pub async fn connect(selector: DeviceSelector, config: crate::device::WslConfig) -> Result<()> {
    selector.validate()?;
    let _operation = OPERATIONS
        .try_lock()
        .map_err(|_| error("busy", "another USB operation is in progress"))?;
    let _serial =
        crate::serial::transport::reserve_usb_transfer().map_err(|e| error("serial_busy", e))?;
    validate_config(&config)?;
    ready().await?;
    let device = select(devices().await?, &selector)?;
    if device.client_ip_address.is_some() {
        return Err(error("attached", "device is already attached to a client"));
    }
    let bus = device
        .bus_id
        .as_deref()
        .ok_or_else(|| error("unplugged", "plug in the device first"))?;
    validate_bus(bus)?;
    // Keep the VM active until attach finishes. It is never terminated/shut down.
    let mut keepalive = wsl(&config)?;
    keepalive
        .args([
            "--exec",
            "python3",
            "-I",
            "-c",
            "import sys; sys.stdin.buffer.read()",
        ])
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    keepalive.creation_flags(0x08000000);
    let mut keepalive = keepalive.spawn().map_err(|e| error("wsl_failed", e))?;
    let mut check = wsl(&config)?;
    check.args(["--exec", "uname", "-r"]);
    capture(check, None).await?;
    // WSL2 is determined from the registered distribution Version, not the
    // kernel name: custom WSL2 kernels need not contain "WSL2" in uname output.
    if device.persisted_guid.is_none() {
        elevate(PrivilegedAction::Bind, selector).await?;
    }
    // bind changes the GUID; still require the same physical instance and BUSID.
    let now = devices()
        .await?
        .into_iter()
        .find(|d| d.instance_id == device.instance_id && d.bus_id == device.bus_id)
        .ok_or_else(|| error("device_changed", "device changed while sharing"))?;
    if now.client_ip_address.is_some() {
        return Err(error("attached", "another client attached the device"));
    }
    if keepalive
        .try_wait()
        .map_err(|e| error("wsl_failed", e))?
        .is_some()
    {
        return Err(error(
            "wsl_failed",
            "WSL keepalive exited; check python3 and the selected user",
        ));
    }
    usb_command(&["attach", "--wsl", &config.distribution, "--busid", bus]).await?;
    let connected = devices().await?.into_iter().any(|d| {
        d.instance_id == device.instance_id
            && d.bus_id == device.bus_id
            && d.client_ip_address.is_some()
    });
    drop(keepalive.stdin.take());
    if tokio::time::timeout(Duration::from_secs(2), keepalive.wait())
        .await
        .is_err()
    {
        let _ = keepalive.kill().await;
    }
    if !connected {
        return Err(error("device_changed", "device did not remain attached"));
    }
    Ok(())
}

pub async fn disconnect(selector: DeviceSelector) -> Result<()> {
    selector.validate()?;
    let _operation = OPERATIONS
        .try_lock()
        .map_err(|_| error("busy", "another USB operation is in progress"))?;
    ready().await?;
    let device = select(devices().await?, &selector)?;
    if device.client_ip_address.is_none() {
        return Ok(());
    }
    let bus = device
        .bus_id
        .ok_or_else(|| error("unplugged", "device is unplugged"))?;
    validate_bus(&bus)?;
    usb_command(&["detach", "--busid", &bus]).await?;
    if devices()
        .await?
        .iter()
        .any(|d| d.instance_id == device.instance_id && d.client_ip_address.is_some())
    {
        return Err(error("device_changed", "device is still attached"));
    }
    Ok(())
}

pub async fn unshare(selector: DeviceSelector) -> Result<()> {
    selector.validate()?;
    let _operation = OPERATIONS
        .try_lock()
        .map_err(|_| error("busy", "another USB operation is in progress"))?;
    ready().await?;
    let device = select(devices().await?, &selector)?;
    if device.client_ip_address.is_some() {
        return Err(error(
            "attached",
            "disconnect the device before stopping sharing",
        ));
    }
    if let Some(guid) = device.persisted_guid {
        elevate(PrivilegedAction::Unbind, selector).await?;
        if devices()
            .await?
            .iter()
            .any(|d| d.persisted_guid.as_ref() == Some(&guid))
        {
            return Err(error("device_changed", "device is still shared"));
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize, Serialize)]
pub struct Verification {
    pub visible: bool,
    pub accessible: bool,
    pub nodes: Vec<String>,
}
const VERIFY: &str = include_str!("verify.py");
pub async fn verify(
    selector: DeviceSelector,
    config: crate::device::WslConfig,
) -> Result<Verification> {
    selector.validate()?;
    let _operation = OPERATIONS
        .try_lock()
        .map_err(|_| error("busy", "another USB operation is in progress"))?;
    validate_config(&config)?;
    let device = select(devices().await?, &selector)?;
    if device.client_ip_address.is_none() {
        return Err(error(
            "not_attached",
            "connect the device before verification",
        ));
    }
    let (vid, pid) = hardware_id(&device.instance_id)
        .ok_or_else(|| error("invalid_state", "device has no VID/PID"))?;
    let mut command = wsl(&config)?;
    command.args(["--exec", "python3", "-I", "-", &vid, &pid]);
    let bytes = capture(command, Some(VERIFY.as_bytes().to_vec())).await?;
    serde_json::from_slice(&bytes).map_err(|e| error("invalid_state", e))
}

fn hardware_id(instance: &str) -> Option<(String, String)> {
    let upper = instance.to_ascii_uppercase();
    let vid = upper.split("VID_").nth(1)?.get(..4)?;
    let pid = upper.split("PID_").nth(1)?.get(..4)?;
    if !vid
        .bytes()
        .chain(pid.bytes())
        .all(|b| b.is_ascii_hexdigit())
    {
        return None;
    }
    Some((vid.to_ascii_lowercase(), pid.to_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn state_preserves_offline_shared_devices_and_unknown_clients() {
        let devices = parse_state(br#"{"Devices":[{"InstanceId":"USB\\VID_1234&PID_ABCD\\serial","Description":"offline","BusId":null,"PersistedGuid":"58b0a426-fb28-4e52-bcf2-9506b3f47754","ClientIPAddress":null},{"InstanceId":"other","Description":"client","BusId":"1-2","PersistedGuid":null,"ClientIPAddress":"10.0.0.2","NewField":42}]}"#).unwrap();
        assert!(devices[0].bus_id.is_none());
        assert!(devices[0].persisted_guid.is_some());
        assert_eq!(devices[1].client_ip_address.as_deref(), Some("10.0.0.2"));
        assert_eq!(
            hardware_id(&devices[0].instance_id),
            Some(("1234".into(), "abcd".into()))
        );
        assert!(parse_state(br#"{"NotDevices":[]}"#).is_err());
    }
    #[test]
    fn selector_rejects_injection_and_stale_bus_ids() {
        for bus in ["--all", "1-2;whoami", "1-2\n", "0-1", "1-65536", "1-2-3"] {
            assert!(validate_bus(bus).is_err());
        }
        assert!(validate_bus("1-12").is_ok());
        let mut selector = DeviceSelector {
            instance_id: "real".into(),
            bus_id: Some("1-2".into()),
            persisted_guid: None,
        };
        let other = UsbDevice {
            instance_id: "replacement".into(),
            description: "".into(),
            bus_id: Some("1-2".into()),
            persisted_guid: None,
            client_ip_address: None,
            is_forced: false,
        };
        assert_eq!(
            select(vec![other], &selector).unwrap_err().code,
            "device_changed"
        );
        selector.persisted_guid = Some("--all".into());
        assert_eq!(selector.validate().unwrap_err().code, "invalid_input");
    }
    #[tokio::test]
    async fn output_is_bounded() {
        assert_eq!(read_bounded(&b"hello"[..]).await.unwrap(), b"hello");
        assert_eq!(
            read_bounded(&vec![b'x'; OUTPUT_LIMIT + 1][..])
                .await
                .unwrap_err()
                .code,
            "output_limit"
        );
    }

    #[test]
    fn sharing_changes_and_bus_reuse_require_a_refresh() {
        let current = UsbDevice {
            instance_id: "real".into(),
            description: "".into(),
            bus_id: Some("1-2".into()),
            persisted_guid: Some("58b0a426-fb28-4e52-bcf2-9506b3f47754".into()),
            client_ip_address: None,
            is_forced: false,
        };
        let selector = DeviceSelector {
            instance_id: "real".into(),
            bus_id: Some("1-3".into()),
            persisted_guid: current.persisted_guid.clone(),
        };
        assert_eq!(
            select(vec![current.clone()], &selector).unwrap_err().code,
            "device_changed"
        );
        let selector = DeviceSelector {
            bus_id: Some("1-2".into()),
            persisted_guid: None,
            ..selector
        };
        assert_eq!(
            select(vec![current.clone()], &selector).unwrap_err().code,
            "device_changed"
        );
        let selector = DeviceSelector {
            persisted_guid: current.persisted_guid.clone(),
            ..selector
        };
        assert!(select(vec![current], &selector).is_ok());
    }

    #[test]
    fn elevated_entry_rejects_unknown_actions_and_malformed_payloads() {
        use base64::Engine;
        assert_eq!(elevated_entry(&["rr".into()]), None);
        assert_eq!(
            elevated_entry(&["rr".into(), "--usb-elevated".into(), "not base64".into()]),
            Some(1)
        );
        let payload = base64::engine::general_purpose::STANDARD.encode(br#"{"action":"force","selector":{"instance_id":"x","bus_id":"1-2","persisted_guid":null}}"#);
        assert_eq!(
            elevated_entry(&["rr".into(), "--usb-elevated".into(), payload]),
            Some(1)
        );
        let payload = base64::engine::general_purpose::STANDARD.encode(br#"{"action":"bind","selector":{"instance_id":"x","bus_id":"--all","persisted_guid":null}}"#);
        assert_eq!(
            elevated_entry(&["rr".into(), "--usb-elevated".into(), payload]),
            Some(1)
        );
    }

    fn fixture_command(windows_script: &str, unix_script: &str) -> Command {
        #[cfg(windows)]
        {
            let _ = unix_script;
            let root = std::env::var_os("SystemRoot").unwrap();
            let mut command = Command::new(
                PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
            );
            command.args(["-NoProfile", "-NonInteractive", "-Command", windows_script]);
            command
        }
        #[cfg(not(windows))]
        {
            let _ = windows_script;
            let mut command = Command::new("/bin/sh");
            command.args(["-c", unix_script]);
            command
        }
    }

    #[tokio::test]
    async fn command_capture_preserves_binary_stdin_and_reports_nonzero_exit() {
        let data = vec![0, 255, 13, 10, 128];
        let command = fixture_command(
            "[Console]::OpenStandardInput().CopyTo([Console]::OpenStandardOutput())",
            "cat",
        );
        assert_eq!(capture(command, Some(data.clone())).await.unwrap(), data);
        let command = fixture_command(
            "[Console]::Error.Write('fixture failure'); exit 7",
            "printf 'fixture failure' >&2; exit 7",
        );
        let failure = capture(command, None).await.unwrap_err();
        assert_eq!(failure.code, "command_failed");
        assert!(failure.message.contains("fixture failure"));
    }

    #[tokio::test]
    async fn command_timeout_terminates_the_child() {
        let command = fixture_command("Start-Sleep -Seconds 10", "exec sleep 10");
        assert_eq!(
            capture_with_timeout(command, None, Duration::from_millis(100))
                .await
                .unwrap_err()
                .code,
            "timeout"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "read-only integration requires usbipd-win and an explicitly selected WSL2 distribution"]
    async fn installed_usb_and_wsl_probe_readonly() {
        let config = crate::device::WslConfig {
            distribution: std::env::var("REMOTE_RUNNER_TEST_WSL")
                .expect("set REMOTE_RUNNER_TEST_WSL"),
            user: "".into(),
        };
        let snapshot = snapshot().await;
        assert!(snapshot.problem.is_none(), "{:?}", snapshot.problem);
        assert!(snapshot.wsl_problem.is_none(), "{:?}", snapshot.wsl_problem);
        validate_config(&config).unwrap();
        assert!(snapshot.version.as_ref().unwrap().starts_with("5."));
        // Verify actual serialization is snake_case even though usbipd uses PascalCase.
        let json = serde_json::to_value(&snapshot).unwrap();
        assert!(json.get("devices").unwrap().is_array());
        if let Some(device) = snapshot.devices.first() {
            let value = serde_json::to_value(device).unwrap();
            assert!(value.get("instance_id").is_some());
            assert!(value.get("ClientIPAddress").is_none());
        }
        let mut command = wsl(&config).unwrap();
        command.args(["--exec", "python3", "-I", "-", "ffff", "ffff"]);
        let command_line: usize = command.as_std().get_args().map(|a| a.len() + 1).sum();
        assert!(command_line < 2048);
        let output = capture(command, Some(VERIFY.as_bytes().to_vec()))
            .await
            .unwrap();
        let result: Verification = serde_json::from_slice(&output).unwrap();
        assert!(!result.visible);
        assert!(!result.accessible);
        assert!(result.nodes.is_empty());
    }
}
