use crate::device::{AuthMethod, DeviceProfile};
use crate::error::{HostKeyChange, Result, RunnerError};
use russh::client::{self, Config, Handle};
use russh::keys::HashAlg;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// known_hosts 简化实现：TOFU（首次信任并保存，再次连接校验）
pub struct KnownHosts {
    path: PathBuf,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_connections_cannot_overwrite_trust_or_accept_changed_keys() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let mut first = KnownHosts::load(&root);
        let mut second = KnownHosts::load(&root);
        first.check_or_trust("host-a:22", "key-a").unwrap();
        second.check_or_trust("host-b:22", "key-b").unwrap();
        assert!(matches!(
            second.check_or_trust("host-a:22", "changed"),
            Err(RunnerError::HostKeyMismatch(_))
        ));
        assert!(first.check_or_trust("host-b:22", "key-b").unwrap());
        std::fs::write(root.join("known_hosts.json"), "broken json").unwrap();
        assert!(first.check_or_trust("host-a:22", "changed").is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("known_hosts.json")).unwrap(),
            "broken json"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replacement_requires_the_exact_current_address_and_fingerprints() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let mut hosts = KnownHosts::load(&root);
        hosts.check_or_trust("host-a:22", "old").unwrap();
        hosts.check_or_trust("host-b:22", "other").unwrap();
        let original = std::fs::read(root.join("known_hosts.json")).unwrap();
        let confirmation = HostKeyChange {
            addr: "host-a:22".into(),
            saved_fingerprint: "old".into(),
            received_fingerprint: "new".into(),
        };
        for wrong in [
            HostKeyChange {
                addr: "host-b:22".into(),
                ..confirmation.clone()
            },
            HostKeyChange {
                saved_fingerprint: "stale".into(),
                ..confirmation.clone()
            },
            HostKeyChange {
                received_fingerprint: "different".into(),
                ..confirmation.clone()
            },
        ] {
            assert!(
                matches!(hosts.check_or_trust_confirmed("host-a:22", "new", Some(&wrong)),
                Err(RunnerError::HostKeyMismatch(change)) if change == confirmation)
            );
            assert_eq!(
                std::fs::read(root.join("known_hosts.json")).unwrap(),
                original
            );
        }
        // A third key seen during the retry must never be accepted by the old approval.
        assert!(hosts
            .check_or_trust_confirmed("host-a:22", "third", Some(&confirmation))
            .is_err());
        hosts
            .check_or_trust_confirmed("host-a:22", "new", Some(&confirmation))
            .unwrap();
        let saved: HashMap<String, String> =
            serde_json::from_slice(&std::fs::read(root.join("known_hosts.json")).unwrap()).unwrap();
        assert_eq!(saved["host-a:22"], "new");
        assert_eq!(saved["host-b:22"], "other");
        // Another connection can have updated the saved key while a prompt was open.
        assert!(
            matches!(hosts.check_or_trust_confirmed("host-a:22", "third", Some(&confirmation)),
            Err(RunnerError::HostKeyMismatch(change)) if change.saved_fingerprint == "new")
        );
        assert!(hosts.check_or_trust("host-a:22", "old").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn confirmation_cannot_recreate_missing_or_overwrite_broken_trust_store() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let mut hosts = KnownHosts::load(&root);
        let confirmation = HostKeyChange {
            addr: "host:22".into(),
            saved_fingerprint: "old".into(),
            received_fingerprint: "new".into(),
        };
        assert!(hosts
            .check_or_trust_confirmed("host:22", "new", Some(&confirmation))
            .is_err());
        assert!(!root.exists());
        hosts.check_or_trust("host:22", "old").unwrap();
        let path = root.join("known_hosts.json");
        std::fs::write(&path, "broken json").unwrap();
        assert!(matches!(
            hosts.check_or_trust_confirmed("host:22", "new", Some(&confirmation)),
            Err(RunnerError::InvalidInput(_))
        ));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "broken json");
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(matches!(
            hosts.check_or_trust_confirmed("host:22", "new", Some(&confirmation)),
            Err(RunnerError::Io(_))
        ));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn ssh_handshake_preserves_key_change_and_only_authenticates_after_confirmation() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        #[derive(Clone)]
        struct Server(Arc<AtomicUsize>);
        impl russh::server::Handler for Server {
            type Error = russh::Error;
            async fn auth_password(
                &mut self,
                _: &str,
                _: &str,
            ) -> std::result::Result<russh::server::Auth, Self::Error> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Ok(russh::server::Auth::Accept)
            }
        }
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let device: DeviceProfile = serde_json::from_value(serde_json::json!({
            "id": "test", "name": "test", "host": "127.0.0.1", "port": port,
            "username": "test", "auth": { "type": "password", "password": "test" }
        }))
        .unwrap();
        KnownHosts::load(&root)
            .check_or_trust(&device.addr(), "old")
            .unwrap();
        let key = russh::keys::PrivateKey::new(
            russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[73; 32]).into(),
            "test",
        )
        .unwrap();
        let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        let config = Arc::new(russh::server::Config {
            keys: vec![key],
            ..Default::default()
        });
        let authentications = Arc::new(AtomicUsize::new(0));
        let fixture = Server(authentications.clone());
        let server = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let config = config.clone();
                let fixture = fixture.clone();
                connections.spawn(async move {
                    if let Ok(connection) = russh::server::run_stream(config, stream, fixture).await
                    {
                        let _ = connection.await;
                    }
                });
            }
        });
        let change = match SshConnection::connect(&device, &root).await {
            Err(RunnerError::HostKeyMismatch(change)) => change,
            _ => panic!("expected the original host key mismatch, not UnknownKey"),
        };
        assert_eq!(change.addr, device.addr());
        assert_eq!(change.saved_fingerprint, "old");
        assert_eq!(change.received_fingerprint, fingerprint);
        assert_eq!(authentications.load(Ordering::SeqCst), 0);
        let connection = SshConnection::connect_confirmed(&device, &root, Some(change))
            .await
            .unwrap();
        assert_eq!(authentications.load(Ordering::SeqCst), 1);
        drop(connection);
        std::fs::write(root.join("known_hosts.json"), "broken json").unwrap();
        assert!(matches!(
            SshConnection::connect(&device, &root).await,
            Err(RunnerError::InvalidInput(_))
        ));
        assert_eq!(authentications.load(Ordering::SeqCst), 1);
        server.abort();
        let _ = server.await;
        std::fs::remove_dir_all(root).unwrap();
    }
}

// All connections must read/check/write the same trust store under one lock.
static KNOWN_HOSTS_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

impl KnownHosts {
    pub fn load(config_dir: &Path) -> Self {
        let path = config_dir.join("known_hosts.json");
        Self { path }
    }

    /// 校验或记录 host key 指纹，返回 Ok(true) 表示接受连接
    pub fn check_or_trust(&mut self, addr: &str, fingerprint: &str) -> Result<bool> {
        self.check_or_trust_confirmed(addr, fingerprint, None)
    }

    /// A confirmation only authorizes the exact address and old/new pair shown to the user.
    fn check_or_trust_confirmed(
        &mut self,
        addr: &str,
        fingerprint: &str,
        confirmation: Option<&HostKeyChange>,
    ) -> Result<bool> {
        let _guard = KNOWN_HOSTS_LOCK.lock();
        let mut map: HashMap<String, String> = match std::fs::read_to_string(&self.path) {
            Ok(data) => serde_json::from_str(&data)
                .map_err(|e| RunnerError::InvalidInput(format!("invalid known_hosts.json: {e}")))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(e) => return Err(e.into()),
        };
        match map.get(addr) {
            Some(saved) if saved == fingerprint => return Ok(true),
            Some(saved) => {
                let change = HostKeyChange {
                    addr: addr.to_string(),
                    saved_fingerprint: saved.clone(),
                    received_fingerprint: fingerprint.to_string(),
                };
                if confirmation != Some(&change) {
                    return Err(RunnerError::HostKeyMismatch(change));
                }
            }
            None if confirmation.is_some() => {
                return Err(RunnerError::InvalidInput(
                    "saved SSH host key was removed; test the connection again".into(),
                ));
            }
            None => {}
        }
        map.insert(addr.to_string(), fingerprint.to_string());
        let data = serde_json::to_string_pretty(&map)
            .map_err(|e| RunnerError::InvalidInput(e.to_string()))?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&self.path, data)?;
        Ok(true)
    }
}

pub struct ClientHandler {
    addr: String,
    known_hosts: Arc<parking_lot::Mutex<KnownHosts>>,
    confirmation: Option<HostKeyChange>,
}

impl client::Handler for ClientHandler {
    type Error = RunnerError;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        use russh::keys::PublicKeyOrCertificate;
        let fingerprint = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => {
                key.fingerprint(HashAlg::Sha256).to_string()
            }
            PublicKeyOrCertificate::Certificate { .. } => {
                return Err(RunnerError::Ssh(
                    "SSH host certificates are not supported".into(),
                ));
            }
        };
        tracing::info!("host key for {}: {}", self.addr, fingerprint);
        let confirmation = self.confirmation.take();
        self.known_hosts.lock().check_or_trust_confirmed(
            &self.addr,
            &fingerprint,
            confirmation.as_ref(),
        )
    }
}

/// 已认证的 SSH 连接（Arc 句柄；克隆共享同一连接，channel 各自独立）
#[derive(Clone)]
pub struct SshConnection {
    pub handle: Arc<Handle<ClientHandler>>,
}

impl SshConnection {
    pub async fn connect(device: &DeviceProfile, config_dir: &Path) -> Result<Self> {
        Self::connect_confirmed(device, config_dir, None).await
    }

    pub async fn connect_confirmed(
        device: &DeviceProfile,
        config_dir: &Path,
        confirmation: Option<HostKeyChange>,
    ) -> Result<Self> {
        if confirmation
            .as_ref()
            .is_some_and(|change| change.addr != device.addr())
        {
            return Err(RunnerError::InvalidInput(
                "SSH host key confirmation does not match the device address".into(),
            ));
        }
        let config = Arc::new(Config {
            inactivity_timeout: None,
            keepalive_interval: Some(Duration::from_secs(30)),
            ..Default::default()
        });

        let known_hosts = Arc::new(parking_lot::Mutex::new(KnownHosts::load(config_dir)));
        let handler = ClientHandler {
            addr: device.addr(),
            known_hosts,
            confirmation,
        };

        let mut handle = tokio::time::timeout(
            Duration::from_secs(10),
            client::connect(config, device.addr(), handler),
        )
        .await
        .map_err(|_| RunnerError::Ssh(format!("connect to {} timed out", device.addr())))??;

        tokio::time::timeout(
            Duration::from_secs(20),
            Self::authenticate(&mut handle, device),
        )
        .await
        .map_err(|_| RunnerError::Ssh("authentication timed out".into()))??;
        Ok(Self {
            handle: Arc::new(handle),
        })
    }

    async fn authenticate(
        handle: &mut Handle<ClientHandler>,
        device: &DeviceProfile,
    ) -> Result<()> {
        let auth_err = || RunnerError::AuthFailed(device.username.clone());
        match &device.auth {
            AuthMethod::Password { password } => {
                let res = handle
                    .authenticate_password(&device.username, password)
                    .await?;
                if res.success() {
                    return Ok(());
                }
                Err(auth_err())
            }
            AuthMethod::Key { key_path } => {
                // 1. 优先尝试 ssh-agent（Windows OpenSSH named pipe / unix SSH_AUTH_SOCK）
                if let Err(e) = Self::authenticate_via_agent(handle, &device.username).await {
                    tracing::info!("agent auth unavailable: {e}");
                } else {
                    return Ok(());
                }

                // 2. 尝试本地私钥文件
                let mut candidates: Vec<PathBuf> = Vec::new();
                if let Some(p) = key_path {
                    candidates.push(PathBuf::from(p));
                } else if let Some(home) = dirs::home_dir() {
                    let ssh_dir = home.join(".ssh");
                    candidates.push(ssh_dir.join("id_ed25519"));
                    candidates.push(ssh_dir.join("id_rsa"));
                    candidates.push(ssh_dir.join("id_ecdsa"));
                }
                for path in candidates {
                    if !path.exists() {
                        continue;
                    }
                    let key = match russh::keys::load_secret_key(&path, None) {
                        Ok(k) => k,
                        Err(e) => {
                            tracing::warn!("failed to load key {}: {}", path.display(), e);
                            continue;
                        }
                    };
                    let res = handle
                        .authenticate_publickey(
                            &device.username,
                            russh::keys::PrivateKeyWithHashAlg::new(Arc::new(key), None),
                        )
                        .await?;
                    if res.success() {
                        return Ok(());
                    }
                }
                Err(auth_err())
            }
        }
    }

    /// 通过 ssh-agent 中的身份依次尝试认证，成功返回 Ok(())
    async fn authenticate_via_agent(
        handle: &mut Handle<ClientHandler>,
        username: &str,
    ) -> Result<()> {
        use russh::keys::agent::client::AgentClient;

        #[cfg(windows)]
        let agent = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")
            .await
            .map_err(|e| RunnerError::Ssh(format!("openssh agent pipe: {e}")))?
            .dynamic();

        #[cfg(unix)]
        let agent = AgentClient::connect_env()
            .await
            .map_err(|e| RunnerError::Ssh(format!("ssh agent: {e}")))?
            .dynamic();

        #[cfg(not(any(windows, unix)))]
        return Err(RunnerError::Ssh("agent not supported".into()));

        let mut agent = agent;
        let identities = agent
            .request_identities()
            .await
            .map_err(|e| RunnerError::Ssh(format!("agent identities: {e}")))?;
        for identity in identities {
            let key = identity.public_key().clone().into_owned();
            match handle
                .authenticate_publickey_with(username, key, None, &mut agent)
                .await
            {
                Ok(res) if res.success() => return Ok(()),
                Ok(_) => continue,
                Err(e) => {
                    tracing::debug!("agent key rejected: {e}");
                    continue;
                }
            }
        }
        Err(RunnerError::AuthFailed(format!("{username} (agent)")))
    }
}
