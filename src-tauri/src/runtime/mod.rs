//! uv-only Managed Python Runtime（设计 00027）。
//!
//! 固定版本的 uv + 固定 patch 版本 CPython + `uv.lock` 生成内容寻址的项目环境；
//! 运行阶段直接启动环境内 Python，不使用 `uv run`，不回落系统 Python。
pub mod catalog;
pub mod download;
pub mod envid;
#[cfg(test)]
pub mod fake;
pub mod host;
pub mod hosts;
pub mod lock;
pub mod manage;
pub mod manager;
pub mod manifest;
pub mod prepare;
pub mod profile;
pub mod project;

use serde::{Deserialize, Serialize};

/// Runtime schema 版本；变更 uv 固定方式或 Environment ID 输入时递增
pub const SCHEMA: u32 = 1;
/// 目标端 Runtime 根目录名（位于用户 home / 本机应用数据目录下）
pub const RUNTIME_DIR: &str = ".remote-runner/runtime-v1";
/// uv.lock 大小上限
pub const LOCK_LIMIT: usize = 8 * 1024 * 1024;
/// Runtime 根目录最小剩余空间（2 GiB）
pub const MIN_FREE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// 稳定错误代码（00027 §18）
pub mod code {
    pub const NOT_SUPPORTED: &str = "managed_runtime_not_supported";
    pub const INVALID_PROJECT: &str = "invalid_python_project";
    pub const MISSING_LOCK: &str = "missing_uv_lock";
    pub const STALE_LOCK: &str = "stale_uv_lock";
    pub const INVALID_PYTHON_VERSION: &str = "invalid_python_version";
    pub const VERSION_MISMATCH: &str = "python_version_mismatch";
    pub const UNSUPPORTED_PLATFORM: &str = "unsupported_runtime_platform";
    pub const UNSUPPORTED_ARCH: &str = "unsupported_architecture";
    pub const UNSUPPORTED_LIBC: &str = "unsupported_libc";
    pub const INSUFFICIENT_SPACE: &str = "insufficient_runtime_space";
    pub const ROOT_NOT_EXECUTABLE: &str = "runtime_root_not_executable";
    pub const UV_ASSET_VERIFY: &str = "uv_asset_verification_failed";
    pub const UV_VERSION_MISMATCH: &str = "uv_version_mismatch";
    pub const PYTHON_INSTALL: &str = "managed_python_install_failed";
    pub const PYTHON_VERIFY: &str = "managed_python_verification_failed";
    pub const ENV_LOCK_TIMEOUT: &str = "environment_lock_timeout";
    pub const ENV_SYNC: &str = "environment_sync_failed";
    pub const ENV_VERIFY: &str = "environment_verification_failed";
    pub const OFFLINE_ARTIFACT: &str = "offline_artifact_missing";
    pub const CLEANUP: &str = "runtime_cleanup_failed";
    pub const CANCELED: &str = "managed_runtime_canceled";
}

/// 运行期准备阶段（00027 §14），随 RunStatus.phase 与 runtime_progress 事件下发
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimePhase {
    ValidatingProject,
    ProbingRuntime,
    DeployingUv,
    InstallingPython,
    WaitingEnvironmentLock,
    SyncingDependencies,
    VerifyingEnvironment,
}

impl RuntimePhase {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ValidatingProject => "validating_project",
            Self::ProbingRuntime => "probing_runtime",
            Self::DeployingUv => "deploying_uv",
            Self::InstallingPython => "installing_python",
            Self::WaitingEnvironmentLock => "waiting_environment_lock",
            Self::SyncingDependencies => "syncing_dependencies",
            Self::VerifyingEnvironment => "verifying_environment",
        }
    }
}

impl std::fmt::Display for RuntimePhase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Python 项目的运行时请求摘要（00027 §17）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagedPythonSpec {
    pub python_version: String,
    pub uv_version: String,
    pub lock_sha256: String,
    pub groups: Vec<String>,
    pub extras: Vec<String>,
}

/// 执行目标的运行时兼容性描述（00027 §8）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceRuntimeProfile {
    pub os: String,
    pub arch: String,
    pub libc: Option<String>,
    pub libc_version: Option<String>,
    pub kernel: Option<String>,
    pub home: Option<String>,
    /// Runtime 根目录（绝对路径，已展开 ~）
    pub runtime_root: String,
    pub root_writable: bool,
    pub root_executable: bool,
    pub free_bytes: Option<u64>,
}

impl DeviceRuntimeProfile {
    /// Runtime Catalog 平台键，如 linux-x86_64-gnu / windows-x86_64 / macos-aarch64
    pub fn platform_key(&self) -> String {
        match self.os.as_str() {
            "macos" => format!("macos-{}", self.arch),
            "windows" => format!("windows-{}", self.arch),
            _ => format!(
                "{}-{}-{}",
                self.os,
                self.arch,
                self.libc.as_deref().unwrap_or("unknown")
            ),
        }
    }
}

/// 已就绪的 uv + Managed Python 组合
#[derive(Debug, Clone)]
pub struct RuntimeReady {
    pub profile: DeviceRuntimeProfile,
    pub uv_path: String,
    pub uv_version: String,
    pub python_path: String,
    /// 解析出的 Python build identity（Environment ID 输入）
    pub python_build: String,
}

/// 可直接启动的项目环境
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparedEnvironment {
    pub environment_id: String,
    pub env_path: String,
    pub python_path: String,
    pub uv_version: String,
    pub python_version: String,
    pub lock_sha256: String,
    pub cache_hit: bool,
}

/// 环境/Runtime 列表展示项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagedRuntimeInfo {
    pub uv_version: String,
    pub platform: String,
    pub uv_path: String,
    pub present: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectEnvironmentInfo {
    pub id: String,
    pub path: String,
    pub ready: bool,
    pub leased: bool,
    pub manifest: Option<manifest::EnvironmentManifest>,
}

/// 清理（日志/错误）中的凭据：mask URL userinfo 与常见 token 形态
pub fn scrub_credentials(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find("://") {
        out.push_str(&rest[..pos + 3]);
        rest = &rest[pos + 3..];
        // 掩码 authority 中的 userinfo（user:pass@）
        let authority_end = rest.find(['/', '?', '#', ' ', '\n']).unwrap_or(rest.len());
        let authority = &rest[..authority_end];
        if let Some(at) = authority.rfind('@') {
            out.push_str("***");
            out.push_str(&authority[at..]);
        } else {
            out.push_str(authority);
        }
        rest = &rest[authority_end..];
    }
    out.push_str(rest);
    out
}

/// 校验 Runtime 根路径：绝对、无 NUL/控制字符、无 dot component（00027 §7/§19）
pub fn validate_runtime_root(root: &str, windows: bool) -> crate::error::Result<()> {
    use crate::error::RunnerError;
    let invalid = || RunnerError::InvalidInput(format!("invalid runtime root: {root:?}"));
    if root.is_empty() || root.len() > 512 || root.chars().any(|c| c == '\0' || c.is_control()) {
        return Err(invalid());
    }
    if windows {
        let bytes = root.as_bytes();
        if bytes.len() < 3 || bytes[1] != b':' || !bytes[0].is_ascii_alphabetic() {
            return Err(invalid());
        }
        if root.split(['\\', '/']).any(|p| p == ".." || p == ".") {
            return Err(invalid());
        }
    } else {
        if !root.starts_with('/') {
            return Err(invalid());
        }
        if root.split('/').any(|p| p == ".." || p == ".") {
            return Err(invalid());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_masks_url_userinfo_only() {
        assert_eq!(
            scrub_credentials("fetch https://user:secret@example.com/a ok"),
            "fetch https://***@example.com/a ok"
        );
        assert_eq!(
            scrub_credentials("https://user:secret@h1 https://user2:s2@h2/p"),
            "https://***@h1 https://***@h2/p"
        );
        assert_eq!(
            scrub_credentials("no credentials here"),
            "no credentials here"
        );
    }

    #[test]
    fn runtime_root_validation_rejects_relative_and_dot_components() {
        validate_runtime_root("/home/u/.remote-runner/runtime-v1", false).unwrap();
        validate_runtime_root("C:/Users/u/runtime-v1", true).unwrap();
        assert!(validate_runtime_root("relative/path", false).is_err());
        assert!(validate_runtime_root("/home/../x", false).is_err());
        assert!(validate_runtime_root("/home/./x", false).is_err());
        assert!(validate_runtime_root("/bad\0path", false).is_err());
        assert!(validate_runtime_root("C:/Users/../x", true).is_err());
        assert!(validate_runtime_root("relative/x", true).is_err());
    }

    #[test]
    fn platform_key_covers_catalog_shapes() {
        let p = |os: &str, arch: &str, libc: Option<&str>| DeviceRuntimeProfile {
            os: os.into(),
            arch: arch.into(),
            libc: libc.map(str::to_string),
            libc_version: None,
            kernel: None,
            home: None,
            runtime_root: String::new(),
            root_writable: true,
            root_executable: true,
            free_bytes: None,
        };
        assert_eq!(
            p("linux", "x86_64", Some("gnu")).platform_key(),
            "linux-x86_64-gnu"
        );
        assert_eq!(
            p("linux", "aarch64", Some("musl")).platform_key(),
            "linux-aarch64-musl"
        );
        assert_eq!(
            p("windows", "x86_64", Some("msvc")).platform_key(),
            "windows-x86_64"
        );
        assert_eq!(p("macos", "aarch64", None).platform_key(), "macos-aarch64");
    }
}
