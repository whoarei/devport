use super::protocol::{validate_wire_command, wrap, FrameParser};
use crate::error::{Result, RunnerError};
use crate::process::SessionControl;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::process::RunState;
pub use crate::process::StopReason;

#[derive(Debug)]
pub struct CommandResult {
    pub code: u32,
    pub stopped: Option<StopReason>,
}

impl From<CommandResult> for crate::process::Outcome {
    fn from(result: CommandResult) -> Self {
        Self {
            code: Some(result.code),
            stopped: result.stopped,
        }
    }
}

pub struct ShellSession<T> {
    io: T,
    baud_rate: u32,
}

enum IoEvent {
    Read(std::io::Result<usize>),
    Write(std::io::Result<usize>),
}

impl<T: AsyncRead + AsyncWrite + Unpin> ShellSession<T> {
    pub fn new(io: T, baud_rate: u32) -> Self {
        Self { io, baud_rate }
    }

    /// The only bytes accepted as completion are our exact framed exit marker.
    /// In particular, seeing '#' or '$' is never evidence that the process has exited.
    pub async fn execute(
        &mut self,
        command: &str,
        dimensions: Option<(u32, u32)>,
        timeout: Option<Duration>,
        controls: &mut mpsc::UnboundedReceiver<SessionControl>,
        mut output: impl FnMut(Vec<u8>),
        mut state: impl FnMut(RunState),
    ) -> Result<CommandResult> {
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let mut pending = wrap(command, &nonce, dimensions).into_bytes();
        validate_wire_command(std::str::from_utf8(&pending).unwrap())?;
        let mut offset = 0;
        let mut submitted = false;
        let mut queued_input = Vec::new();
        let mut transmitted_any = false;
        let mut parser = FrameParser::new(&nonce);
        let transmission = pending.len() as u64 * 12 / u64::from(self.baud_rate.max(1));
        let mut deadline = Some(Instant::now() + Duration::from_secs(10 + transmission));
        let mut stopped = None;
        let mut controls_open = true;
        let mut read_buf = [0u8; 4096];
        let (mut reader, mut writer) = tokio::io::split(&mut self.io);
        loop {
            let timer = async {
                match deadline {
                    Some(when) => tokio::time::sleep_until(when).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                biased;
                control = controls.recv(), if controls_open => {
                    match control {
                        // Setup/upload commands must never consume user input.
                        Some(SessionControl::Input(data)) if dimensions.is_some() && stopped.is_none() => {
                            let pending_input = if submitted { pending.len() - offset } else { 0 };
                            if queued_input.len() + pending_input + data.len() > 64 * 1024 {
                                return Err(RunnerError::Serial("pending input exceeds 64 KiB; remote process state is unknown".into()));
                            }
                            if submitted && parser.started {
                                pending.drain(..offset);
                                offset = 0;
                                pending.extend(data);
                            } else {
                                queued_input.extend(data);
                            }
                        }
                        Some(SessionControl::Interrupt) if dimensions.is_some() && stopped.is_none() && parser.started => {
                            // Deliver one terminal interrupt without changing the
                            // completion marker, run deadline, or stop state.
                            pending.drain(..offset);
                            offset = 0;
                            pending.insert(0, 3);
                        }
                        Some(SessionControl::Stop | SessionControl::Terminate | SessionControl::Kill) | None => {
                            if control.is_none() { controls_open = false; }
                            if stopped.is_none() {
                                state(RunState::Stopping);
                                stopped = Some(StopReason::User);
                                if !transmitted_any {
                                    return Ok(CommandResult { code: 130, stopped });
                                }
                                queued_input.clear();
                                // A successful local write is not remote confirmation. In
                                // particular, never submit a newline after a partial command.
                                pending = vec![3];
                                offset = 0;
                                deadline = Some(Instant::now() + Duration::from_secs(5));
                            }
                        }
                        // Serial shell cannot resize the running program via a separate channel.
                        _ => {}
                    }
                }
                // Check deadlines even if the port continuously produces output.
                _ = timer => {
                    if stopped.is_some() {
                        return Err(RunnerError::Serial("stop was not confirmed within 5s; remote process may still be running".into()));
                    }
                    if !parser.started {
                        let _ = tokio::time::timeout(Duration::from_secs(1), writer.write_all(&[3])).await;
                        return Err(RunnerError::Serial("no shell response before the transmission/start deadline; check baud rate and ensure the serial console is already logged into a Linux shell; remote state is unknown".into()));
                    }
                    stopped = Some(StopReason::Timeout);
                    state(RunState::Stopping);
                    queued_input.clear();
                    pending = vec![3]; offset = 0;
                    deadline = Some(Instant::now() + Duration::from_secs(5));
                }
                // Control and deadlines take priority, but reads and writes must
                // remain fair: continuous output must not starve a pending Ctrl-C.
                event = async {
                    tokio::select! {
                        result = reader.read(&mut read_buf) => IoEvent::Read(result),
                        result = writer.write(&pending[offset..pending.len().min(offset + 128)]), if offset < pending.len() => IoEvent::Write(result),
                    }
                } => match event {
                IoEvent::Read(result) => {
                    let n = result.map_err(|e| RunnerError::Serial(format!("read failed: {e}")))?;
                    if n == 0 { return Err(RunnerError::Serial("port disconnected before an exit marker; remote process state is unknown".into())); }
                    let was_started = parser.started;
                    let data = parser.push(&read_buf[..n])?;
                    if !was_started && parser.started {
                        if stopped.is_none() { state(RunState::Running); }
                        if stopped.is_none() { deadline = timeout.map(|d| Instant::now() + d); }
                        if stopped.is_none() && submitted && !queued_input.is_empty() {
                            pending.extend(std::mem::take(&mut queued_input));
                        }
                    }
                    if !data.is_empty() { output(data); }
                    if let Some(code) = parser.code { return Ok(CommandResult { code, stopped }); }
                }
                IoEvent::Write(result) => {
                    let n = result.map_err(|e| RunnerError::Serial(format!("write failed: {e}")))?;
                    if n == 0 { return Err(RunnerError::Serial("port closed during write".into())); }
                    transmitted_any = true;
                    offset += n;
                    if offset == pending.len() {
                        if stopped.is_none() { submitted = true; }
                        pending.clear(); offset = 0;
                        if stopped.is_none() && parser.started && !queued_input.is_empty() {
                            pending.extend(std::mem::take(&mut queued_input));
                        }
                    }
                }
                }
            }
        }
    }
}
