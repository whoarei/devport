//! Project Environment 只读 manifest（00005-python-runtime.md）。
use crate::error::{Result, RunnerError};
use serde::{Deserialize, Serialize};

pub const MANIFEST_NAME: &str = "manifest.json";
pub const READY_MARKER: &str = ".ready";
pub const PREPARING_MARKER: &str = ".preparing";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvironmentManifest {
    pub schema: u32,
    pub environment_id: String,
    pub uv_version: String,
    /// .python-version 的请求版本（如 3.12 或 3.12.9）
    pub python_request: String,
    /// 环境内实际解释器路径（探测所得，非拼接猜测）
    pub python_executable: String,
    /// 实际完整版本（如 3.12.9）
    pub python_version: String,
    /// 解析出的 Python build identity（sha256 摘要）
    pub python_build: String,
    pub platform: String,
    pub libc: Option<String>,
    pub lock_sha256: String,
    pub groups: Vec<String>,
    pub extras: Vec<String>,
    pub created_at: String,
    pub last_used_at: String,
}

impl EnvironmentManifest {
    pub fn parse(data: &[u8]) -> Result<Self> {
        let manifest: EnvironmentManifest = serde_json::from_slice(data).map_err(|e| {
            RunnerError::managed(
                crate::runtime::code::ENV_VERIFY,
                format!("invalid environment manifest: {e}"),
            )
        })?;
        if manifest.schema != crate::runtime::SCHEMA {
            return Err(RunnerError::managed(
                crate::runtime::code::ENV_VERIFY,
                format!("unsupported manifest schema {}", manifest.schema),
            ));
        }
        if manifest.environment_id.len() != crate::runtime::envid::ENV_ID_LEN
            || !manifest
                .environment_id
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
        {
            return Err(RunnerError::managed(
                crate::runtime::code::ENV_VERIFY,
                "manifest environment id is invalid",
            ));
        }
        Ok(manifest)
    }

    pub fn to_json(&self) -> Result<Vec<u8>> {
        serde_json::to_vec_pretty(self)
            .map_err(|e| RunnerError::InvalidInput(format!("cannot serialize manifest: {e}")))
    }
}

/// 原子写：临时文件 + 同目录 rename
pub async fn write_atomic(
    host: &dyn crate::runtime::host::RuntimeHost,
    path: &str,
    data: &[u8],
) -> Result<()> {
    let tmp = format!("{path}.tmp-{}", uuid::Uuid::new_v4());
    let result = async {
        host.write_file(&tmp, data, 0o600).await?;
        host.rename(&tmp, path).await
    }
    .await;
    if result.is_err() {
        let _ = host.remove(&tmp).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> EnvironmentManifest {
        EnvironmentManifest {
            schema: 1,
            environment_id: "a".repeat(32),
            uv_version: "0.12.13".into(),
            python_request: "3.12.9".into(),
            python_executable: "/home/u/.remote-runner/runtime-v1/envs/x/bin/python".into(),
            python_version: "3.12.9".into(),
            python_build: "build".into(),
            platform: "linux-x86_64-gnu".into(),
            libc: Some("gnu".into()),
            lock_sha256: "c".repeat(64),
            groups: vec!["default".into()],
            extras: vec![],
            created_at: "2026-09-16T00:00:00+08:00".into(),
            last_used_at: "2026-09-16T00:00:00+08:00".into(),
        }
    }

    #[test]
    fn manifest_roundtrips_and_rejects_tampering() {
        let m = manifest();
        let parsed = EnvironmentManifest::parse(&m.to_json().unwrap()).unwrap();
        assert_eq!(parsed.environment_id, m.environment_id);
        let mut bad = m.clone();
        bad.schema = 99;
        assert!(EnvironmentManifest::parse(&bad.to_json().unwrap()).is_err());
        let mut bad = m.clone();
        bad.environment_id = "../escape".into();
        assert!(EnvironmentManifest::parse(&bad.to_json().unwrap()).is_err());
        assert!(EnvironmentManifest::parse(b"not json").is_err());
    }
}
