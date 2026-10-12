//! Short-lived SSH control; USB/IP data connects directly to the Windows host.
use super::{error, DeviceSelector, Result, UsbError, Verification};
use crate::{
    device::{DeviceProfile, TransportKind},
    ssh::client::SshConnection,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use russh::{ChannelMsg, Sig};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    net::{IpAddr, Ipv4Addr},
    path::Path,
    time::Duration,
};

const HELPER: &str = include_str!("remote_helper.py");
const BOOTSTRAP: &str = "import base64,json,sys;payload=json.load(sys.stdin);exec(compile(base64.b64decode(payload['source']),'<usb-remote>','exec'))";
const TIMEOUT: Duration = Duration::from_secs(40);

#[cfg(test)]
#[path = "remote_ssh_tests.rs"]
mod ssh_tests;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteConfig {
    pub device_id: String,
    #[serde(default)]
    pub host_ip: String,
}
impl RemoteConfig {
    pub fn validate(&self) -> Result<()> {
        if self.device_id.trim().is_empty()
            || self.device_id.len() > 128
            || self.device_id.chars().any(char::is_control)
        {
            return Err(error("invalid_input", "select a saved SSH device"));
        }
        if !self.host_ip.is_empty() {
            validate_host(&self.host_ip)?;
        }
        Ok(())
    }
}
fn validate_host(host: &str) -> Result<Ipv4Addr> {
    let address: Ipv4Addr = host
        .parse()
        .map_err(|_| error("invalid_input", "Windows host must be an IPv4 address"))?;
    if address.is_unspecified()
        || address.octets()[0] == 0
        || address.octets()[0] >= 224
        || address.is_loopback()
        || address.is_multicast()
        || address.is_broadcast()
    {
        return Err(error(
            "invalid_input",
            "use a Windows IPv4 address reachable from the Linux target",
        ));
    }
    Ok(address)
}
fn validate_device(device: &DeviceProfile, config: &RemoteConfig) -> Result<()> {
    config.validate()?;
    if device.transport != TransportKind::Ssh || device.id != config.device_id {
        return Err(error(
            "invalid_input",
            "remote USB requires the selected saved SSH profile",
        ));
    }
    device.validate().map_err(|e| error("invalid_input", e))
}
async fn host_address(device: &DeviceProfile, config: &RemoteConfig) -> Result<String> {
    if !config.host_ip.is_empty() {
        return Ok(validate_host(&config.host_ip)?.to_string());
    }
    let addresses = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::lookup_host((device.host.as_str(), device.port)),
    )
    .await
    .map_err(|_| error("timeout", "resolving SSH target timed out"))?
    .map_err(|e| error("host_ip_required", e))?;
    for address in addresses.filter(|a| a.is_ipv4()) {
        let socket = tokio::net::UdpSocket::bind("0.0.0.0:0")
            .await
            .map_err(|e| error("host_ip_required", e))?;
        if socket.connect(address).await.is_ok() {
            if let IpAddr::V4(local) = socket
                .local_addr()
                .map_err(|e| error("host_ip_required", e))?
                .ip()
            {
                if validate_host(&local.to_string()).is_ok() {
                    return Ok(local.to_string());
                }
            }
        }
    }
    Err(error(
        "host_ip_required",
        "enter the Windows IPv4 address reachable from this Linux client",
    ))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Export {
    pub bus_id: String,
    pub vid: String,
    pub pid: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Probe {
    pub host_ip: String,
    pub kernel: String,
    pub usbip_path: Option<String>,
    pub vhci_loaded: bool,
    pub can_load_module: bool,
    pub privilege: String,
    pub reachable: bool,
    pub network_error: Option<String>,
    pub exports: Vec<Export>,
}
fn preflight(probe: &Probe) -> Result<()> {
    if probe.usbip_path.is_none() {
        return Err(error(
            "usbip_missing",
            "install usbip client tools on the Linux target",
        ));
    }
    if probe.privilege == "unavailable" {
        return Err(error("sudo_required", "use root or non-interactive sudo"));
    }
    if !probe.vhci_loaded && !probe.can_load_module {
        return Err(error("vhci_missing", "load vhci_hcd on the Linux target"));
    }
    if !probe.reachable {
        return Err(error(
            "network_unreachable",
            probe
                .network_error
                .as_deref()
                .unwrap_or("Linux cannot reach Windows TCP 3240"),
        ));
    }
    Ok(())
}

fn remote_error(code: &str, message: String) -> UsbError {
    // Stable codes are whitelisted rather than leaking arbitrary protocol fields.
    let code = match code {
        "invalid_input" => "invalid_input",
        "timeout" => "timeout",
        "output_limit" => "output_limit",
        "linux_required" => "linux_required",
        "usbip_missing" => "usbip_missing",
        "vhci_missing" => "vhci_missing",
        "sudo_required" => "sudo_required",
        "network_unreachable" => "network_unreachable",
        "usbip_protocol" => "usbip_protocol",
        "remote_not_attached" => "remote_not_attached",
        "device_changed" => "device_changed",
        "attached" => "attached",
        "busy" => "busy",
        "permission_denied" => "permission_denied",
        _ => "remote_command_failed",
    };
    error(code, message)
}
fn decode_response(stdout: &[u8], stderr: &[u8], exit: Option<u32>) -> Result<Value> {
    let value: Value = serde_json::from_slice(stdout).map_err(|_| {
        error(
            "ssh_failed",
            format!(
                "no valid remote USB completion response: {}",
                String::from_utf8_lossy(stderr)
            ),
        )
    })?;
    if value.get("type").and_then(Value::as_str) != Some("usb_result")
        || value.get("version").and_then(Value::as_u64) != Some(1)
        || exit.is_none()
    {
        return Err(error(
            "ssh_failed",
            "remote USB helper closed without a supported completion and exit status",
        ));
    }
    match (value.get("ok").and_then(Value::as_bool), exit) {
        (Some(true), Some(0)) => value
            .get("data")
            .cloned()
            .ok_or_else(|| error("invalid_state", "missing USB response data")),
        (Some(false), Some(code)) if code != 0 => Err(remote_error(
            value
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("remote_command_failed"),
            value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("remote USB operation failed")
                .to_owned(),
        )),
        _ => Err(error(
            "ssh_failed",
            "remote USB helper returned inconsistent completion and exit status",
        )),
    }
}

async fn request(connection: &SshConnection, request: Value) -> Result<Value> {
    request_with_timeout(connection, request, TIMEOUT).await
}

async fn request_with_timeout(
    connection: &SshConnection,
    request: Value,
    timeout: Duration,
) -> Result<Value> {
    let mut channel = tokio::time::timeout(
        Duration::from_secs(10),
        connection.handle.channel_open_session(),
    )
    .await
    .map_err(|_| error("timeout", "opening USB SSH channel timed out"))?
    .map_err(|e| error("ssh_failed", e))?;
    let payload =
        serde_json::to_vec(&json!({"source": STANDARD.encode(HELPER), "request": request}))
            .map_err(|e| error("invalid_input", e))?;
    let command = format!("exec python3 -I -c {}", crate::runner::sh_quote(BOOTSTRAP));
    let work = async {
        channel
            .exec(true, command)
            .await
            .map_err(|e| error("ssh_failed", e))?;
        channel
            .data(payload.as_slice())
            .await
            .map_err(|e| error("ssh_failed", e))?;
        channel.eof().await.map_err(|e| error("ssh_failed", e))?;
        let (mut stdout, mut stderr, mut exit) = (Vec::new(), Vec::new(), None);
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    if stdout.len() + data.len() > super::OUTPUT_LIMIT {
                        return Err(error("output_limit", "remote USB response exceeded 1 MiB"));
                    }
                    stdout.extend_from_slice(&data);
                }
                ChannelMsg::ExtendedData { data, .. } => {
                    if stderr.len() + data.len() > 65536 {
                        return Err(error(
                            "output_limit",
                            "remote USB diagnostics exceeded 64 KiB",
                        ));
                    }
                    stderr.extend_from_slice(&data);
                }
                ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                ChannelMsg::ExitSignal { .. } => {
                    return Err(error("ssh_failed", "remote USB helper was terminated"))
                }
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        decode_response(&stdout, &stderr, exit)
    };
    let result = tokio::time::timeout(timeout, work)
        .await
        .map_err(|_| error("timeout", "remote USB helper timed out"))
        .and_then(|r| r);
    if result.is_err() {
        // TERM lets the helper reap command process groups in its finally block.
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            let _ = channel.signal(Sig::TERM).await;
            let _ = channel.close().await;
        })
        .await;
    }
    result
}
async fn connection(device: &DeviceProfile, config_dir: &Path) -> Result<SshConnection> {
    SshConnection::connect(device, config_dir)
        .await
        .map_err(|e| error("ssh_failed", e))
}
async fn probe_on(connection: &SshConnection, host: &str) -> Result<Probe> {
    serde_json::from_value(request(connection, json!({"action":"probe", "host_ip":host})).await?)
        .map_err(|e| error("invalid_state", e))
}
pub async fn probe(
    device: &DeviceProfile,
    config: RemoteConfig,
    config_dir: &Path,
) -> Result<Probe> {
    validate_device(device, &config)?;
    let _operation = super::OPERATIONS
        .try_lock()
        .map_err(|_| error("busy", "another USB operation is in progress"))?;
    super::ready().await?;
    let host = host_address(device, &config).await?;
    probe_on(&connection(device, config_dir).await?, &host).await
}

pub async fn connect(
    selector: DeviceSelector,
    device: &DeviceProfile,
    config: RemoteConfig,
    config_dir: &Path,
) -> Result<String> {
    selector.validate()?;
    validate_device(device, &config)?;
    let _operation = super::OPERATIONS
        .try_lock()
        .map_err(|_| error("busy", "another USB operation is in progress"))?;
    let _serial =
        crate::serial::transport::reserve_usb_transfer().map_err(|e| error("serial_busy", e))?;
    super::ready().await?;
    let selected = super::select(super::devices().await?, &selector)?;
    if selected.client_ip_address.is_some() {
        return Err(error("attached", "device is already attached to a client"));
    }
    let bus = selected
        .bus_id
        .as_deref()
        .ok_or_else(|| error("unplugged", "plug in the USB device"))?;
    let (vid, pid) = super::hardware_id(&selected.instance_id)
        .ok_or_else(|| error("invalid_state", "USB VID/PID unavailable"))?;
    let host = host_address(device, &config).await?;
    let connection = connection(device, config_dir).await?;
    preflight(&probe_on(&connection, &host).await?)?;
    if selected.persisted_guid.is_none() {
        super::elevate(super::PrivilegedAction::Bind, selector).await?;
    }
    let now = super::devices()
        .await?
        .into_iter()
        .find(|d| d.instance_id == selected.instance_id && d.bus_id == selected.bus_id)
        .ok_or_else(|| error("device_changed", "USB device changed while sharing"))?;
    if now.client_ip_address.is_some() {
        return Err(error("attached", "another client attached the USB device"));
    }
    request(
        &connection,
        json!({"action":"connect", "host_ip":host, "bus_id":bus, "vid":vid, "pid":pid}),
    )
    .await?;
    let confirmed = super::devices().await?.iter().any(|d| {
        d.instance_id == selected.instance_id
            && d.bus_id == selected.bus_id
            && d.client_ip_address.is_some()
    });
    if !confirmed {
        return Err(error(
            "device_changed",
            "Windows did not confirm the USB attachment",
        ));
    }
    Ok(host)
}

pub async fn disconnect(
    selector: DeviceSelector,
    device: &DeviceProfile,
    config: RemoteConfig,
    config_dir: &Path,
) -> Result<()> {
    selector.validate()?;
    validate_device(device, &config)?;
    let _operation = super::OPERATIONS
        .try_lock()
        .map_err(|_| error("busy", "another USB operation is in progress"))?;
    super::ready().await?;
    let selected = super::select(super::devices().await?, &selector)?;
    let bus = selected.bus_id.as_deref().ok_or_else(|| {
        error(
            "unplugged",
            "USB is unplugged; clean up its Linux import with usbip detach",
        )
    })?;
    let (vid, pid) = super::hardware_id(&selected.instance_id)
        .ok_or_else(|| error("invalid_state", "USB VID/PID unavailable"))?;
    let host = host_address(device, &config).await?;
    let connection = connection(device, config_dir).await?;
    request(
        &connection,
        json!({"action":"disconnect", "host_ip":host, "bus_id":bus, "vid":vid, "pid":pid}),
    )
    .await?;
    if super::devices()
        .await?
        .iter()
        .any(|d| d.instance_id == selected.instance_id && d.client_ip_address.is_some())
    {
        return Err(error(
            "device_changed",
            "Windows still reports an attached client; refresh before retrying",
        ));
    }
    Ok(())
}
pub async fn verify(
    selector: DeviceSelector,
    device: &DeviceProfile,
    config: RemoteConfig,
    config_dir: &Path,
) -> Result<Verification> {
    selector.validate()?;
    validate_device(device, &config)?;
    let _operation = super::OPERATIONS
        .try_lock()
        .map_err(|_| error("busy", "another USB operation is in progress"))?;
    let selected = super::select(super::devices().await?, &selector)?;
    let bus = selected
        .bus_id
        .as_deref()
        .ok_or_else(|| error("unplugged", "USB device is unplugged"))?;
    if selected.client_ip_address.is_none() {
        return Err(error(
            "not_attached",
            "attach the USB device before verification",
        ));
    }
    let (vid, pid) = super::hardware_id(&selected.instance_id)
        .ok_or_else(|| error("invalid_state", "USB VID/PID unavailable"))?;
    let host = host_address(device, &config).await?;
    let connection = connection(device, config_dir).await?;
    serde_json::from_value(
        request(
            &connection,
            json!({"action":"verify", "host_ip":host, "bus_id":bus, "vid":vid, "pid":pid}),
        )
        .await?,
    )
    .map_err(|e| error("invalid_state", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_host_rejects_shell_text_and_non_routable_addresses() {
        for host in [
            "127.0.0.1",
            "0.0.0.0",
            "255.255.255.255",
            "224.0.0.1",
            "::1",
            "host;id",
            "192.168.1.1\n",
            "--all",
        ] {
            assert!(validate_host(host).is_err(), "{host}");
        }
        assert_eq!(
            validate_host("192.168.1.4").unwrap().to_string(),
            "192.168.1.4"
        );
        assert!(RemoteConfig {
            device_id: "ssh".into(),
            host_ip: "".into()
        }
        .validate()
        .is_ok());
    }
    #[test]
    fn completion_requires_both_protocol_and_exit_status() {
        let ok = br#"{"type":"usb_result","version":1,"ok":true,"data":{"port":0}}"#;
        assert!(decode_response(ok, b"", Some(0)).is_ok());
        assert!(decode_response(ok, b"", None).is_err());
        assert!(decode_response(ok, b"", Some(1)).is_err());
        let failed = br#"{"type":"usb_result","version":1,"ok":false,"code":"sudo_required","message":"denied"}"#;
        assert_eq!(
            decode_response(failed, b"", Some(1)).unwrap_err().code,
            "sudo_required"
        );
        assert!(decode_response(failed, b"", Some(0)).is_err());
        assert!(decode_response(b"", b"python3 missing", Some(127))
            .unwrap_err()
            .message
            .contains("python3 missing"));
    }
    #[test]
    fn helper_source_and_user_values_are_not_part_of_the_ssh_command() {
        let command = format!("exec python3 -I -c {}", crate::runner::sh_quote(BOOTSTRAP));
        assert!(command.len() < 512);
        assert!(!command.contains(HELPER));
        assert!(!command.contains("192.168"));
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "hardware-free POSIX helper simulation requires an explicitly selected WSL distribution"]
    async fn python_helper_simulation_on_wsl() {
        let config = crate::device::WslConfig {
            distribution: std::env::var("REMOTE_RUNNER_TEST_WSL")
                .expect("set REMOTE_RUNNER_TEST_WSL"),
            user: "".into(),
        };
        config.validate().unwrap();
        let script = format!("import base64,types\nhelper=types.ModuleType('usb_remote')\nexec(compile(base64.b64decode('{}'),'<usb-helper>','exec'),helper.__dict__)\n{}",
            STANDARD.encode(HELPER), include_str!("remote_helper_tests.py"));
        let mut command = crate::wsl::wsl_command().unwrap();
        command.args([
            "--distribution",
            &config.distribution,
            "--exec",
            "python3",
            "-I",
            "-",
        ]);
        super::super::capture(command, Some(script.into_bytes()))
            .await
            .unwrap();
    }
}
