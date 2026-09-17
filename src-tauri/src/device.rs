use crate::error::{Result, RunnerError};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

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

fn default_workspace_root() -> String {
    "/tmp/devrunner/workspaces".to_string()
}

impl DeviceProfile {
    pub fn validate(&self) -> Result<()> {
        let invalid = |text: &str| RunnerError::InvalidInput(text.into());
        if self.name.trim().is_empty() {
            return Err(invalid("device name is required"));
        }
        // 本机设备原地运行，不使用远程工作区根目录
        if self.transport != TransportKind::Local
            && (!self.workspace_root.starts_with('/')
                || self.workspace_root.contains(['\0', '\r', '\n'])
                || self
                    .workspace_root
                    .split('/')
                    .any(|p| p == ".." || p == "."))
        {
            return Err(invalid(
                "workspace root must be an absolute Linux path without dot components",
            ));
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

impl DeviceStore {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            path: config_dir.join("devices.json"),
        }
    }

    pub fn list(&self) -> Result<Vec<DeviceProfile>> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let data = std::fs::read_to_string(&self.path)?;
        let mut devices: Vec<DeviceProfile> =
            serde_json::from_str(&data).map_err(|e| RunnerError::InvalidInput(e.to_string()))?;
        normalize_default(&mut devices);
        Ok(devices)
    }

    pub fn get(&self, id: &str) -> Result<DeviceProfile> {
        self.list()?
            .into_iter()
            .find(|d| d.id == id)
            .ok_or_else(|| RunnerError::DeviceNotFound(id.to_string()))
    }

    pub fn save(&self, mut device: DeviceProfile) -> Result<DeviceProfile> {
        device.validate()?;
        let mut devices = self.list()?;
        if device.id.is_empty() {
            device.id = uuid::Uuid::new_v4().to_string();
        }
        if device.is_default {
            devices
                .iter_mut()
                .for_each(|existing| existing.is_default = false);
        }
        match devices.iter_mut().find(|d| d.id == device.id) {
            Some(existing) => *existing = device.clone(),
            None => devices.push(device.clone()),
        }
        normalize_default(&mut devices);
        let saved = devices
            .iter()
            .find(|candidate| candidate.id == device.id)
            .cloned()
            .expect("saved device must remain in the device list");
        self.write_all(&devices)?;
        Ok(saved)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let mut devices = self.list()?;
        devices.retain(|d| d.id != id);
        normalize_default(&mut devices);
        self.write_all(&devices)
    }

    fn write_all(&self, devices: &[DeviceProfile]) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let data = serde_json::to_string_pretty(devices)
            .map_err(|e| RunnerError::InvalidInput(e.to_string()))?;
        std::fs::write(&self.path, data)?;
        Ok(())
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
