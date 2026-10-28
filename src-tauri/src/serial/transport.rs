use crate::device::{SerialConfig, SerialFlowControl, SerialParity};
use crate::error::{Result, RunnerError};
use std::collections::HashSet;
use tokio_serial::{
    DataBits, FlowControl, Parity, SerialPortBuilder, SerialPortBuilderExt, SerialStream, StopBits,
};

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

fn builder(config: &SerialConfig) -> Result<SerialPortBuilder> {
    config.validate()?;
    Ok(tokio_serial::new(config.port.trim(), config.baud_rate)
        .data_bits(match config.data_bits {
            5 => DataBits::Five,
            6 => DataBits::Six,
            7 => DataBits::Seven,
            _ => DataBits::Eight,
        })
        .parity(match config.parity {
            SerialParity::None => Parity::None,
            SerialParity::Odd => Parity::Odd,
            SerialParity::Even => Parity::Even,
        })
        .stop_bits(if config.stop_bits == 1 {
            StopBits::One
        } else {
            StopBits::Two
        })
        .flow_control(match config.flow_control {
            SerialFlowControl::None => FlowControl::None,
            SerialFlowControl::Software => FlowControl::Software,
            SerialFlowControl::Hardware => FlowControl::Hardware,
        }))
}

pub fn open(config: &SerialConfig) -> Result<SerialStream> {
    let stream = builder(config)?
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
    fn driver_uses_custom_line_settings_and_legacy_profiles_default_to_8n1() {
        let legacy: SerialConfig =
            serde_json::from_value(serde_json::json!({"port":"test-port"})).unwrap();
        assert_eq!(
            builder(&legacy).unwrap(),
            tokio_serial::new("test-port", 115200)
                .data_bits(DataBits::Eight)
                .parity(Parity::None)
                .stop_bits(StopBits::One)
                .flow_control(FlowControl::None)
        );
        for (data_bits, parity, stop_bits, flow_control, expected) in [
            (
                7,
                SerialParity::Even,
                2,
                SerialFlowControl::Hardware,
                tokio_serial::new("test-port", 250000)
                    .data_bits(DataBits::Seven)
                    .parity(Parity::Even)
                    .stop_bits(StopBits::Two)
                    .flow_control(FlowControl::Hardware),
            ),
            (
                5,
                SerialParity::Odd,
                1,
                SerialFlowControl::Software,
                tokio_serial::new("test-port", 250000)
                    .data_bits(DataBits::Five)
                    .parity(Parity::Odd)
                    .stop_bits(StopBits::One)
                    .flow_control(FlowControl::Software),
            ),
        ] {
            let config = SerialConfig {
                port: " test-port ".into(),
                baud_rate: 250000,
                data_bits,
                parity,
                stop_bits,
                flow_control,
            };
            assert_eq!(builder(&config).unwrap(), expected);
        }
        let invalid = SerialConfig {
            port: "must-not-open".into(),
            data_bits: 9,
            ..Default::default()
        };
        assert!(open(&invalid)
            .unwrap_err()
            .to_string()
            .contains("data bits"));
    }

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
