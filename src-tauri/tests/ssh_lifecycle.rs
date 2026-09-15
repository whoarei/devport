use remote_runner::device::{AuthMethod, DeviceProfile};
use remote_runner::process::RunState;
use remote_runner::runner::{RunEvent, RunManager, RunRequest, RunStatus};
use russh::{server, Channel, ChannelId};
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Copy)]
enum Behavior {
    RejectExec,
    RejectPty,
    DelayedExit,
    CloseWithoutExit,
    Hang,
}

struct TestServer(Behavior);

impl server::Handler for TestServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, _: &str, _: &str) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        _: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
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
        _: &[(russh::Pty, u32)],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_failure(channel)?;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if matches!(self.0, Behavior::RejectExec) {
            session.channel_failure(channel)?;
            return Ok(());
        }
        if matches!(self.0, Behavior::DelayedExit) {
            session.data(channel, b"early".to_vec())?;
        }
        session.channel_success(channel)?;
        let wire = String::from_utf8_lossy(data);
        use base64::Engine;
        let decoded = wire
            .split("echo ")
            .nth(1)
            .and_then(|s| s.split_whitespace().next())
            .and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
        let command = decoded
            .as_deref()
            .map(String::from_utf8_lossy)
            .unwrap_or(wire);
        let Some(prefix) = command
            .split("printf '")
            .nth(1)
            .and_then(|s| s.split("%s").next())
        else {
            session.exit_status_request(channel, 0)?;
            session.close(channel)?;
            return Ok(());
        };
        session.data(channel, format!("{prefix}123__\nhello").into_bytes())?;
        match self.0 {
            Behavior::DelayedExit => {
                session.eof(channel)?;
                let handle = session.handle();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    let _ = handle.exit_status_request(channel, 7).await;
                    let _ = handle.close(channel).await;
                });
            }
            Behavior::CloseWithoutExit => {
                session.close(channel)?;
            }
            _ => {}
        }
        Ok(())
    }
}

async fn run_case(behavior: Behavior, timeout: u64) -> (RunStatus, Vec<u8>) {
    let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    // Deterministic, public test-only key. No user SSH configuration or real device is used.
    let key = russh::keys::PrivateKey::new(
        russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[42; 32]).into(),
        "test",
    )
    .unwrap();
    let config = Arc::new(server::Config {
        keys: vec![key],
        ..Default::default()
    });
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let connection = server::run_stream(config, stream, TestServer(behavior))
            .await
            .unwrap();
        let _ = connection.await;
    });
    let device = DeviceProfile {
        is_default: false,
        transport: Default::default(),
        serial: None,
        wsl: None,
        local: None,
        id: "test".into(),
        name: "test".into(),
        host: "127.0.0.1".into(),
        port,
        username: "test".into(),
        auth: AuthMethod::Password {
            password: "test".into(),
        },
        workspace_root: "/tmp/test".into(),
    };
    let (tx, mut rx) = remote_runner::events::channel();
    let manager = RunManager::new(&root, tx);
    let request: RunRequest = serde_json::from_value(serde_json::json!({
        "device_id": "test", "kind": "command", "command": "test",
        "console_mode": if matches!(behavior, Behavior::RejectPty) { "pty" } else { "pipe" },
        "timeout_secs": timeout
    }))
    .unwrap();
    let id = manager.start(request, device, root.clone()).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        let mut output = Vec::new();
        loop {
            match rx.recv().await.unwrap() {
                RunEvent::Output { data, .. } => {
                    use base64::Engine;
                    output.extend(
                        base64::engine::general_purpose::STANDARD
                            .decode(data)
                            .unwrap(),
                    );
                }
                RunEvent::Status { status } if status.ended_at.is_some() => break (status, output),
                _ => {}
            }
        }
    })
    .await
    .expect("run must always reach a terminal state");
    assert_eq!(manager.status(&id).unwrap().state, result.0.state);
    assert_eq!(manager.history()[0].run_id, id);
    server.abort();
    std::fs::remove_dir_all(root).unwrap();
    result
}

#[tokio::test]
async fn rejected_exec_fails_run() {
    assert_eq!(
        run_case(Behavior::RejectExec, 0).await.0.state,
        RunState::Failed
    );
}

#[tokio::test]
async fn rejected_pty_fails_run() {
    assert_eq!(
        run_case(Behavior::RejectPty, 0).await.0.state,
        RunState::Failed
    );
}

#[tokio::test]
async fn eof_before_exit_status_preserves_exit_code_and_short_output() {
    let (status, output) = run_case(Behavior::DelayedExit, 0).await;
    assert_eq!(status.state, RunState::Exited);
    assert_eq!(status.exit_code, Some(7));
    assert_eq!(output, b"earlyhello");
}

#[tokio::test]
async fn closed_channel_without_exit_is_a_failure() {
    let (status, output) = run_case(Behavior::CloseWithoutExit, 0).await;
    assert_eq!(status.state, RunState::Failed);
    assert!(status.error.unwrap().contains("without an exit status"));
    assert_eq!(output, b"hello");
}

#[tokio::test]
async fn timeout_escalates_and_finishes() {
    let (status, _) = run_case(Behavior::Hang, 1).await;
    assert_eq!(status.state, RunState::Failed);
    assert_eq!(status.error.as_deref(), Some("timeout after 1s"));
}
