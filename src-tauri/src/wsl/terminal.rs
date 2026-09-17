//! Terminal launch shares only the framed Bridge/helper with workload execution.
use super::*;
use crate::terminal::{canceled, Control, Event as TerminalEvent};
use tokio::sync::watch;

pub async fn execute(
    config: &WslConfig,
    cols: u32,
    rows: u32,
    cwd: Option<String>,
    controls: &mut mpsc::Receiver<Control>,
    cancel: &mut watch::Receiver<bool>,
    emit: impl FnMut(TerminalEvent) -> Result<()>,
) -> Result<Option<u32>> {
    execute_with_command(
        helper_command(config)?,
        cols,
        rows,
        cwd,
        controls,
        cancel,
        emit,
    )
    .await
}

pub(super) async fn execute_with_command(
    command: impl Into<HelperCommand>,
    cols: u32,
    rows: u32,
    cwd: Option<String>,
    controls: &mut mpsc::Receiver<Control>,
    cancel: &mut watch::Receiver<bool>,
    mut emit: impl FnMut(TerminalEvent) -> Result<()>,
) -> Result<Option<u32>> {
    crate::terminal::validate_size(cols, rows)?;
    let mut bridge = tokio::select! {
        biased;
        _ = canceled(cancel) => return Ok(None),
        result = Bridge::launch(command) => result?,
    };
    let session = async {
        bridge.request(json!({"type":"init", "terminal":true, "mode":"pty", "cols":cols, "rows":rows, "timeout":0, "cwd":cwd})).await?;
        bridge.send(json!({"type":"start"})).await?;
        match tokio::time::timeout(IO_TIMEOUT, bridge.next())
            .await
            .map_err(|_| failure("terminal startup timed out"))??
        {
            Message::Started => emit(TerminalEvent::Connected)?,
            _ => return Err(failure("unexpected terminal startup response")),
        }
        loop {
            tokio::select! {
                control = controls.recv() => match control {
                    Some(Control::Input(data)) => bridge.send(json!({"type":"input", "data":STANDARD.encode(data)})).await?,
                    Some(Control::Resize { cols, rows }) => bridge.send(json!({"type":"resize", "cols":cols, "rows":rows})).await?,
                    None => return Ok(None),
                },
                message = bridge.next() => match message? {
                    Message::Output { data, .. } => emit(TerminalEvent::Output(STANDARD.decode(data).map_err(|_| failure("invalid terminal output bytes"))?))?,
                    Message::Exit { code: Some(code), .. } => { bridge.wait().await?; return Ok(Some(code)); },
                    _ => return Err(failure("unexpected terminal response")),
                }
            }
        }
    };
    let result =
        tokio::select! { biased; _ = canceled(cancel) => Ok(None), result = session => result };
    // Shutdown runs helper finally cleanup, including foreground/background job groups.
    // Bound cleanup even when the helper or a remote PTY is broken.
    if !matches!(result, Ok(Some(_))) {
        let cleanup = async {
            bridge.send(json!({"type":"shutdown"})).await?;
            // Drain stdout while waiting so a full pipe cannot block helper cleanup.
            while bridge.next().await.is_ok() {}
            bridge.wait().await
        };
        if let Err(error) = tokio::time::timeout(Duration::from_secs(8), cleanup)
            .await
            .unwrap_or_else(|_| Err(failure("terminal cleanup timed out")))
        {
            return Err(error);
        }
    }
    result
}
