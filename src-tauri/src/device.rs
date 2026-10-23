use crate::error::{Result, RunnerError};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

static DEVICE_OPERATIONS: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransportKind {
    #[default]
    Ssh,
    Serial,
    Wsl,
    Local,
}

impl TransportKind {
    pub fn capabilities(self) -> crate::process::Capabilities {
        crate::process::Capabilities {
            pipe: self != Self::Serial,
            resize: self != Self::Serial,
            interrupt: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WslConfig {
    pub distribution: String,
    /// Empty selects the distribution's default user.
    #[serde(default)]
    pub user: String,
}

impl WslConfig {
    pub fn validate(&self) -> Result<()> {
        for (name, value, required) in [
            ("distribution", self.distribution.as_str(), true),
            ("user", self.user.as_str(), false),
        ] {
            if (required && value.trim().is_empty())
                || value.starts_with('-')
                || value.len() > 256
                || value.chars().any(char::is_control)
                || value != value.trim()
            {
                return Err(RunnerError::InvalidInput(format!("invalid WSL {name}")));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn workspace_defaults_use_target_home_and_preserve_explicit_paths() {
        let profile = |root: Option<&str>| -> DeviceProfile {
            let mut value = serde_json::json!({
                "id": "ssh", "name": "host", "host": "localhost", "username": "custom"
            });
            if let Some(root) = root {
                value["workspace_root"] = root.into();
            }
            serde_json::from_value(value).unwrap()
        };
        let default = profile(None);
        assert_eq!(default.workspace_root, "~/devrunner/workspaces");
        default.validate().unwrap();
        for home in ["/root", "/home/alice", "/srv/custom user/", "/"] {
            assert_eq!(
                expand_home_path(&default.workspace_root, home).unwrap(),
                format!("{}/devrunner/workspaces", home.trim_end_matches('/'))
            );
        }
        let old = profile(Some("/tmp/devrunner/workspaces"));
        assert_eq!(old.workspace_root, "/tmp/devrunner/workspaces");
        old.validate().unwrap();
        assert_eq!(
            expand_home_path(&old.workspace_root, "").unwrap(),
            old.workspace_root
        );
        for bad in [
            "relative/path",
            "~alice/path",
            "$HOME/path",
            "~/../escape",
            "~/a/./b",
            "~/bad\npath",
            "~/bad\0path",
        ] {
            assert!(profile(Some(bad)).validate().is_err(), "{bad:?}");
            assert!(expand_home_path(bad, "/home/alice").is_err(), "{bad:?}");
        }
        for home in ["", "relative", "/home/../escape", "/home/bad\npath"] {
            assert!(
                expand_home_path(&default.workspace_root, home).is_err(),
                "{home:?}"
            );
        }
    }

    #[test]
    fn old_ssh_profiles_remain_compatible_and_serial_defaults_are_validated() {
        let ssh: DeviceProfile = serde_json::from_value(serde_json::json!({
            "id": "old", "name": "old board", "host": "localhost", "username": "root"
        }))
        .unwrap();
        assert!(!ssh.is_default);
        assert_eq!(ssh.transport, TransportKind::Ssh);
        assert!(ssh.serial.is_none());
        ssh.validate().unwrap();
        let mut serial: DeviceProfile = serde_json::from_value(serde_json::json!({
            "id": "serial", "name": "uart", "transport": "serial", "serial": { "port": "COM8" }
        }))
        .unwrap();
        assert_eq!(serial.serial.as_ref().unwrap().baud_rate, 115200);
        serial.validate().unwrap();
        serial.serial.as_mut().unwrap().baud_rate = 0;
        assert!(serial.validate().is_err());
    }

    #[test]
    fn local_profiles_skip_workspace_root_and_validate_shell() {
        let local: DeviceProfile = serde_json::from_value(serde_json::json!({
            "id": "l1", "name": "本机 pwsh", "transport": "local",
            "local": { "shell": "pwsh" }, "workspace_root": "not-a-linux-path"
        }))
        .unwrap();
        assert_eq!(local.transport, TransportKind::Local);
        local.validate().unwrap();
        // 缺 local 配置 / 非法 shell id / 非法路径覆盖均拒绝
        let missing: DeviceProfile = serde_json::from_value(serde_json::json!({
            "id": "l2", "name": "x", "transport": "local"
        }))
        .unwrap();
        assert!(missing.validate().is_err());
        for bad in ["", "pw sh", "pwsh;", " pwsh"] {
            let mut cfg = local.clone();
            cfg.local = Some(LocalConfig {
                shell: bad.into(),
                path: None,
                no_profile: false,
            });
            assert!(cfg.validate().is_err(), "{bad:?}");
        }
        let mut cfg = local.clone();
        cfg.local = Some(LocalConfig {
            shell: "pwsh".into(),
            path: Some(
                if cfg!(windows) {
                    "C:/tools/pwsh.exe"
                } else {
                    "/opt/tools/pwsh"
                }
                .into(),
            ),
            no_profile: false,
        });
        cfg.validate().unwrap();
        cfg.local = Some(LocalConfig {
            shell: "pwsh".into(),
            path: Some("relative/pwsh".into()),
            no_profile: false,
        });
        assert!(cfg.validate().is_err());
        cfg.local = Some(LocalConfig {
            shell: "pwsh".into(),
            path: Some("bad\0path".into()),
            no_profile: false,
        });
        assert!(cfg.validate().is_err());
        // profile 开关：默认加载 profile，反序列化缺省即关闭 -NoProfile
        let default_profile: DeviceProfile = serde_json::from_value(serde_json::json!({
            "id": "l3", "name": "x", "transport": "local",
            "local": { "shell": "pwsh" }
        }))
        .unwrap();
        assert!(!default_profile.local.unwrap().no_profile);
        let explicit: DeviceProfile = serde_json::from_value(serde_json::json!({
            "id": "l4", "name": "x", "transport": "local",
            "local": { "shell": "pwsh", "no_profile": true }
        }))
        .unwrap();
        assert!(explicit.local.unwrap().no_profile);
        // local 能力：pipe 与 resize 均支持
        let caps = TransportKind::Local.capabilities();
        assert!(caps.pipe && caps.resize);
    }

    #[test]
    fn default_device_normalization_migrates_missing_and_deduplicates_flags() {
        let profile = |id: &str, is_default: bool| -> DeviceProfile {
            serde_json::from_value(serde_json::json!({
                "id": id, "name": id, "host": "localhost", "username": "root",
                "is_default": is_default
            }))
            .unwrap()
        };
        let mut missing = vec![profile("first", false), profile("second", false)];
        normalize_default(&mut missing);
        assert!(missing[0].is_default);
        assert!(!missing[1].is_default);

        let mut duplicate = vec![profile("first", true), profile("second", true)];
        normalize_default(&mut duplicate);
        assert!(duplicate[0].is_default);
        assert!(!duplicate[1].is_default);
    }

    struct TestStore(PathBuf);
    impl TestStore {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("rr-devices-{}", uuid::Uuid::new_v4())))
        }
        fn store(&self) -> DeviceStore {
            DeviceStore::new(&self.0)
        }
    }
    impl Drop for TestStore {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn profile(id: &str) -> DeviceProfile {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": id, "host": "example.com", "port": 2222,
            "username": "alice", "auth": {"type": "password", "password": "secret"}
        }))
        .unwrap()
    }

    #[test]
    fn deleted_devices_survive_restart_and_restore_the_same_identity_and_credentials() {
        let fixture = TestStore::new();
        let store = fixture.store();
        let saved = store.save(profile("ssh")).unwrap();
        let deleted = store.delete(&saved.id).unwrap();
        assert_eq!(deleted.id, saved.id);
        assert!(chrono::DateTime::parse_from_rfc3339(&deleted.deleted_at).is_ok());
        assert_eq!(
            store.delete(&saved.id).unwrap().deleted_at,
            deleted.deleted_at
        );
        let restarted = fixture.store();
        assert!(restarted.list().unwrap().is_empty());
        assert!(restarted.get(&saved.id).is_err());
        assert_eq!(restarted.list_deleted().unwrap()[0].id, saved.id);
        assert!(restarted.save(saved.clone()).is_err());
        let restored = restarted.restore(&saved.id).unwrap();
        assert_eq!(
            serde_json::to_value(restored).unwrap(),
            serde_json::to_value(saved).unwrap()
        );
        assert!(restarted.list_deleted().unwrap().is_empty());
        assert!(restarted.restore("missing").is_err());
    }

    #[test]
    fn deleting_multiple_devices_keeps_other_records_and_restoring_preserves_the_current_default() {
        let fixture = TestStore::new();
        let store = fixture.store();
        store.save(profile("first")).unwrap();
        store.save(profile("second")).unwrap();
        store.save(profile("third")).unwrap();
        store.delete("first").unwrap();
        store.delete("third").unwrap();
        assert_eq!(store.list().unwrap()[0].id, "second");
        assert!(store.list().unwrap()[0].is_default);
        assert_eq!(store.list_deleted().unwrap().len(), 2);
        let mut second = store.get("second").unwrap();
        second.name = "renamed".into();
        store.save(second).unwrap();
        assert_eq!(store.list_deleted().unwrap().len(), 2);
        assert!(!store.restore("first").unwrap().is_default);
        assert_eq!(
            store
                .list()
                .unwrap()
                .iter()
                .find(|d| d.is_default)
                .unwrap()
                .id,
            "second"
        );
        assert_eq!(store.get("second").unwrap().name, "renamed");
        assert_eq!(store.list_deleted().unwrap()[0].id, "third");
    }

    #[test]
    fn legacy_device_arrays_still_load_and_a_corrupt_file_is_never_overwritten() {
        let fixture = TestStore::new();
        std::fs::create_dir_all(&fixture.0).unwrap();
        let path = fixture.0.join("devices.json");
        std::fs::write(&path, serde_json::to_vec(&vec![profile("legacy")]).unwrap()).unwrap();
        let store = fixture.store();
        assert_eq!(store.list().unwrap()[0].id, "legacy");
        assert!(store.list_deleted().unwrap().is_empty());
        store.delete("legacy").unwrap();
        store.restore("legacy").unwrap();
        std::fs::write(&path, b"invalid devices").unwrap();
        assert!(store.delete("legacy").is_err());
        assert!(store.restore("legacy").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"invalid devices");
    }

    #[test]
    fn concurrent_device_saves_do_not_overwrite_each_other() {
        let fixture = TestStore::new();
        std::thread::scope(|scope| {
            for index in 0..8 {
                let root = &fixture.0;
                scope.spawn(move || {
                    DeviceStore::new(root)
                        .save(profile(&format!("device-{index}")))
                        .unwrap()
                });
            }
        });
        let devices = fixture.store().list().unwrap();
        assert_eq!(devices.len(), 8);
        assert_eq!(devices.iter().filter(|device| device.is_default).count(), 1);
    }

    #[test]
    fn reordering_persists_and_preserves_credentials_defaults_and_deleted_slots() {
        let fixture = TestStore::new();
        let store = fixture.store();
        let first = store.save(profile("first")).unwrap();
        store.save(profile("deleted")).unwrap();
        let third = store.save(profile("third")).unwrap();
        store.delete("deleted").unwrap();
        let deleted = serde_json::to_value(&store.read_all().unwrap()[1]).unwrap();
        let reordered = store.reorder(&["third".into(), "first".into()]).unwrap();
        assert_eq!(
            serde_json::to_value(&reordered).unwrap(),
            serde_json::to_value(vec![third, first]).unwrap()
        );
        let restarted = fixture.store();
        let stored = restarted.read_all().unwrap();
        assert_eq!(serde_json::to_value(&stored[1]).unwrap(), deleted);
        assert_eq!(
            restarted
                .list()
                .unwrap()
                .iter()
                .map(|d| d.id.as_str())
                .collect::<Vec<_>>(),
            ["third", "first"]
        );
        let mut edited = restarted.get("first").unwrap();
        edited.name = "updated".into();
        restarted.save(edited).unwrap();
        restarted.save(profile("new")).unwrap();
        restarted.restore("deleted").unwrap();
        let active = restarted.list().unwrap();
        assert_eq!(
            active.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(),
            ["third", "deleted", "first", "new"]
        );
        assert_eq!(active[2].name, "updated");
        assert!(active[2].is_default);
    }

    #[test]
    fn invalid_or_stale_orders_and_corrupt_files_are_never_written() {
        let fixture = TestStore::new();
        let store = fixture.store();
        for id in ["first", "second", "deleted"] {
            store.save(profile(id)).unwrap();
        }
        store.delete("deleted").unwrap();
        let before = std::fs::read(&store.path).unwrap();
        for ids in [
            vec![],
            vec!["first"],
            vec!["first", "first"],
            vec!["first", "missing"],
            vec!["first", "deleted"],
            vec!["first", "second", "deleted"],
        ] {
            assert!(store
                .reorder(&ids.into_iter().map(String::from).collect::<Vec<_>>())
                .is_err());
            assert_eq!(std::fs::read(&store.path).unwrap(), before);
        }
        store.save(profile("new")).unwrap();
        let before = std::fs::read(&store.path).unwrap();
        assert!(store.reorder(&["second".into(), "first".into()]).is_err());
        assert_eq!(std::fs::read(&store.path).unwrap(), before);
        std::fs::write(&store.path, b"invalid devices").unwrap();
        assert!(store.reorder(&["second".into(), "first".into()]).is_err());
        assert_eq!(std::fs::read(&store.path).unwrap(), b"invalid devices");
    }

    #[test]
    fn reordering_legacy_profiles_keeps_the_original_default_and_noop_does_not_write() {
        let fixture = TestStore::new();
        let store = fixture.store();
        assert!(store.reorder(&[]).unwrap().is_empty());
        assert!(!store.path.exists());
        std::fs::create_dir_all(&fixture.0).unwrap();
        let legacy = serde_json::json!([
            {"id": "first", "name": "first", "host": "example.com", "username": "root"},
            {"id": "second", "name": "second", "host": "example.com", "username": "root"}
        ]);
        let before = serde_json::to_vec(&legacy).unwrap();
        std::fs::write(&store.path, &before).unwrap();
        store.reorder(&["first".into(), "second".into()]).unwrap();
        assert_eq!(std::fs::read(&store.path).unwrap(), before);
        store.reorder(&["second".into(), "first".into()]).unwrap();
        let active = fixture.store().list().unwrap();
        assert!(!active[0].is_default);
        assert_eq!(active[1].id, "first");
        assert!(active[1].is_default);
    }

    #[test]
    fn concurrent_reorder_and_edit_keep_both_changes() {
        let fixture = TestStore::new();
        let store = fixture.store();
        store.save(profile("first")).unwrap();
        let mut edited = store.save(profile("second")).unwrap();
        edited.auth = AuthMethod::Password {
            password: "new-secret".into(),
        };
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                barrier.wait();
                fixture.store().save(edited).unwrap();
            });
            scope.spawn(|| {
                barrier.wait();
                fixture
                    .store()
                    .reorder(&["second".into(), "first".into()])
                    .unwrap();
            });
        });
        let active = fixture.store().list().unwrap();
        assert_eq!(
            active.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(),
            ["second", "first"]
        );
        assert!(
            matches!(&active[0].auth, AuthMethod::Password { password } if password == "new-secret")
        );
        assert!(active[1].is_default);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialConfig {
    pub port: String,
    #[serde(default = "default_baud_rate")]
    pub baud_rate: u32,
}

/// 本机 shell 直连配置。shell 为后端注册表中的 id（如 "pwsh"、"msys2"），
/// path 留空时按注册表候选位置探测可执行文件。
///
/// `no_profile` 是唯一的 PowerShell profile 开关，交互终端、命令、脚本与连接测试
/// 全部读它：默认加载 profile（与 posix login shell 的 `/etc/profile` 一致，
/// fnm/nvm/conda 等由 profile 提供的 PATH 才可见），置位后统一加 `-NoProfile`。
/// 对 cmd 无影响（cmd 没有 profile 概念）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalConfig {
    pub shell: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default)]
    pub no_profile: bool,
}

impl LocalConfig {
    pub fn validate(&self) -> Result<()> {
        let invalid = |text: &str| RunnerError::InvalidInput(text.into());
        let shell = self.shell.as_str();
        if shell != shell.trim()
            || shell.is_empty()
            || shell.len() > 64
            || !shell
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(invalid("invalid local shell id"));
        }
        if let Some(path) = &self.path {
            if *path != path.trim()
                || path.is_empty()
                || path.len() > 1024
                || path.contains(['\0', '\r', '\n'])
                || !Path::new(path).is_absolute()
            {
                return Err(invalid("invalid local shell path"));
            }
        }
        Ok(())
    }
}

fn default_baud_rate() -> u32 {
    115_200
}

/// SSH 认证方式
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthMethod {
    /// 使用密码（V1 直接明文保存在本地配置，见安全设计 TODO）
    Password { password: String },
    /// 使用指定私钥文件；key_path 为空时依次尝试 ~/.ssh/id_ed25519、id_rsa
    Key { key_path: Option<String> },
}

impl Default for AuthMethod {
    fn default() -> Self {
        AuthMethod::Key { key_path: None }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceProfile {
    pub id: String,
    pub name: String,
    /// The device preselected for runs and used by the terminal quick-add action.
    #[serde(default)]
    pub is_default: bool,
    #[serde(default)]
    pub transport: TransportKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serial: Option<SerialConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wsl: Option<WslConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local: Option<LocalConfig>,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub auth: AuthMethod,
    /// 远程 workspace 根目录
    #[serde(default = "default_workspace_root")]
    pub workspace_root: String,
}

fn default_port() -> u16 {
    22
}

pub fn default_workspace_root() -> String {
    "~/devrunner/workspaces".to_string()
}

/// Device settings may use ~/; actual workspace and transfer roots are resolved
/// to absolute paths on the target before filesystem access.
pub(crate) fn validate_workspace_root(path: &str) -> Result<()> {
    let absolute = if path.starts_with("~/") {
        &path[1..]
    } else {
        path
    };
    crate::workspace_ref::validate_device_path(absolute).map_err(RunnerError::InvalidInput)
}

pub(crate) fn expand_home_path(path: &str, home: &str) -> Result<String> {
    validate_workspace_root(path)?;
    if let Some(relative) = path.strip_prefix("~/") {
        crate::workspace_ref::validate_device_path(home).map_err(RunnerError::InvalidInput)?;
        return Ok(format!("{}/{relative}", home.trim_end_matches('/')));
    }
    Ok(path.to_string())
}

impl DeviceProfile {
    pub fn validate(&self) -> Result<()> {
        let invalid = |text: &str| RunnerError::InvalidInput(text.into());
        if self.name.trim().is_empty() {
            return Err(invalid("device name is required"));
        }
        // 本机设备原地运行，不使用远程工作区根目录
        if self.transport != TransportKind::Local {
            validate_workspace_root(&self.workspace_root)?;
        }
        match self.transport {
            TransportKind::Local => self
                .local
                .as_ref()
                .ok_or_else(|| invalid("local configuration is required"))?
                .validate()?,
            TransportKind::Wsl => self
                .wsl
                .as_ref()
                .ok_or_else(|| invalid("WSL configuration is required"))?
                .validate()?,
            TransportKind::Ssh => {
                if self.host.trim().is_empty() || self.username.trim().is_empty() || self.port == 0
                {
                    return Err(invalid("SSH host, username and port are required"));
                }
            }
            TransportKind::Serial => {
                let serial = self
                    .serial
                    .as_ref()
                    .ok_or_else(|| invalid("serial configuration is required"))?;
                if serial.port.trim().is_empty()
                    || serial.port.contains(['\0', '\r', '\n'])
                    || serial.baud_rate == 0
                    || serial.baud_rate > 4_000_000
                {
                    return Err(invalid(
                        "serial port and baud rate (1–4000000) are required",
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

/// 设备配置持久化存储（JSON 文件）
pub struct DeviceStore {
    path: PathBuf,
}

#[derive(Serialize, Deserialize)]
struct StoredDevice {
    #[serde(flatten)]
    device: DeviceProfile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    deleted_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DeletedDevice {
    pub id: String,
    pub name: String,
    pub deleted_at: String,
}

fn normalize_active_defaults(devices: &mut [StoredDevice]) {
    let keep = devices
        .iter()
        .position(|entry| entry.deleted_at.is_none() && entry.device.is_default)
        .or_else(|| devices.iter().position(|entry| entry.deleted_at.is_none()));
    for (index, entry) in devices.iter_mut().enumerate() {
        if entry.deleted_at.is_none() {
            entry.device.is_default = Some(index) == keep;
        }
    }
}

impl DeviceStore {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            path: config_dir.join("devices.json"),
        }
    }

    fn read_all(&self) -> Result<Vec<StoredDevice>> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let data = std::fs::read_to_string(&self.path)?;
        serde_json::from_str(&data).map_err(|e| RunnerError::InvalidInput(e.to_string()))
    }

    pub fn list(&self) -> Result<Vec<DeviceProfile>> {
        let mut devices: Vec<DeviceProfile> = self
            .read_all()?
            .into_iter()
            .filter(|entry| entry.deleted_at.is_none())
            .map(|entry| entry.device)
            .collect();
        normalize_default(&mut devices);
        Ok(devices)
    }

    pub fn list_deleted(&self) -> Result<Vec<DeletedDevice>> {
        let mut deleted: Vec<StoredDevice> = self
            .read_all()?
            .into_iter()
            .filter(|entry| entry.deleted_at.is_some())
            .collect();
        deleted.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
        Ok(deleted
            .into_iter()
            .map(|entry| DeletedDevice {
                id: entry.device.id,
                name: entry.device.name,
                deleted_at: entry.deleted_at.unwrap(),
            })
            .collect())
    }

    pub fn get(&self, id: &str) -> Result<DeviceProfile> {
        self.list()?
            .into_iter()
            .find(|d| d.id == id)
            .ok_or_else(|| RunnerError::DeviceNotFound(id.to_string()))
    }

    pub fn reorder(&self, ids: &[String]) -> Result<Vec<DeviceProfile>> {
        use std::collections::{HashMap, HashSet};
        let _guard = DEVICE_OPERATIONS.lock();
        let mut devices = self.read_all()?;
        let active_ids: Vec<&str> = devices
            .iter()
            .filter(|entry| entry.deleted_at.is_none())
            .map(|entry| entry.device.id.as_str())
            .collect();
        let requested: HashSet<&str> = ids.iter().map(String::as_str).collect();
        if ids.len() != active_ids.len()
            || requested.len() != ids.len()
            || active_ids.iter().copied().collect::<HashSet<_>>() != requested
        {
            return Err(RunnerError::InvalidInput(
                "device list changed or invalid order; refresh devices and retry".into(),
            ));
        }
        let changed = active_ids
            .iter()
            .copied()
            .ne(ids.iter().map(String::as_str));
        // Normalize before moving anything so legacy profiles retain their default.
        normalize_active_defaults(&mut devices);
        if changed {
            let mut active: HashMap<String, DeviceProfile> = devices
                .iter()
                .filter(|entry| entry.deleted_at.is_none())
                .map(|entry| (entry.device.id.clone(), entry.device.clone()))
                .collect();
            let mut order = ids.iter();
            // Deleted entries retain their slots and full recovery metadata.
            for entry in devices
                .iter_mut()
                .filter(|entry| entry.deleted_at.is_none())
            {
                entry.device = active.remove(order.next().unwrap()).unwrap();
            }
            self.write_all(&devices)?;
        }
        Ok(devices
            .into_iter()
            .filter(|entry| entry.deleted_at.is_none())
            .map(|entry| entry.device)
            .collect())
    }

    pub fn save(&self, mut device: DeviceProfile) -> Result<DeviceProfile> {
        let _guard = DEVICE_OPERATIONS.lock();
        device.validate()?;
        let mut devices = self.read_all()?;
        if device.id.is_empty() {
            device.id = uuid::Uuid::new_v4().to_string();
        }
        if devices
            .iter()
            .any(|entry| entry.device.id == device.id && entry.deleted_at.is_some())
        {
            return Err(RunnerError::InvalidInput(
                "restore the deleted device before editing it".into(),
            ));
        }
        if device.is_default {
            devices
                .iter_mut()
                .for_each(|existing| existing.device.is_default = false);
        }
        match devices
            .iter_mut()
            .find(|entry| entry.device.id == device.id)
        {
            Some(existing) => existing.device = device.clone(),
            None => devices.push(StoredDevice {
                device: device.clone(),
                deleted_at: None,
            }),
        }
        normalize_active_defaults(&mut devices);
        let saved = devices
            .iter()
            .find(|candidate| candidate.device.id == device.id)
            .map(|entry| entry.device.clone())
            .expect("saved device must remain in the device list");
        self.write_all(&devices)?;
        Ok(saved)
    }

    pub fn delete(&self, id: &str) -> Result<DeletedDevice> {
        let _guard = DEVICE_OPERATIONS.lock();
        let mut devices = self.read_all()?;
        let entry = devices
            .iter_mut()
            .find(|entry| entry.device.id == id)
            .ok_or_else(|| RunnerError::DeviceNotFound(id.into()))?;
        let deleted_at = entry
            .deleted_at
            .get_or_insert_with(|| chrono::Utc::now().to_rfc3339())
            .clone();
        let deleted = DeletedDevice {
            id: entry.device.id.clone(),
            name: entry.device.name.clone(),
            deleted_at,
        };
        normalize_active_defaults(&mut devices);
        self.write_all(&devices)?;
        Ok(deleted)
    }

    pub fn restore(&self, id: &str) -> Result<DeviceProfile> {
        let _guard = DEVICE_OPERATIONS.lock();
        let mut devices = self.read_all()?;
        normalize_active_defaults(&mut devices);
        let has_active = devices.iter().any(|entry| entry.deleted_at.is_none());
        let entry = devices
            .iter_mut()
            .find(|entry| entry.device.id == id && entry.deleted_at.is_some())
            .ok_or_else(|| RunnerError::DeviceNotFound(id.into()))?;
        entry.device.validate()?;
        entry.deleted_at = None;
        // 恢复设备不抢占当前默认设备；列表原为空时，它成为默认设备。
        entry.device.is_default = !has_active;
        let restored = entry.device.clone();
        normalize_active_defaults(&mut devices);
        self.write_all(&devices)?;
        Ok(restored)
    }

    fn write_all(&self, devices: &[StoredDevice]) -> Result<()> {
        use std::io::Write;
        let parent = self.path.parent().ok_or_else(|| {
            RunnerError::InvalidInput("device storage needs a parent directory".into())
        })?;
        std::fs::create_dir_all(parent)?;
        let data = serde_json::to_vec_pretty(devices)
            .map_err(|e| RunnerError::InvalidInput(e.to_string()))?;
        let temp = parent.join(format!(".devices-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> Result<()> {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temp)?;
            file.write_all(&data)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&temp, &self.path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temp);
        }
        result
    }
}

/// Keep exactly one default whenever at least one device exists. Old profiles did
/// not have this field, so the first device becomes their migration default.
fn normalize_default(devices: &mut [DeviceProfile]) {
    let keep = devices
        .iter()
        .position(|device| device.is_default)
        .unwrap_or(0);
    for (index, device) in devices.iter_mut().enumerate() {
        device.is_default = index == keep;
    }
}
