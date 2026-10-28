//! Raw serial terminal: no shell probes, framing, or remote process ownership.
use super::transport::{self, PortLease};
use crate::device::SerialConfig;
use crate::error::{Result, RunnerError};
use crate::terminal::{canceled, Control, Event};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, watch};

pub async fn execute(
    config: &SerialConfig,
    controls: &mut mpsc::Receiver<Control>,
    cancel: &mut watch::Receiver<bool>,
    emit: impl FnMut(Event) -> Result<()>,
) -> Result<Option<u32>> {
    execute_with_open(config, controls, cancel, emit, transport::open).await
}

async fn execute_with_open<T: AsyncRead + AsyncWrite + Unpin>(
    config: &SerialConfig,
    controls: &mut mpsc::Receiver<Control>,
    cancel: &mut watch::Receiver<bool>,
    mut emit: impl FnMut(Event) -> Result<()>,
    open: impl FnOnce(&SerialConfig) -> Result<T>,
) -> Result<Option<u32>> {
    if *cancel.borrow() {
        return Ok(None);
    }
    // Shared with runs and connection tests, including aliases of the same port.
    // Declare IO after the lease so both halves close before the port is released.
    let _lease = PortLease::acquire(&config.port)?;
    let (mut reader, mut writer) = tokio::io::split(open(config)?);
    if *cancel.borrow() {
        return Ok(None);
    }
    emit(Event::Connected)?;
    let mut buffer = [0; 8192];
    let mut pending = Vec::new();
    let mut offset = 0;
    loop {
        tokio::select! {
            biased;
            // Closing only drops IO. Never inject Ctrl+C, exit, stty, or flush
            // pending input: this session does not own the remote process.
            _ = canceled(cancel) => return Ok(None),
            control = controls.recv(), if pending.is_empty() => match control {
                Some(Control::Input(data)) => { pending = data; offset = 0; }
                Some(Control::Resize { .. }) => {} // No out-of-band resize channel.
                None => return Ok(None),
            },
            result = async {
                // Read and write stay fair when either direction is continuously ready.
                tokio::select! {
                    result = reader.read(&mut buffer) => result
                        .map(|n| (true, n))
                        .map_err(|e| RunnerError::Serial(format!("terminal read failed: {e}"))),
                    result = writer.write(&pending[offset..]), if !pending.is_empty() => result
                        .map(|n| (false, n))
                        .map_err(|e| RunnerError::Serial(format!("terminal write failed: {e}"))),
                }
            } => match result? {
                (true, 0) => return Err(RunnerError::Serial("terminal port disconnected; remote process state is unknown".into())),
                (true, n) => emit(Event::Output(buffer[..n].to_vec()))?,
                (false, 0) => return Err(RunnerError::Serial("terminal port closed during write".into())),
                (false, n) => {
                    offset += n;
                    if offset == pending.len() { pending.clear(); offset = 0; }
                }
            },
        }
    }
}

#[cfg(test)]
mod tests;
