use crate::error::Result;
use crate::ssh::client::SshConnection;
use russh::{ChannelMsg, Sig};
use tokio::sync::mpsc;

pub use crate::process::{ConsoleMode, OutputStream, SessionControl, SessionEvent};

pub struct SpawnSpec {
    pub command: String,
    pub mode: ConsoleMode,
    pub cols: u32,
    pub rows: u32,
}

/// 一次远程进程的运行实例（设计文档中的 ProcessSession）
pub struct ProcessSession {
    pub control: mpsc::UnboundedSender<SessionControl>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for ProcessSession {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub async fn spawn(
    conn: &SshConnection,
    spec: SpawnSpec,
    event_tx: mpsc::Sender<SessionEvent>,
) -> Result<ProcessSession> {
    let mut channel = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        conn.handle.channel_open_session(),
    )
    .await
    .map_err(|_| crate::error::RunnerError::Ssh("SSH channel open timed out".into()))??;
    let mut pending = std::collections::VecDeque::new();

    if spec.mode == ConsoleMode::Pty {
        channel
            .request_pty(true, "xterm-256color", spec.cols, spec.rows, 0, 0, &[])
            .await?;
        await_success(&mut channel, &mut pending).await?;
    }
    channel.exec(true, spec.command.as_str()).await?;
    await_success(&mut channel, &mut pending).await?;

    let (control_tx, mut control_rx) = mpsc::unbounded_channel::<SessionControl>();
    let pty = spec.mode == ConsoleMode::Pty;

    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = async {
                    match pending.pop_front() {
                        Some(message) => Some(message),
                        None => channel.wait().await,
                    }
                } => {
                    tracing::debug!("channel msg: {:?}", msg.as_ref().map(|m| std::mem::discriminant(m)));
                    match msg {
                        None => {
                            let _ = event_tx.send(SessionEvent::Closed).await;
                            break;
                        }
                        Some(ChannelMsg::Data { data }) => {
                            let _ = event_tx.send(SessionEvent::Output {
                                stream: OutputStream::Stdout,
                                data: data.to_vec(),
                            }).await;
                        }
                        Some(ChannelMsg::ExtendedData { data, ext }) => {
                            // ext == 1 为 stderr（pipe 模式下）
                            let stream = if ext == 1 { OutputStream::Stderr } else { OutputStream::Stdout };
                            let _ = event_tx.send(SessionEvent::Output { stream, data: data.to_vec() }).await;
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            let _ = event_tx.send(SessionEvent::Exit { code: Some(exit_status) }).await;
                        }
                        Some(ChannelMsg::ExitSignal { .. }) => {
                            let _ = event_tx.send(SessionEvent::Exit { code: None }).await;
                        }
                        // EOF only ends output; exit-status can arrive afterwards.
                        Some(ChannelMsg::Eof) => {}
                        Some(ChannelMsg::Failure) => {
                            let _ = event_tx.send(SessionEvent::Failed { error: "SSH request rejected".into() }).await;
                            break;
                        }
                        Some(ChannelMsg::Close) => {
                            let _ = event_tx.send(SessionEvent::Closed).await;
                            break;
                        }
                        _ => {}
                    }
                }
                ctl = control_rx.recv() => {
                    match ctl {
                        None => {
                            if let Err(e) = channel.close().await {
                                tracing::warn!("close failed: {e}");
                            }
                            break;
                        }
                        Some(SessionControl::Input(bytes)) => {
                            if let Err(e) = channel.data(&bytes[..]).await {
                                tracing::warn!("stdin write failed: {e}");
                            }
                        }
                        Some(SessionControl::Resize { cols, rows }) => {
                            if let Err(e) = channel.window_change(cols, rows, 0, 0).await {
                                tracing::warn!("resize failed: {e}");
                            }
                        }
                        Some(SessionControl::Interrupt | SessionControl::Stop) => {
                            let res = if pty {
                                channel.data(&[0x03u8][..]).await
                            } else {
                                channel.signal(Sig::INT).await
                            };
                            if let Err(e) = res {
                                tracing::warn!("interrupt failed: {e}");
                            }
                        }
                        Some(SessionControl::Terminate) => {
                            if let Err(e) = channel.signal(Sig::TERM).await {
                                tracing::warn!("terminate failed: {e}");
                            }
                        }
                        Some(SessionControl::Kill) => {
                            // 本地强制关闭（服务端可能不回 close，由上层兜底超时）
                            if let Err(e) = channel.signal(Sig::KILL).await {
                                tracing::debug!("kill signal failed (best effort): {e}");
                            }
                            if let Err(e) = channel.close().await {
                                tracing::warn!("kill close failed: {e}");
                            }
                        }
                    }
                }
            }
        }
    });

    Ok(ProcessSession {
        control: control_tx,
        task,
    })
}

pub(super) async fn await_success(
    channel: &mut russh::Channel<russh::client::Msg>,
    pending: &mut std::collections::VecDeque<ChannelMsg>,
) -> Result<()> {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => return Ok(()),
                None | Some(ChannelMsg::Failure | ChannelMsg::Close) => {
                    return Err(crate::error::RunnerError::Ssh(
                        "SSH process request rejected or channel closed".into(),
                    ))
                }
                Some(message) => {
                    let bytes: usize = pending
                        .iter()
                        .map(|m| match m {
                            ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                                data.len()
                            }
                            _ => 0,
                        })
                        .sum();
                    if pending.len() >= 64 || bytes >= 1024 * 1024 {
                        return Err(crate::error::RunnerError::Ssh(
                            "too much output before SSH request acknowledgement".into(),
                        ));
                    }
                    pending.push_back(message);
                }
            }
        }
    })
    .await
    .map_err(|_| crate::error::RunnerError::Ssh("SSH process request timed out".into()))?
}
