//! WorkspaceRef：工作区来源标识（00029）。
//!
//! 工作区可以是本机目录（Local，原有行为），也可以是某台设备上的目录
//! （Device，SSH 走 SFTP / WSL 走 helper 文件服务）。运行目标与来源解耦：
//! 同设备原地运行，跨设备先暂存到本机再走既有上传管线。
use serde::{Deserialize, Deserializer, Serialize};

/// 可作为远端工作区宿主的 transport（串口没有文件操作通道）
use crate::device::TransportKind;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum WorkspaceRef {
    /// 本机目录（原有行为）
    Local { dir: String },
    /// 设备上的绝对 posix 路径目录
    Device { device_id: String, path: String },
}

impl WorkspaceRef {
    pub fn local(dir: impl Into<String>) -> Self {
        Self::Local { dir: dir.into() }
    }

    pub fn device(device_id: impl Into<String>, path: impl Into<String>) -> Self {
        Self::Device {
            device_id: device_id.into(),
            path: path.into(),
        }
    }

    /// 本机目录（仅 Local）
    pub fn local_dir(&self) -> Option<&str> {
        match self {
            Self::Local { dir } => Some(dir),
            Self::Device { .. } => None,
        }
    }

    /// （设备 id, 设备上的路径）（仅 Device）
    pub fn device_ref(&self) -> Option<(&str, &str)> {
        match self {
            Self::Local { .. } => None,
            Self::Device { device_id, path } => Some((device_id, path)),
        }
    }

    /// 是否为指定设备上的目录
    pub fn is_on_device(&self, device_id: &str) -> bool {
        matches!(self, Self::Device { device_id: id, .. } if id == device_id)
    }
}

/// 远端工作区路径校验：与 DeviceProfile.workspace_root 同规则
/// （绝对路径、无 . / .. 组件、无 NUL/CR/LF）。
pub fn validate_device_path(path: &str) -> std::result::Result<(), String> {
    if !path.starts_with('/')
        || path.contains(['\0', '\r', '\n'])
        || path.split('/').any(|p| p == ".." || p == ".")
    {
        return Err("设备工作区路径必须是不含 . / .. 组件的绝对 Linux 路径".into());
    }
    Ok(())
}

/// 宿主 transport 是否支持作为远端工作区
pub fn host_supported(transport: TransportKind) -> bool {
    matches!(transport, TransportKind::Ssh | TransportKind::Wsl)
}

// 兼容反序列化：接受裸字符串（历史 / 旧请求里的本地路径）与标记对象两种形态。
impl<'de> Deserialize<'de> for WorkspaceRef {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        use serde::de::Error;
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Repr {
            Legacy(String),
            Tagged {
                #[serde(rename = "type")]
                kind: String,
                #[serde(default)]
                dir: Option<String>,
                #[serde(default)]
                device_id: Option<String>,
                #[serde(default)]
                path: Option<String>,
            },
        }
        match Repr::deserialize(deserializer)? {
            Repr::Legacy(dir) => Ok(Self::Local { dir }),
            Repr::Tagged { kind, dir, .. } if kind == "local" => Ok(Self::Local {
                dir: dir.ok_or_else(|| D::Error::custom("local workspace requires dir"))?,
            }),
            Repr::Tagged {
                kind,
                device_id,
                path,
                ..
            } if kind == "device" => Ok(Self::Device {
                device_id: device_id
                    .ok_or_else(|| D::Error::custom("device workspace requires device_id"))?,
                path: path.ok_or_else(|| D::Error::custom("device workspace requires path"))?,
            }),
            Repr::Tagged { kind, .. } => {
                Err(D::Error::custom(format!("unknown workspace type: {kind}")))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_bare_string_deserializes_as_local() {
        let parsed: WorkspaceRef = serde_json::from_str(r#""D:\\proj\\ws""#).unwrap();
        assert_eq!(parsed, WorkspaceRef::local("D:\\proj\\ws"));
        let parsed: WorkspaceRef = serde_json::from_str(r#""/home/me/ws""#).unwrap();
        assert_eq!(parsed, WorkspaceRef::local("/home/me/ws"));
    }

    #[test]
    fn tagged_forms_round_trip() {
        let local = WorkspaceRef::local("/ws");
        assert_eq!(
            serde_json::to_string(&local).unwrap(),
            r#"{"type":"local","dir":"/ws"}"#
        );
        let device = WorkspaceRef::device("dev-1", "/srv/app");
        let json = serde_json::to_string(&device).unwrap();
        assert_eq!(serde_json::from_str::<WorkspaceRef>(&json).unwrap(), device);
        assert_eq!(
            serde_json::from_str::<WorkspaceRef>(
                r#"{"type":"device","device_id":"d","path":"/p"}"#
            )
            .unwrap()
            .device_ref(),
            Some(("d", "/p"))
        );
    }

    #[test]
    fn rejects_malformed_tagged_forms() {
        assert!(serde_json::from_str::<WorkspaceRef>(r#"{"type":"local"}"#).is_err());
        assert!(serde_json::from_str::<WorkspaceRef>(r#"{"type":"device","path":"/p"}"#).is_err());
        assert!(serde_json::from_str::<WorkspaceRef>(r#"{"type":"other"}"#).is_err());
    }

    #[test]
    fn device_path_validation_matches_workspace_root_rules() {
        assert!(validate_device_path("/srv/app").is_ok());
        assert!(validate_device_path("/").is_ok());
        for bad in ["relative", "/a/../b", "/a/./b", "/a\0b", "/a\nb", ""] {
            assert!(validate_device_path(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn host_transport_support() {
        assert!(host_supported(TransportKind::Ssh));
        assert!(host_supported(TransportKind::Wsl));
        assert!(!host_supported(TransportKind::Serial));
        assert!(!host_supported(TransportKind::Local));
    }
}
