//! Real SSH + SFTP on loopback. No physical device or user SSH credentials.
use remote_runner::{
    device::{AuthMethod, DeviceProfile, DeviceStore},
    file_transfer::{ConflictPolicy, Request, Task, TransferManager},
    workspace_ref::WorkspaceRef,
};
use russh::{server, Channel, ChannelId};
use russh_sftp::protocol::{self as p, StatusCode};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

#[derive(Clone, Default)]
struct Behavior {
    no_overwrite: bool,
    no_hardlink: bool,
    fail_write: bool,
    disconnect_commit: bool,
    slow: bool,
}

struct Sftp {
    root: PathBuf,
    behavior: Behavior,
    handles: HashMap<String, fs::File>,
    dirs: HashMap<String, PathBuf>,
    read_dirs: HashSet<String>,
    disconnect: Arc<tokio::sync::Notify>,
}
fn status(id: u32) -> p::Status {
    p::Status {
        id,
        status_code: StatusCode::Ok,
        error_message: String::new(),
        language_tag: "en".into(),
    }
}
fn io(e: std::io::Error) -> StatusCode {
    match e.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NoSuchFile,
        std::io::ErrorKind::PermissionDenied => StatusCode::PermissionDenied,
        _ => StatusCode::Failure,
    }
}
fn attributes(meta: &fs::Metadata) -> p::FileAttributes {
    let mut a = p::FileAttributes::empty();
    a.size = Some(meta.len());
    a.permissions = Some(if meta.is_dir() { 0o040700 } else { 0o100600 });
    a.mtime = Some(
        meta.modified()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as u32,
    );
    a.uid = Some(1000);
    a.gid = Some(1000);
    a
}
impl Sftp {
    fn path(&self, path: &str) -> Result<PathBuf, StatusCode> {
        if !path.starts_with("/data") || path.contains("..") {
            return Err(StatusCode::PermissionDenied);
        }
        Ok(self
            .root
            .join(path.trim_start_matches("/data").trim_start_matches('/')))
    }
}
impl russh_sftp::server::Handler for Sftp {
    type Error = StatusCode;
    fn unimplemented(&self) -> StatusCode {
        StatusCode::OpUnsupported
    }
    async fn init(&mut self, _: u32, _: HashMap<String, String>) -> Result<p::Version, StatusCode> {
        let mut version = p::Version::new();
        if !self.behavior.no_hardlink {
            version
                .extensions
                .insert("hardlink@openssh.com".into(), "1".into());
        }
        if !self.behavior.no_overwrite {
            version
                .extensions
                .insert("posix-rename@openssh.com".into(), "1".into());
        }
        Ok(version)
    }
    async fn realpath(&mut self, id: u32, path: String) -> Result<p::Name, StatusCode> {
        let path = if path == "." {
            "/data".to_string()
        } else {
            path
        };
        let actual = self.path(&path)?;
        fs::metadata(actual).map_err(io)?;
        Ok(p::Name {
            id,
            files: vec![p::File::dummy(path)],
        })
    }
    async fn lstat(&mut self, id: u32, path: String) -> Result<p::Attrs, StatusCode> {
        Ok(p::Attrs {
            id,
            attrs: attributes(&fs::symlink_metadata(self.path(&path)?).map_err(io)?),
        })
    }
    async fn opendir(&mut self, id: u32, path: String) -> Result<p::Handle, StatusCode> {
        let actual = self.path(&path)?;
        fs::read_dir(&actual).map_err(io)?;
        let handle = uuid::Uuid::new_v4().to_string();
        self.dirs.insert(handle.clone(), actual);
        Ok(p::Handle { id, handle })
    }
    async fn readdir(&mut self, id: u32, handle: String) -> Result<p::Name, StatusCode> {
        if !self.read_dirs.insert(handle.clone()) {
            return Err(StatusCode::Eof);
        }
        let entries =
            fs::read_dir(self.dirs.get(&handle).ok_or(StatusCode::Failure)?).map_err(io)?;
        let mut files = Vec::new();
        for entry in entries {
            let entry = entry.map_err(io)?;
            files.push(p::File::new(
                entry.file_name().to_string_lossy(),
                attributes(&entry.metadata().map_err(io)?),
            ));
        }
        Ok(p::Name { id, files })
    }
    async fn open(
        &mut self,
        id: u32,
        path: String,
        flags: p::OpenFlags,
        _: p::FileAttributes,
    ) -> Result<p::Handle, StatusCode> {
        let mut options = fs::OpenOptions::new();
        options
            .read(flags.contains(p::OpenFlags::READ))
            .write(flags.contains(p::OpenFlags::WRITE));
        if flags.contains(p::OpenFlags::EXCLUDE) {
            options.create_new(true);
        }
        let file = options.open(self.path(&path)?).map_err(io)?;
        let handle = uuid::Uuid::new_v4().to_string();
        self.handles.insert(handle.clone(), file);
        Ok(p::Handle { id, handle })
    }
    async fn fstat(&mut self, id: u32, handle: String) -> Result<p::Attrs, StatusCode> {
        Ok(p::Attrs {
            id,
            attrs: attributes(
                &self
                    .handles
                    .get(&handle)
                    .ok_or(StatusCode::Failure)?
                    .metadata()
                    .map_err(io)?,
            ),
        })
    }
    async fn fsetstat(
        &mut self,
        id: u32,
        _: String,
        _: p::FileAttributes,
    ) -> Result<p::Status, StatusCode> {
        Ok(status(id))
    }
    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<p::Data, StatusCode> {
        let file = self.handles.get_mut(&handle).ok_or(StatusCode::Failure)?;
        file.seek(SeekFrom::Start(offset)).map_err(io)?;
        let mut data = vec![0; len as usize];
        let n = file.read(&mut data).map_err(io)?;
        if n == 0 {
            return Err(StatusCode::Eof);
        }
        data.truncate(n);
        Ok(p::Data { id, data })
    }
    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<p::Status, StatusCode> {
        if self.behavior.fail_write {
            return Err(StatusCode::PermissionDenied);
        }
        if self.behavior.slow {
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        let file = self.handles.get_mut(&handle).ok_or(StatusCode::Failure)?;
        file.seek(SeekFrom::Start(offset)).map_err(io)?;
        file.write_all(&data).map_err(io)?;
        Ok(status(id))
    }
    async fn close(&mut self, id: u32, handle: String) -> Result<p::Status, StatusCode> {
        self.handles.remove(&handle);
        self.dirs.remove(&handle);
        Ok(status(id))
    }
    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _: p::FileAttributes,
    ) -> Result<p::Status, StatusCode> {
        fs::create_dir(self.path(&path)?).map_err(io)?;
        Ok(status(id))
    }
    async fn remove(&mut self, id: u32, path: String) -> Result<p::Status, StatusCode> {
        fs::remove_file(self.path(&path)?).map_err(io)?;
        Ok(status(id))
    }
    async fn extended(
        &mut self,
        id: u32,
        request: String,
        data: Vec<u8>,
    ) -> Result<p::Packet, StatusCode> {
        let mut bytes = data.as_slice();
        let mut string = || -> Result<String, StatusCode> {
            if bytes.len() < 4 {
                return Err(StatusCode::Failure);
            }
            let len = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
            bytes = &bytes[4..];
            if bytes.len() < len {
                return Err(StatusCode::Failure);
            }
            let path = String::from_utf8(bytes[..len].to_vec()).map_err(|_| StatusCode::Failure)?;
            bytes = &bytes[len..];
            Ok(path)
        };
        let source = self.path(&string()?)?;
        let target = self.path(&string()?)?;
        match request.as_str() {
            "hardlink@openssh.com" if !self.behavior.no_hardlink => {
                fs::hard_link(source, target).map_err(io)?
            }
            "posix-rename@openssh.com" if !self.behavior.no_overwrite => {
                fs::rename(source, target).map_err(io)?
            }
            _ => return Err(StatusCode::OpUnsupported),
        }
        if self.behavior.disconnect_commit {
            self.disconnect.notify_one();
            return std::future::pending().await;
        }
        Ok(p::Packet::Status(status(id)))
    }
}

struct Ssh {
    root: PathBuf,
    behavior: Behavior,
    channels: HashMap<ChannelId, Channel<server::Msg>>,
}
impl server::Handler for Ssh {
    type Error = russh::Error;
    async fn auth_password(&mut self, _: &str, _: &str) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if name != "sftp" {
            session.channel_failure(channel)?;
            return Ok(());
        }
        session.channel_success(channel)?;
        let channel = self.channels.remove(&channel).unwrap();
        let ssh_handle = session.handle();
        let channel_id = channel.id();
        let disconnect = Arc::new(tokio::sync::Notify::new());
        let handler = Sftp {
            root: self.root.clone(),
            behavior: self.behavior.clone(),
            handles: HashMap::new(),
            dirs: HashMap::new(),
            read_dirs: HashSet::new(),
            disconnect: disconnect.clone(),
        };
        let watch_disconnect = self.behavior.disconnect_commit;
        tokio::spawn(async move {
            // russh-sftp::server::run starts its own task and returns immediately.
            russh_sftp::server::run(channel.into_stream(), handler).await;
            if watch_disconnect {
                disconnect.notified().await;
                let _ = ssh_handle.close(channel_id).await;
            }
        });
        Ok(())
    }
}

struct Fixture {
    root: PathBuf,
    remote: PathBuf,
    local: PathBuf,
    config: PathBuf,
    listener: tokio::task::JoinHandle<()>,
}

#[tokio::test]
async fn runner_metadata_is_source_owned_and_survives_reopening_over_sftp() {
    use remote_runner::workspace_run::{Command, Config, Entry, Store};
    let fixture = Fixture::new(Behavior::default()).await;
    let device = DeviceStore::new(&fixture.config).get("test").unwrap();
    let workspace = WorkspaceRef::device("test", "/data");
    let mut store = Store::open(&workspace, Some(&device), &fixture.config)
        .await
        .unwrap();
    assert_eq!(store.commands().await.unwrap().revision, "missing");
    assert!(!fixture.remote.join(".runner").exists());
    let command = Command {
        entry: Entry::PythonModule {
            name: "app.cli".into(),
        },
        args: vec!["".into(), "汉字 a b".into()],
    };
    store.remember(command.clone(), None).await.unwrap();
    drop(store);
    let mut reopened = Store::open(&workspace, Some(&device), &fixture.config)
        .await
        .unwrap();
    reopened.remember(command.clone(), None).await.unwrap();
    let records = reopened.commands().await.unwrap();
    assert_eq!(records.entries.len(), 1);
    assert_eq!(records.entries[0].id, command.id());
    reopened
        .save_config(Config::default(), "missing")
        .await
        .unwrap();
    assert!(fixture.remote.join(".runner/config.json").exists());
    assert!(!fixture.local.join(".runner").exists());
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.listener.abort();
        let _ = fs::remove_dir_all(&self.root);
    }
}
impl Fixture {
    async fn new(behavior: Behavior) -> Self {
        let root = std::env::temp_dir().join(format!("rr-sftp-transfer-{}", uuid::Uuid::new_v4()));
        let remote = root.join("remote");
        let local = root.join("local");
        let config = root.join("config");
        for dir in [&remote, &local, &config] {
            fs::create_dir_all(dir).unwrap();
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let key = russh::keys::PrivateKey::new(
            russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[47; 32]).into(),
            "test",
        )
        .unwrap();
        let server_config = Arc::new(server::Config {
            keys: vec![key],
            ..Default::default()
        });
        let remote_root = remote.clone();
        let listener = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let config = server_config.clone();
                let root = remote_root.clone();
                let behavior = behavior.clone();
                tokio::spawn(async move {
                    let handler = Ssh {
                        root,
                        behavior,
                        channels: HashMap::new(),
                    };
                    if let Ok(connection) = server::run_stream(config, stream, handler).await {
                        let _ = connection.await;
                    }
                });
            }
        });
        DeviceStore::new(&config)
            .save(DeviceProfile {
                id: "test".into(),
                name: "Loopback".into(),
                is_default: true,
                transport: Default::default(),
                host: "127.0.0.1".into(),
                port,
                username: "test".into(),
                auth: AuthMethod::Password {
                    password: "test-only-password".into(),
                },
                workspace_root: "/data".into(),
                serial: None,
                wsl: None,
                local: None,
            })
            .unwrap();
        Self {
            root,
            remote,
            local,
            config,
            listener,
        }
    }
    fn request(&self, download: bool, paths: &[&str]) -> Request {
        let local = WorkspaceRef::local(self.local.to_string_lossy());
        let remote = WorkspaceRef::device("test", "/data");
        Request {
            source: if download {
                remote.clone()
            } else {
                local.clone()
            },
            target: if download { local } else { remote },
            paths: paths.iter().map(|p| (*p).into()).collect(),
            exclude_project_files: false,
            protected_paths: vec![],
        }
    }
}
async fn finish(manager: &TransferManager, id: &str) -> Task {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let task = manager.task(id).unwrap();
            if !remote_runner::file_transfer::active(&task.state) {
                return task;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("transfer should terminate")
}
async fn transfer(manager: &TransferManager, request: Request, policy: ConflictPolicy) -> Task {
    let plan = manager.plan(request).await.unwrap();
    let id = manager.start(&plan.id, policy, false).unwrap();
    finish(manager, &id).await
}

#[tokio::test]
async fn start_without_a_tokio_runtime_completes_upload_and_download() {
    let fixture = Fixture::new(Behavior::default()).await;
    let manager = TransferManager::new(&fixture.config);
    let data = (0..100_000).map(|i| (i % 256) as u8).collect::<Vec<_>>();
    for download in [false, true] {
        let name = if download {
            "download.bin"
        } else {
            "upload.bin"
        };
        let (source, target) = if download {
            (&fixture.remote, &fixture.local)
        } else {
            (&fixture.local, &fixture.remote)
        };
        fs::write(source.join(name), &data).unwrap();
        let plan = manager
            .plan(fixture.request(download, &[name]))
            .await
            .unwrap();
        let starter = manager.clone();
        // Synchronous Tauri IPC commands run on the UI thread without entering
        // Tokio. Ordinary tokio::test callers would conceal a tokio::spawn panic.
        let id = std::thread::spawn(move || {
            assert!(tokio::runtime::Handle::try_current().is_err());
            starter.start(&plan.id, ConflictPolicy::KeepBoth, false)
        })
        .join()
        .expect("starting a transfer outside Tokio must not panic")
        .unwrap();
        let task = finish(&manager, &id).await;
        assert_eq!(task.state, "completed", "{:?}", task.error);
        assert!(task.residuals.is_empty());
        assert_eq!(fs::read(target.join(name)).unwrap(), data);
    }
    manager.cancel_all().await.unwrap();
}

#[tokio::test]
async fn ssh_binary_directories_and_all_conflict_modes_round_trip() {
    let fixture = Fixture::new(Behavior::default()).await;
    let manager = TransferManager::new(&fixture.config);
    fs::create_dir(fixture.local.join("目录 space")).unwrap();
    fs::create_dir(fixture.local.join("目录 space/empty")).unwrap();
    let data = (0..180_000).map(|i| (i % 256) as u8).collect::<Vec<_>>();
    fs::write(fixture.local.join("目录 space/data.bin"), &data).unwrap();
    fs::write(fixture.local.join("目录 space/.config"), b"a\r\n\0\xff").unwrap();
    let task = transfer(
        &manager,
        fixture.request(false, &["目录 space"]),
        ConflictPolicy::KeepBoth,
    )
    .await;
    assert_eq!(task.state, "completed", "{:?}", task.error);
    assert!(task.residuals.is_empty());
    assert_eq!(
        fs::read(fixture.remote.join("目录 space/data.bin")).unwrap(),
        data
    );
    assert!(fixture.remote.join("目录 space/empty").is_dir());
    fs::write(fixture.local.join("目录 space/data.bin"), b"new").unwrap();
    let task = transfer(
        &manager,
        fixture.request(false, &["目录 space/data.bin"]),
        ConflictPolicy::KeepBoth,
    )
    .await;
    assert_eq!(task.state, "completed", "{:?}", task.error);
    assert_eq!(
        fs::read(fixture.remote.join("目录 space/data (1).bin")).unwrap(),
        b"new"
    );
    let task = transfer(
        &manager,
        fixture.request(false, &["目录 space/data.bin"]),
        ConflictPolicy::Skip,
    )
    .await;
    assert_eq!(task.items[0].state, "skipped");
    assert_eq!(
        fs::read(fixture.remote.join("目录 space/data.bin")).unwrap(),
        data
    );
    let task = transfer(
        &manager,
        fixture.request(false, &["目录 space/data.bin"]),
        ConflictPolicy::Overwrite,
    )
    .await;
    assert_eq!(task.state, "completed", "{:?}", task.error);
    assert_eq!(
        fs::read(fixture.remote.join("目录 space/data.bin")).unwrap(),
        b"new"
    );
    let task = transfer(
        &manager,
        fixture.request(true, &["目录 space/.config"]),
        ConflictPolicy::KeepBoth,
    )
    .await;
    assert_eq!(task.state, "completed", "{:?}", task.error);
    assert_eq!(
        fs::read(fixture.local.join("目录 space/.config (1)")).unwrap(),
        b"a\r\n\0\xff"
    );
    assert!(!fs::read_to_string(fixture.config.join("transfers.json"))
        .unwrap()
        .contains("test-only-password"));
}

#[tokio::test]
async fn home_roots_resolve_to_the_sftp_login_directory() {
    let fixture = Fixture::new(Behavior::default()).await;
    fs::create_dir_all(fixture.remote.join("devrunner/workspaces")).unwrap();
    fs::write(
        fixture.remote.join("devrunner/workspaces/data.bin"),
        b"hello",
    )
    .unwrap();
    let directory = TransferManager::new(&fixture.config)
        .list(WorkspaceRef::device("test", "~/devrunner/workspaces"))
        .await
        .unwrap();
    assert_eq!(
        directory.endpoint,
        WorkspaceRef::device("test", "/data/devrunner/workspaces")
    );
    assert!(directory
        .entries
        .iter()
        .any(|entry| entry.name == "data.bin"));
}

#[tokio::test]
async fn source_and_target_changes_are_rejected_before_publication() {
    let fixture = Fixture::new(Behavior::default()).await;
    let manager = TransferManager::new(&fixture.config);
    fs::write(fixture.local.join("a.bin"), b"old").unwrap();
    let plan = manager
        .plan(fixture.request(false, &["a.bin"]))
        .await
        .unwrap();
    fs::write(fixture.local.join("a.bin"), b"changed").unwrap();
    let id = manager
        .start(&plan.id, ConflictPolicy::KeepBoth, false)
        .unwrap();
    assert_eq!(finish(&manager, &id).await.items[0].state, "failed");
    assert!(!fixture.remote.join("a.bin").exists());
    fs::write(fixture.remote.join("a.bin"), b"target").unwrap();
    let plan = manager
        .plan(fixture.request(false, &["a.bin"]))
        .await
        .unwrap();
    fs::write(fixture.remote.join("a.bin"), b"external change").unwrap();
    let id = manager
        .start(&plan.id, ConflictPolicy::Overwrite, false)
        .unwrap();
    assert_eq!(finish(&manager, &id).await.items[0].state, "failed");
    assert_eq!(
        fs::read(fixture.remote.join("a.bin")).unwrap(),
        b"external change"
    );
}

#[tokio::test]
async fn missing_extensions_and_permission_errors_preserve_originals() {
    for behavior in [
        Behavior {
            no_overwrite: true,
            ..Default::default()
        },
        Behavior {
            no_hardlink: true,
            ..Default::default()
        },
        Behavior {
            fail_write: true,
            ..Default::default()
        },
    ] {
        let fixture = Fixture::new(behavior.clone()).await;
        let manager = TransferManager::new(&fixture.config);
        fs::write(fixture.local.join("a.bin"), b"new").unwrap();
        fs::write(fixture.remote.join("a.bin"), b"old").unwrap();
        let plan = manager
            .plan(fixture.request(false, &["a.bin"]))
            .await
            .unwrap();
        if behavior.no_overwrite {
            assert!(!plan.overwrite);
            assert!(manager
                .start(&plan.id, ConflictPolicy::Overwrite, false)
                .is_err());
        } else if behavior.no_hardlink {
            assert!(!plan.keep_both);
            assert!(manager
                .start(&plan.id, ConflictPolicy::KeepBoth, false)
                .is_err());
        } else {
            let id = manager
                .start(&plan.id, ConflictPolicy::KeepBoth, false)
                .unwrap();
            let task = finish(&manager, &id).await;
            assert_ne!(task.state, "completed");
            assert!(task.residuals.is_empty(), "{:?}", task.residuals);
        }
        assert_eq!(fs::read(fixture.remote.join("a.bin")).unwrap(), b"old");
    }
}

#[tokio::test]
async fn cancellation_keeps_completed_files_and_retry_omits_them() {
    let fixture = Fixture::new(Behavior {
        slow: true,
        ..Default::default()
    })
    .await;
    let manager = TransferManager::new(&fixture.config);
    fs::write(fixture.local.join("a.bin"), b"first").unwrap();
    fs::write(fixture.local.join("b.bin"), vec![7; 2 * 1024 * 1024]).unwrap();
    let plan = manager
        .plan(fixture.request(false, &["a.bin", "b.bin"]))
        .await
        .unwrap();
    let id = manager
        .start(&plan.id, ConflictPolicy::KeepBoth, false)
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while manager.task(&id).unwrap().transferred_bytes < 1000 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    manager.cancel(&id).unwrap();
    let task = finish(&manager, &id).await;
    assert_eq!(task.state, "canceled");
    assert_eq!(task.items[0].state, "completed");
    assert!(task.residuals.is_empty());
    assert!(!fixture.remote.join("b.bin").exists());
    let plan = manager.retry(&id).await.unwrap();
    assert_eq!(plan.request.paths, ["b.bin"]);
    assert!(manager.task(&id).unwrap().superseded_by.is_none());
    manager.discard_plan(&plan.id);
    assert!(manager.task(&id).unwrap().superseded_by.is_none());
    let plan = manager.retry(&id).await.unwrap();
    let competing = manager.retry(&id).await.unwrap();
    let retry = manager
        .start(&plan.id, ConflictPolicy::KeepBoth, false)
        .unwrap();
    assert_eq!(
        manager.task(&id).unwrap().superseded_by.as_deref(),
        Some(retry.as_str())
    );
    assert_eq!(
        manager.task(&retry).unwrap().retry_of.as_deref(),
        Some(id.as_str())
    );
    assert!(manager
        .start(&competing.id, ConflictPolicy::KeepBoth, false)
        .is_err());
    assert!(manager.retry(&id).await.is_err());
    let task = finish(&manager, &retry).await;
    assert_eq!(task.state, "completed", "{:?}", task.error);
    assert_eq!(task.items.len(), 1);
    assert_eq!(fs::read(fixture.remote.join("a.bin")).unwrap(), b"first");
    assert_eq!(
        fs::read(fixture.remote.join("b.bin")).unwrap(),
        vec![7; 2 * 1024 * 1024]
    );
    let restored = TransferManager::new(&fixture.config);
    assert_eq!(
        restored.task(&id).unwrap().superseded_by.as_deref(),
        Some(retry.as_str())
    );
    assert_eq!(
        restored.task(&retry).unwrap().retry_of.as_deref(),
        Some(id.as_str())
    );
}

#[tokio::test]
async fn retry_registration_failure_restores_the_original_attempt() {
    let fixture = Fixture::new(Behavior {
        fail_write: true,
        ..Default::default()
    })
    .await;
    let manager = TransferManager::new(&fixture.config);
    fs::write(fixture.local.join("flag.blend"), b"binary file").unwrap();
    let original = transfer(
        &manager,
        fixture.request(false, &["flag.blend"]),
        ConflictPolicy::KeepBoth,
    )
    .await;
    assert_eq!(original.state, "failed");
    let plan = manager.retry(&original.id).await.unwrap();
    let history = fixture.config.join("transfers.json");
    let before = fs::read(&history).unwrap();
    fs::remove_file(&history).unwrap();
    fs::create_dir(&history).unwrap();
    assert!(manager
        .start(&plan.id, ConflictPolicy::KeepBoth, false)
        .is_err());
    assert!(manager.task(&original.id).unwrap().superseded_by.is_none());
    assert_eq!(
        manager.task(&original.id).unwrap().sequence,
        original.sequence
    );
    assert_eq!(manager.snapshot().len(), 1);
    fs::remove_dir(&history).unwrap();
    fs::write(&history, before).unwrap();
    assert!(TransferManager::new(&fixture.config)
        .task(&original.id)
        .unwrap()
        .superseded_by
        .is_none());
}

#[tokio::test]
async fn lost_commit_ack_is_unknown_and_never_blindly_retried() {
    let fixture = Fixture::new(Behavior {
        disconnect_commit: true,
        ..Default::default()
    })
    .await;
    let manager = TransferManager::new(&fixture.config);
    fs::write(fixture.local.join("a.bin"), b"content").unwrap();
    let task = transfer(
        &manager,
        fixture.request(false, &["a.bin"]),
        ConflictPolicy::KeepBoth,
    )
    .await;
    assert_eq!(task.items[0].state, "unknown", "{:?}", task.items[0].error);
    assert_eq!(fs::read(fixture.remote.join("a.bin")).unwrap(), b"content");
    assert!(manager.retry(&task.id).await.is_err());
}
