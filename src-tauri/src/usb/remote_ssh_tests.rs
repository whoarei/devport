use super::*;
use crate::device::AuthMethod;
use russh::{server, Channel, ChannelId};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[derive(Clone, Copy)]
enum Behavior {
    Success,
    Denied,
    EofOnly,
    Malformed,
    ExcessiveOutput,
    Hang,
}
struct Fixture {
    behavior: Behavior,
    input: Vec<u8>,
    received: Arc<AtomicBool>,
}
impl server::Handler for Fixture {
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
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        command: &[u8],
        session: &mut server::Session,
    ) -> std::result::Result<(), Self::Error> {
        assert_eq!(
            String::from_utf8_lossy(command),
            format!("exec python3 -I -c {}", crate::runner::sh_quote(BOOTSTRAP))
        );
        assert!(command.len() < 512);
        session.channel_success(channel)?;
        Ok(())
    }
    async fn data(
        &mut self,
        _: ChannelId,
        data: &[u8],
        _: &mut server::Session,
    ) -> std::result::Result<(), Self::Error> {
        self.input.extend_from_slice(data);
        Ok(())
    }
    async fn channel_eof(
        &mut self,
        channel: ChannelId,
        session: &mut server::Session,
    ) -> std::result::Result<(), Self::Error> {
        let input: Value = serde_json::from_slice(&self.input).unwrap();
        let source = STANDARD.decode(input["source"].as_str().unwrap()).unwrap();
        assert_eq!(source, HELPER.as_bytes());
        assert_eq!(input["request"]["host_ip"], "192.168.1.5");
        self.received.store(true, Ordering::SeqCst);
        let response = match self.behavior {
            Behavior::Hang => return Ok(()),
            Behavior::Denied => br#"{"type":"usb_result","version":1,"ok":false,"code":"sudo_required","message":"sudo: a password is required"}"#.to_vec(),
            Behavior::Malformed => b"not a protocol response".to_vec(),
            Behavior::ExcessiveOutput => vec![b'x'; super::super::OUTPUT_LIMIT + 1],
            _ => br#"{"type":"usb_result","version":1,"ok":true,"data":{"port":3}}"#.to_vec(),
        };
        for chunk in response.chunks(8192) {
            session.data(channel, chunk.to_vec())?;
        }
        session.eof(channel)?;
        if !matches!(self.behavior, Behavior::EofOnly) {
            session.exit_status_request(
                channel,
                if matches!(self.behavior, Behavior::Denied) {
                    1
                } else {
                    0
                },
            )?;
        }
        session.close(channel)?;
        Ok(())
    }
}

async fn case(behavior: Behavior) -> Result<Value> {
    let root = std::env::temp_dir().join(format!("rr-usb-ssh-{}", uuid::Uuid::new_v4()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let key = russh::keys::PrivateKey::new(
        russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[84; 32]).into(),
        "usb-test",
    )
    .unwrap();
    let config = Arc::new(server::Config {
        keys: vec![key],
        ..Default::default()
    });
    let received = Arc::new(AtomicBool::new(false));
    let fixture = Fixture {
        behavior,
        input: Vec::new(),
        received: received.clone(),
    };
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let connection = server::run_stream(config, stream, fixture).await.unwrap();
        let _ = connection.await;
    });
    let device = DeviceProfile {
        id: "test".into(),
        name: "test".into(),
        is_default: false,
        transport: TransportKind::Ssh,
        serial: None,
        wsl: None,
        local: None,
        host: "127.0.0.1".into(),
        port,
        username: "test".into(),
        auth: AuthMethod::Password {
            password: "test".into(),
        },
        workspace_root: "/tmp/test".into(),
    };
    let connection = SshConnection::connect(&device, &root).await.unwrap();
    let timeout = if matches!(behavior, Behavior::Hang) {
        Duration::from_millis(250)
    } else {
        Duration::from_secs(5)
    };
    let result = request_with_timeout(
        &connection,
        json!({"action":"probe", "host_ip":"192.168.1.5"}),
        timeout,
    )
    .await;
    assert!(received.load(Ordering::SeqCst));
    server.abort();
    drop(connection);
    std::fs::remove_dir_all(root).unwrap();
    result
}
#[tokio::test]
async fn ssh_transfers_source_over_stdin_and_accepts_chunked_completion() {
    assert_eq!(case(Behavior::Success).await.unwrap()["port"], 3);
}
#[tokio::test]
async fn ssh_reports_permission_errors_and_rejects_eof_without_exit() {
    assert_eq!(
        case(Behavior::Denied).await.unwrap_err().code,
        "sudo_required"
    );
    assert_eq!(
        case(Behavior::EofOnly).await.unwrap_err().code,
        "ssh_failed"
    );
    assert_eq!(
        case(Behavior::Malformed).await.unwrap_err().code,
        "ssh_failed"
    );
}
#[tokio::test]
async fn ssh_caps_output_and_times_out_unconfirmed_operations() {
    assert_eq!(
        case(Behavior::ExcessiveOutput).await.unwrap_err().code,
        "output_limit"
    );
    assert_eq!(case(Behavior::Hang).await.unwrap_err().code, "timeout");
}
