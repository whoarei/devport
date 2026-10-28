use base64::{engine::general_purpose::STANDARD, Engine};
use devport::{
    device::DeviceProfile,
    terminal::{State, TerminalManager},
};
use russh::{server, Channel, ChannelId};
use std::{sync::Arc, time::Duration};

#[derive(Clone, Copy)]
enum Behavior {
    Echo,
    RejectPty,
    RejectShell,
    Disconnect,
    WaitForShell,
}
struct Server {
    behavior: Behavior,
    sizes: tokio::sync::mpsc::UnboundedSender<(u32, u32)>,
}

impl server::Handler for Server {
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
        term: &str,
        cols: u32,
        rows: u32,
        _: u32,
        _: u32,
        _: &[(russh::Pty, u32)],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        assert_eq!(term, "xterm-256color");
        self.sizes.send((cols, rows)).unwrap();
        if matches!(self.behavior, Behavior::RejectPty) {
            session.channel_failure(channel)?;
        } else {
            session.channel_success(channel)?;
        }
        Ok(())
    }
    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        match self.behavior {
            Behavior::RejectShell => session.channel_failure(channel)?,
            Behavior::WaitForShell => {}
            _ => {
                session.data(channel, b"\xff\0\x1b[31mready\r\n".to_vec())?;
                session.channel_success(channel)?;
                if matches!(self.behavior, Behavior::Disconnect) {
                    session.close(channel)?;
                }
            }
        }
        Ok(())
    }
    async fn exec_request(
        &mut self,
        _: ChannelId,
        _: &[u8],
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        panic!("terminal must request a shell, never execute a wrapper");
    }
    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if data == b"exit\r" {
            session.eof(channel)?;
            let handle = session.handle();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(30)).await;
                let _ = handle.exit_status_request(channel, 7).await;
                let _ = handle.close(channel).await;
            });
        } else {
            session.data(channel, data.to_vec())?;
        }
        Ok(())
    }
    async fn window_change_request(
        &mut self,
        _: ChannelId,
        cols: u32,
        rows: u32,
        _: u32,
        _: u32,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.sizes.send((cols, rows)).unwrap();
        Ok(())
    }
}

async fn fixture(
    behavior: Behavior,
) -> (
    DeviceProfile,
    tokio::task::JoinHandle<()>,
    tokio::sync::mpsc::UnboundedReceiver<(u32, u32)>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let key = russh::keys::PrivateKey::new(
        russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[43; 32]).into(),
        "public-test-key",
    )
    .unwrap();
    let config = Arc::new(server::Config {
        keys: vec![key],
        ..Default::default()
    });
    let (sizes, rx) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let connection = server::run_stream(config, stream, Server { behavior, sizes })
            .await
            .unwrap();
        let _ = connection.await;
    });
    let device = serde_json::from_value(serde_json::json!({"id":"test","name":"test", "host":"127.0.0.1","port":port,"username":"test","auth":{"type":"password","password":"test"}})).unwrap();
    (device, task, rx)
}

async fn until(manager: &TerminalManager, id: &str, expected: State) -> Vec<u8> {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut data = Vec::new();
        loop {
            let read = manager.read(id).unwrap();
            data.extend(STANDARD.decode(read.data).unwrap());
            if read.status.state == expected {
                break data;
            }
            assert!(
                !matches!(read.status.state, State::Failed),
                "{:?}",
                read.status
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn shell_handshake_binary_input_ctrl_c_resize_and_delayed_exit() {
    let (device, server, mut sizes) = fixture(Behavior::Echo).await;
    let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    let manager = TerminalManager::default();
    let id = manager
        .open(device, root.clone(), 80, 24, None)
        .unwrap()
        .session_id;
    let mut output = until(&manager, &id, State::Connected).await;
    assert_eq!(sizes.recv().await, Some((80, 24)));
    manager.input(&id, "\x03中文".into()).unwrap();
    manager.resize(&id, 111, 35).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), sizes.recv())
            .await
            .unwrap(),
        Some((111, 35))
    );
    manager.input(&id, "exit\r".into()).unwrap();
    output.extend(until(&manager, &id, State::Exited).await);
    assert_eq!(
        output,
        [b"\xff\0\x1b[31mready\r\n".as_slice(), "\x03中文".as_bytes()].concat()
    );
    assert_eq!(manager.read(&id).unwrap().status.exit_code, Some(7));
    manager.close(&id).await.unwrap();
    assert!(!manager.has_active());
    server.abort();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn rejected_terminal_requests_and_unconfirmed_disconnect_fail() {
    for behavior in [
        Behavior::RejectPty,
        Behavior::RejectShell,
        Behavior::Disconnect,
    ] {
        let (device, server, _sizes) = fixture(behavior).await;
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let manager = TerminalManager::default();
        let id = manager
            .open(device, root.clone(), 80, 24, None)
            .unwrap()
            .session_id;
        until(&manager, &id, State::Failed).await;
        assert!(manager.read(&id).unwrap().status.error.is_some());
        manager.close(&id).await.unwrap();
        server.abort();
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn close_during_shell_handshake_does_not_wait_for_acknowledgement() {
    let (device, server, mut sizes) = fixture(Behavior::WaitForShell).await;
    let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    let manager = TerminalManager::default();
    let id = manager
        .open(device, root.clone(), 80, 24, None)
        .unwrap()
        .session_id;
    tokio::time::timeout(Duration::from_secs(5), sizes.recv())
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), manager.close(&id))
        .await
        .unwrap()
        .unwrap();
    assert!(!manager.has_active());
    server.abort();
    std::fs::remove_dir_all(root).unwrap();
}
