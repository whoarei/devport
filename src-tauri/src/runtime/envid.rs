//! Environment ID：内容寻址（00005-python-runtime.md）。
//!
//! 项目源码不进入 ID（根项目不安装进环境）；修改脚本不会重建第三方依赖环境。
use sha2::Digest;

pub const ENV_ID_LEN: usize = 32;

/// 计算 Environment ID（hex 前缀，截断至 32 字符便于路径与展示）
pub fn compute(
    uv_version: &str,
    platform: &str,
    python_version: &str,
    python_build: &str,
    device_os: &str,
    device_arch: &str,
    device_libc: Option<&str>,
    lock_sha256: &str,
    groups: &[String],
    extras: &[String],
    package_source_identity: &str,
) -> String {
    let mut parts: Vec<String> = vec![
        format!("schema={}", crate::runtime::SCHEMA),
        format!("uv={uv_version}"),
        format!("platform={platform}"),
        format!("python={python_version}"),
        format!("build={python_build}"),
        format!(
            "device={device_os}-{device_arch}-{}",
            device_libc.unwrap_or("none")
        ),
        format!("lock={lock_sha256}"),
        format!("src={package_source_identity}"),
    ];
    let mut groups = groups.to_vec();
    groups.sort();
    groups.dedup();
    parts.extend(groups.iter().map(|g| format!("group={g}")));
    let mut extras = extras.to_vec();
    extras.sort();
    extras.dedup();
    parts.extend(extras.iter().map(|e| format!("extra={e}")));

    let mut hasher = sha2::Sha256::new();
    hasher.update(parts.join("\n").as_bytes());
    format!("{:x}", hasher.finalize())[..ENV_ID_LEN].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compute_with(lock: &str, groups: &[&str], extras: &[&str], build: &str) -> String {
        compute(
            "0.12.13",
            "linux-x86_64-gnu",
            "3.12.9",
            build,
            "linux",
            "x86_64",
            Some("gnu"),
            lock,
            &groups.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            &extras.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            "src-id",
        )
    }

    #[test]
    fn id_is_stable_and_sensitive_to_each_input() {
        let base = compute_with("a".repeat(64).as_str(), &["dev"], &["pdf"], "build-1");
        assert_eq!(base.len(), ENV_ID_LEN);
        assert_eq!(
            base,
            compute_with("a".repeat(64).as_str(), &["dev"], &["pdf"], "build-1")
        );
        // 每个输入变化都改变 ID
        assert_ne!(
            base,
            compute_with("b".repeat(64).as_str(), &["dev"], &["pdf"], "build-1")
        );
        assert_ne!(
            base,
            compute_with("a".repeat(64).as_str(), &["other"], &["pdf"], "build-1")
        );
        assert_ne!(
            base,
            compute_with("a".repeat(64).as_str(), &["dev"], &["other"], "build-1")
        );
        assert_ne!(
            base,
            compute_with("a".repeat(64).as_str(), &["dev"], &["pdf"], "build-2")
        );
        // 组/额外项顺序无关
        assert_eq!(
            compute_with("a".repeat(64).as_str(), &["a", "b"], &["x", "y"], "build-1"),
            compute_with("a".repeat(64).as_str(), &["b", "a"], &["y", "x"], "build-1")
        );
        // 组与额外项属于不同维度
        assert_ne!(
            compute_with("a".repeat(64).as_str(), &["x"], &[], "build-1"),
            compute_with("a".repeat(64).as_str(), &[], &["x"], "build-1")
        );
    }
}
