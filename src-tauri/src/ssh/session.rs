use crate::error::Result;
use crate::ssh::client::SshConnection;
use russh::{ChannelMsg, ChannelWriteHalf, Sig};
use std::{sync::Arc, time::Duration};
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
    writer: Arc<ChannelWriteHalf<russh::client::Msg>>,
    task: tokio::task::JoinHandle<()>,
}

impl ProcessSession {
    pub(crate) async fn close(&self) {
        let _ = tokio::time::timeout(Duration::from_secs(1), self.writer.close()).await;
    }
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
    spawn_tracked(conn, spec, event_tx, &mut false).await
}

pub(crate) async fn spawn_tracked(
    conn: &SshConnection,
    spec: SpawnSpec,
    event_tx: mpsc::Sender<SessionEvent>,
    exec_may_have_started: &mut bool,
) -> Result<ProcessSession> {
    let mut channel = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        conn.handle.channel_open_session(),
    )
    .await
    .map_err(|_| crate::error::RunnerError::Ssh("SSH channel open timed out".into()))??;
    let mut pending = std::collections::VecDeque::new();

    let start = async {
        if spec.mode == ConsoleMode::Pty {
            channel
                .request_pty(true, "xterm-256color", spec.cols, spec.rows, 0, 0, &[])
                .await?;
            await_success(&mut channel, &mut pending).await?;
        }
        *exec_may_have_started = true;
        channel.exec(true, spec.command.as_str()).await?;
        if request_accepted(&mut channel, &mut pending).await? {
            Ok(())
        } else {
            *exec_may_have_started = false;
            Err(rejected_request())
        }
    };
    if let Err(error) = start.await {
        let _ = tokio::time::timeout(Duration::from_secs(1), channel.close()).await;
        return Err(error);
    }

    let (control_tx, mut control_rx) = mpsc::unbounded_channel::<SessionControl>();
    let pty = spec.mode == ConsoleMode::Pty;
    let (mut reader, writer) = channel.split();
    let writer = Arc::new(writer);
    let session_writer = writer.clone();

    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = async {
                    match pending.pop_front() {
                        Some(message) => Some(message),
                        None => reader.wait().await,
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
                            if let Err(e) = session_writer.close().await {
                                tracing::warn!("close failed: {e}");
                            }
                            break;
                        }
                        Some(SessionControl::Input(bytes)) => {
                            if let Err(e) = session_writer.data(&bytes[..]).await {
                                tracing::warn!("stdin write failed: {e}");
                            }
                        }
                        Some(SessionControl::Resize { cols, rows }) => {
                            if let Err(e) = session_writer.window_change(cols, rows, 0, 0).await {
                                tracing::warn!("resize failed: {e}");
                            }
                        }
                        Some(SessionControl::Interrupt | SessionControl::Stop) => {
                            let res = if pty {
                                session_writer.data(&[0x03u8][..]).await
                            } else {
                                session_writer.signal(Sig::INT).await
                            };
                            if let Err(e) = res {
                                tracing::warn!("interrupt failed: {e}");
                            }
                        }
                        Some(SessionControl::Terminate) => {
                            if let Err(e) = session_writer.signal(Sig::TERM).await {
                                tracing::warn!("terminate failed: {e}");
                            }
                        }
                        Some(SessionControl::Kill) => {
                            // Keep reading so the server can confirm the exit.
                            if let Err(e) = session_writer.signal(Sig::KILL).await {
                                tracing::debug!("kill signal failed (best effort): {e}");
                            }
                        }
                    }
                }
            }
        }
    });

    Ok(ProcessSession {
        control: control_tx,
        writer,
        task,
    })
}

pub(super) async fn await_success(
    channel: &mut russh::Channel<russh::client::Msg>,
    pending: &mut std::collections::VecDeque<ChannelMsg>,
) -> Result<()> {
    if request_accepted(channel, pending).await? {
        Ok(())
    } else {
        Err(rejected_request())
    }
}

fn rejected_request() -> crate::error::RunnerError {
    crate::error::RunnerError::Ssh("SSH process request rejected".into())
}

async fn request_accepted(
    channel: &mut russh::Channel<russh::client::Msg>,
    pending: &mut std::collections::VecDeque<ChannelMsg>,
) -> Result<bool> {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => return Ok(true),
                Some(ChannelMsg::Failure) => return Ok(false),
                None | Some(ChannelMsg::Close) => {
                    return Err(crate::error::RunnerError::Ssh(
                        "SSH channel closed before acknowledging the process request".into(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use russh::{server, Channel, ChannelId, Pty};

    struct Server;

    impl server::Handler for Server {
        type Error = russh::Error;

        async fn auth_password(
            &mut self,
            _: &str,
            _: &str,
        ) -> std::result::Result<server::Auth, Self::Error> {
            Ok(server::Auth::Accept)
        }

        async fn channel_open_session(
            &mut self,
            _: Channel<server::Msg>,
            reply: server::ChannelOpenHandle,
            _: &mut server::Session,
        ) -> std::result::Result<(), Self::Error> {
            reply.accept().await;
            Ok(())
        }

        async fn pty_request(
            &mut self,
            channel: ChannelId,
            _: &str,
            _: u32,
            _: u32,
            _: u32,
            _: u32,
            _: &[(Pty, u32)],
            session: &mut server::Session,
        ) -> std::result::Result<(), Self::Error> {
            session.channel_failure(channel)
        }

        async fn exec_request(
            &mut self,
            channel: ChannelId,
            command: &[u8],
            session: &mut server::Session,
        ) -> std::result::Result<(), Self::Error> {
            match command {
                b"reject" => session.channel_failure(channel),
                b"close" => session.close(channel),
                _ => session.channel_success(channel),
            }
        }

        async fn signal(
            &mut self,
            channel: ChannelId,
            signal: Sig,
            session: &mut server::Session,
        ) -> std::result::Result<(), Self::Error> {
            assert!(matches!(signal, Sig::KILL));
            let handle = session.handle();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(50)).await;
                let _ = handle.exit_status_request(channel, 137).await;
                let _ = handle.close(channel).await;
            });
            Ok(())
        }
    }

    #[tokio::test]
    async fn tracks_rejected_and_unconfirmed_starts_and_reads_exit_after_kill() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let device = serde_json::from_value(serde_json::json!({
            "id": "test", "name": "test", "host": "127.0.0.1", "port": port,
            "username": "test", "auth": { "type": "password", "password": "test" }
        }))
        .unwrap();
        let key = russh::keys::PrivateKey::new(
            russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[73; 32]).into(),
            "test",
        )
        .unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let config = Arc::new(server::Config {
                keys: vec![key],
                ..Default::default()
            });
            server::run_stream(config, stream, Server)
                .await
                .unwrap()
                .await
                .unwrap();
        });
        let config = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let connection = SshConnection::connect(&device, &config).await.unwrap();
        std::fs::remove_dir_all(config).unwrap();

        for (mode, command, may_have_started) in [
            (ConsoleMode::Pty, "run", false),
            (ConsoleMode::Pipe, "reject", false),
            (ConsoleMode::Pipe, "close", true),
        ] {
            let spec = SpawnSpec {
                command: command.into(),
                mode,
                cols: 80,
                rows: 24,
            };
            let (events, _rx) = mpsc::channel(4);
            let mut started = false;
            assert!(spawn_tracked(&connection, spec, events, &mut started)
                .await
                .is_err());
            assert_eq!(started, may_have_started, "{mode:?} {command}");
        }

        let spec = SpawnSpec {
            command: "run".into(),
            mode: ConsoleMode::Pipe,
            cols: 80,
            rows: 24,
        };
        let (events, mut rx) = mpsc::channel(4);
        let session = spawn(&connection, spec, events).await.unwrap();
        session.control.send(SessionControl::Kill).unwrap();
        let event = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap();
        assert!(
            matches!(event, Some(SessionEvent::Exit { code: Some(137) })),
            "{event:?}"
        );
        server.abort();
    }
}
