use super::host::Host;
use super::*;

struct Temp(std::path::PathBuf);
impl Temp {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("rr-transfer-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn duplicate_names_preserve_extension_and_directory() {
    assert_eq!(sibling("dir/a.tar.gz", 2), "dir/a.tar (2).gz");
    assert_eq!(sibling(".config", 1), ".config (1)");
    assert_eq!(sibling("empty", 1), "empty (1)");
}

#[test]
fn invalid_relative_paths_never_reach_hosts() {
    for path in [
        "../escape",
        "/absolute",
        "C:stream",
        "a\\b",
        "a/../b",
        "a//b",
        "nul.txt",
        "a\0b",
    ] {
        assert!(relative(path).is_err(), "{path}");
    }
    assert!(relative(&vec!["a"; 65].join("/")).is_err());
}

#[tokio::test]
async fn binary_stream_and_publication_never_clobber_existing_target() {
    let temp = Temp::new();
    let endpoint = WorkspaceRef::local(temp.0.to_string_lossy());
    let mut host = Host::open(&endpoint, None, &temp.0).await.unwrap();
    let bytes = [0, 255, 13, 10, 128, 0];
    let mut writer = host.create_temp(".rr-transfer-owned.part").await.unwrap();
    host.write(&mut writer, 0, bytes.to_vec()).await.unwrap();
    let attrs = host.close(writer, true, None).await.unwrap();
    assert_eq!(attrs.size, 6);
    std::fs::write(temp.0.join("target.bin"), b"original").unwrap();
    assert!(host
        .commit(".rr-transfer-owned.part", "target.bin", false, &None)
        .await
        .is_err());
    assert_eq!(
        std::fs::read(temp.0.join("target.bin")).unwrap(),
        b"original"
    );
    host.commit(".rr-transfer-owned.part", "copy.bin", false, &None)
        .await
        .unwrap();
    let (mut reader, _) = host.open_read("copy.bin").await.unwrap();
    assert_eq!(host.read(&mut reader, 0).await.unwrap(), bytes);
    host.close(reader, false, None).await.unwrap();
}

#[tokio::test]
async fn edited_target_is_not_overwritten_and_empty_directories_are_retained() {
    let temp = Temp::new();
    let mut host = Host::open(
        &WorkspaceRef::local(temp.0.to_string_lossy()),
        None,
        &temp.0,
    )
    .await
    .unwrap();
    host.mkdir("empty").await.unwrap();
    host.mkdir("empty").await.unwrap();
    std::fs::write(temp.0.join("target"), b"old").unwrap();
    let expected = host.stat("target").await.unwrap();
    let mut writer = host.create_temp(".rr-transfer-owned.part").await.unwrap();
    host.write(&mut writer, 0, b"new".to_vec()).await.unwrap();
    host.close(writer, true, None).await.unwrap();
    std::fs::write(temp.0.join("target"), b"changed").unwrap();
    assert!(host
        .commit(".rr-transfer-owned.part", "target", true, &expected)
        .await
        .is_err());
    assert_eq!(std::fs::read(temp.0.join("target")).unwrap(), b"changed");
    assert!(temp.0.join("empty").is_dir());
}

#[tokio::test]
async fn transfer_limits_do_not_change_editor_or_run_limits() {
    let temp = Temp::new();
    let file = std::fs::File::create(temp.0.join("large.bin")).unwrap();
    file.set_len(65 * 1024 * 1024).unwrap();
    let mut host = Host::open(
        &WorkspaceRef::local(temp.0.to_string_lossy()),
        None,
        &temp.0,
    )
    .await
    .unwrap();
    let (reader, attrs) = host.open_read("large.bin").await.unwrap();
    assert_eq!(attrs.size, 65 * 1024 * 1024);
    host.close(reader, false, None).await.unwrap();
    assert_eq!(crate::workspace::FILE_LIMIT, 1024 * 1024);
    assert_eq!(crate::workspace_upload::SSH.file_limit, 64 * 1024 * 1024);
}

#[tokio::test]
#[ignore = "opt in with REMOTE_RUNNER_TEST_WSL, uses only uniquely named test directories"]
async fn wsl_binary_round_trip_large_files_conflicts_and_alias_guard() {
    use crate::device::{DeviceProfile, DeviceStore, WslConfig};
    let distribution = std::env::var("REMOTE_RUNNER_TEST_WSL").expect("choose a test distribution");
    let local = Temp::new();
    let target = Temp::new();
    let config = Temp::new();
    let remote = format!("/tmp/rr-file-transfer-test-{}", uuid::Uuid::new_v4());
    let wsl = WslConfig {
        distribution,
        user: String::new(),
    };
    let mut command = crate::wsl::wsl_command().unwrap();
    command.args([
        "--distribution",
        &wsl.distribution,
        "--exec",
        "python3",
        "-I",
        "-c",
        "import os,sys; os.mkdir(sys.argv[1])",
        &remote,
    ]);
    assert!(command.status().await.unwrap().success());
    DeviceStore::new(&config.0)
        .save(DeviceProfile {
            id: "wsl-test".into(),
            name: "WSL test".into(),
            is_default: true,
            transport: crate::device::TransportKind::Wsl,
            host: String::new(),
            port: 22,
            username: String::new(),
            auth: crate::device::AuthMethod::Password {
                password: String::new(),
            },
            workspace_root: remote.clone(),
            serial: None,
            wsl: Some(wsl.clone()),
            local: None,
        })
        .unwrap();
    let manager = TransferManager::new(&config.0);
    let local_endpoint = WorkspaceRef::local(local.0.to_string_lossy());
    let target_endpoint = WorkspaceRef::local(target.0.to_string_lossy());
    let remote_endpoint = WorkspaceRef::device("wsl-test", &remote);
    std::fs::create_dir(local.0.join("dir")).unwrap();
    std::fs::create_dir(local.0.join("dir/empty")).unwrap();
    std::fs::write(local.0.join("dir/中文.bin"), b"\0\xff\r\n\x80").unwrap();
    std::fs::write(local.0.join("dir/.config"), b"hidden").unwrap();
    std::fs::File::create(local.0.join("large.bin"))
        .unwrap()
        .set_len(65 * 1024 * 1024)
        .unwrap();
    async fn run(
        manager: &TransferManager,
        source: WorkspaceRef,
        target: WorkspaceRef,
        paths: &[&str],
        policy: ConflictPolicy,
    ) -> Task {
        let plan = manager
            .plan(Request {
                source,
                target,
                paths: paths.iter().map(|p| (*p).into()).collect(),
                exclude_project_files: false,
                protected_paths: vec![],
            })
            .await
            .unwrap();
        let id = manager.start(&plan.id, policy, false).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(180), async {
            loop {
                let task = manager.task(&id).unwrap();
                if !active(&task.state) {
                    return task;
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        })
        .await
        .unwrap()
    }
    let task = run(
        &manager,
        local_endpoint.clone(),
        remote_endpoint.clone(),
        &["dir", "large.bin"],
        ConflictPolicy::KeepBoth,
    )
    .await;
    assert_eq!(task.state, "completed", "{:?}", task.error);
    assert!(task.residuals.is_empty(), "{:?}", task.warnings);
    let task = run(
        &manager,
        remote_endpoint.clone(),
        target_endpoint.clone(),
        &["dir", "large.bin"],
        ConflictPolicy::KeepBoth,
    )
    .await;
    assert_eq!(task.state, "completed", "{:?}", task.error);
    assert_eq!(
        std::fs::read(target.0.join("dir/中文.bin")).unwrap(),
        b"\0\xff\r\n\x80"
    );
    assert_eq!(
        std::fs::read(target.0.join("dir/.config")).unwrap(),
        b"hidden"
    );
    assert!(target.0.join("dir/empty").is_dir());
    assert_eq!(
        std::fs::metadata(target.0.join("large.bin")).unwrap().len(),
        65 * 1024 * 1024
    );
    std::fs::write(local.0.join("dir/中文.bin"), b"changed").unwrap();
    let task = run(
        &manager,
        local_endpoint.clone(),
        remote_endpoint.clone(),
        &["dir/中文.bin"],
        ConflictPolicy::KeepBoth,
    )
    .await;
    assert_eq!(task.state, "completed", "{:?}", task.error);
    let task = run(
        &manager,
        local_endpoint.clone(),
        remote_endpoint.clone(),
        &["dir/中文.bin"],
        ConflictPolicy::Overwrite,
    )
    .await;
    assert_eq!(task.state, "completed", "{:?}", task.error);
    let task = run(
        &manager,
        remote_endpoint.clone(),
        target_endpoint,
        &["dir/中文.bin"],
        ConflictPolicy::Overwrite,
    )
    .await;
    assert_eq!(task.state, "completed", "{:?}", task.error);
    assert_eq!(
        std::fs::read(target.0.join("dir/中文.bin")).unwrap(),
        b"changed"
    );
    // WSL aliasing a Windows source directory must be rejected before copying.
    let windows = local.0.to_string_lossy().replace('\\', "/");
    if windows.as_bytes().get(1) == Some(&b':') {
        let posix = format!(
            "/mnt/{}/{}",
            &windows[..1].to_lowercase(),
            windows[3..].trim_start_matches('/')
        );
        assert!(manager
            .plan(Request {
                source: local_endpoint,
                target: WorkspaceRef::device("wsl-test", posix),
                paths: vec!["dir".into()],
                exclude_project_files: false,
                protected_paths: vec![]
            })
            .await
            .is_err());
    }
    let mut cleanup = crate::wsl::wsl_command().unwrap();
    cleanup.args(["--distribution", &wsl.distribution, "--exec", "python3", "-I", "-c", "import shutil,sys; p=sys.argv[1]; assert p.startswith('/tmp/rr-file-transfer-test-'); shutil.rmtree(p)", &remote]);
    assert!(cleanup.status().await.unwrap().success());
}
