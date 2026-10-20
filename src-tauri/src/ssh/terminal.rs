use super::client::SshConnection;
use crate::{
    device::DeviceProfile,
    error::{Result, RunnerError},
    terminal::{canceled, Control, Event},
};
use russh::ChannelMsg;
use std::{collections::VecDeque, path::Path, time::Duration};
use tokio::sync::{mpsc, watch};

pub async fn execute(
    device: &DeviceProfile,
    config: &Path,
    cols: u32,
    rows: u32,
    cwd: Option<String>,
    controls: &mut mpsc::Receiver<Control>,
    cancel: &mut watch::Receiver<bool>,
    mut emit: impl FnMut(Event) -> Result<()>,
) -> Result<Option<u32>> {
    let conn = tokio::select! {
        biased;
        _ = canceled(cancel) => return Ok(None),
        result = SshConnection::connect(device, config) => result?,
    };
    let mut channel = tokio::select! {
        biased;
        _ = canceled(cancel) => return Ok(None),
        result = tokio::time::timeout(Duration::from_secs(10), conn.handle.channel_open_session()) =>
            result.map_err(|_| RunnerError::Ssh("terminal channel open timed out".into()))??,
    };
    let mut pending = VecDeque::new();
    let session = async {
        channel
            .request_pty(true, "xterm-256color", cols, rows, 0, 0, &[])
            .await?;
        super::session::await_success(&mut channel, &mut pending).await?;
        channel.request_shell(true).await?;
        super::session::await_success(&mut channel, &mut pending).await?;
        // 工作区终端（00004-workspace-and-sync.md）：tty 输入队列会缓冲该行，shell 就绪后即执行
        if let Some(cwd) = &cwd {
            channel
                .data(
                    format!(
                        "cd {} || echo 'remote-runner: workspace directory not found'\n",
                        crate::runner::sh_quote(cwd)
                    )
                    .as_bytes(),
                )
                .await?;
        }
        emit(Event::Connected)?;
        let mut exit = None;
        loop {
            tokio::select! {
                control = controls.recv() => match control {
                    Some(Control::Input(data)) => channel.data(data.as_slice()).await?,
                    Some(Control::Resize { cols, rows }) => channel.window_change(cols, rows, 0, 0).await?,
                    None => return Ok(None),
                },
                msg = async { match pending.pop_front() { Some(msg) => Some(msg), None => channel.wait().await } } => match msg {
                    Some(ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. }) => emit(Event::Output(data.to_vec()))?,
                    Some(ChannelMsg::ExitStatus { exit_status }) => exit = Some(Some(exit_status)),
                    Some(ChannelMsg::ExitSignal { .. }) => exit = Some(None),
                    None | Some(ChannelMsg::Close) => return exit.ok_or_else(|| RunnerError::Ssh("终端连接中断，未收到 Shell 退出状态".into())),
                    Some(ChannelMsg::Failure) => return Err(RunnerError::Ssh("SSH terminal request rejected".into())),
                    _ => {},
                }
            }
        }
    };
    let result =
        tokio::select! { biased; _ = canceled(cancel) => Ok(None), result = session => result };
    // Closing the PTY hangs up the shell. Do not send commands into a possibly active program.
    let _ = tokio::time::timeout(Duration::from_secs(2), channel.close()).await;
    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        conn.handle
            .disconnect(russh::Disconnect::ByApplication, "terminal closed", ""),
    )
    .await;
    result
}
