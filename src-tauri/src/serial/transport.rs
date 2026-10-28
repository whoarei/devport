use crate::device::SerialConfig;
use crate::error::{Result, RunnerError};
use std::collections::HashSet;
use tokio_serial::{DataBits, FlowControl, Parity, SerialPortBuilderExt, SerialStream, StopBits};

static BUSY_PORTS: parking_lot::Mutex<Option<HashSet<String>>> = parking_lot::Mutex::new(None);
const USB_TRANSFER: &str = "__remote_runner_usb_transfer__";

/// Covers terminals, connection tests, and runs, including duplicate profiles for one port.
pub struct PortLease(String);

impl PortLease {
    pub fn acquire(port: &str) -> Result<Self> {
        #[cfg(windows)]
        let key = port.trim().trim_start_matches(r"\\.\").to_ascii_uppercase();
        #[cfg(not(windows))]
        let key = std::fs::canonicalize(port.trim())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| port.trim().to_string());
        let mut busy = BUSY_PORTS.lock();
        if busy
            .as_ref()
            .is_some_and(|ports| ports.contains(USB_TRANSFER))
        {
            return Err(RunnerError::Serial("USB transfer is in progress".into()));
        }
        if !busy.get_or_insert_with(HashSet::new).insert(key.clone()) {
            return Err(RunnerError::Serial(format!(
                "port {port} is already in use by a terminal, run, or connection test"
            )));
        }
        Ok(Self(key))
    }
}

/// Conservatively exclude all serial sessions while USB ownership changes.
/// Kept under the same lock as acquire(), so new sessions cannot race the check.
pub(crate) fn reserve_usb_transfer() -> Result<PortLease> {
    let mut busy = BUSY_PORTS.lock();
    let ports = busy.get_or_insert_with(HashSet::new);
    if !ports.is_empty() {
        return Err(RunnerError::Serial(
            "stop serial sessions before transferring USB".into(),
        ));
    }
    ports.insert(USB_TRANSFER.into());
    Ok(PortLease(USB_TRANSFER.into()))
}

impl Drop for PortLease {
    fn drop(&mut self) {
        if let Some(busy) = BUSY_PORTS.lock().as_mut() {
            busy.remove(&self.0);
        }
    }
}

pub fn available_ports() -> Result<Vec<String>> {
    let mut ports = tokio_serial::available_ports()
        .map_err(|e| RunnerError::Serial(e.to_string()))?
        .into_iter()
        .map(|p| p.port_name)
        .collect::<Vec<_>>();
    ports.sort();
    ports.dedup();
    Ok(ports)
}

pub fn open(config: &SerialConfig) -> Result<SerialStream> {
    let stream = tokio_serial::new(config.port.trim(), config.baud_rate)
        .data_bits(DataBits::Eight)
        .parity(Parity::None)
        .stop_bits(StopBits::One)
        .flow_control(FlowControl::None)
        .open_native_async()
        .map_err(|e| RunnerError::Serial(format!("open {}: {e}", config.port)))?;
    #[cfg(unix)]
    let stream = {
        let mut stream = stream;
        stream
            .set_exclusive(true)
            .map_err(|e| RunnerError::Serial(e.to_string()))?;
        stream
    };
    // Windows COM handles are opened exclusively by the serialport backend;
    // PortLease still prevents duplicate use within this process.
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn port_lease_is_exclusive_and_released() {
        let name = format!("test-{}", uuid::Uuid::new_v4());
        let lease = PortLease::acquire(&name).unwrap();
        assert!(PortLease::acquire(&name).is_err());
        assert!(reserve_usb_transfer().is_err());
        drop(lease);
        assert!(PortLease::acquire(&name).is_ok());
    }
}
