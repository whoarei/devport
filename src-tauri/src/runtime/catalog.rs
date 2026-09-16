//! Runtime Catalog：发布版本固定的 uv 版本与平台资产（00027 §6/§9）。
use crate::error::{Result, RunnerError};
use serde::Deserialize;

const EMBEDDED: &str = include_str!("uv-catalog.json");
const ALLOWED_HOST: &str = "github.com";
const URL_PREFIX: &str = "/astral-sh/uv/releases/download/";

#[derive(Debug, Clone, Deserialize)]
pub struct UvAsset {
    pub platform: String,
    pub url: String,
    /// 0 表示不在下载前断言大小（以 sha256 为准）
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCatalog {
    pub schema: u32,
    pub uv_version: String,
    pub assets: Vec<UvAsset>,
}

impl RuntimeCatalog {
    pub fn embedded() -> Result<&'static Self> {
        static CATALOG: std::sync::OnceLock<RuntimeCatalog> = std::sync::OnceLock::new();
        CATALOG
            .get_or_init(|| Self::parse(EMBEDDED).expect("embedded uv catalog must be valid"))
            .validate()
            .map(|_| CATALOG.get().unwrap())
    }

    /// 解析并校验 Catalog 结构；任何人（包括测试）都可注入自定义 Catalog
    pub fn parse(text: &str) -> Result<Self> {
        let catalog: RuntimeCatalog = serde_json::from_str(text)
            .map_err(|e| RunnerError::InvalidInput(format!("invalid runtime catalog: {e}")))?;
        catalog.validate().map(|_| catalog)
    }

    fn validate(&self) -> Result<()> {
        if self.schema != crate::runtime::SCHEMA {
            return Err(RunnerError::InvalidInput(format!(
                "unsupported runtime catalog schema {}",
                self.schema
            )));
        }
        if !is_exact_version(&self.uv_version) {
            return Err(RunnerError::InvalidInput(format!(
                "invalid pinned uv version {:?}",
                self.uv_version
            )));
        }
        if self.assets.is_empty() {
            return Err(RunnerError::InvalidInput(
                "runtime catalog has no assets".into(),
            ));
        }
        let mut seen = std::collections::HashSet::new();
        for asset in &self.assets {
            if !seen.insert(asset.platform.clone()) {
                return Err(RunnerError::InvalidInput(format!(
                    "duplicate catalog platform {}",
                    asset.platform
                )));
            }
            validate_asset_url(&asset.url, &self.uv_version)?;
            if asset.sha256.len() != 64 || !asset.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(RunnerError::InvalidInput(format!(
                    "invalid sha256 for platform {}",
                    asset.platform
                )));
            }
        }
        Ok(())
    }

    /// 按平台键选择资产；Catalog 未列出的平台明确失败，不按 uname 猜测
    pub fn select(&self, platform: &str) -> Result<&UvAsset> {
        self.assets
            .iter()
            .find(|a| a.platform == platform)
            .ok_or_else(|| RunnerError::ManagedRuntime {
                code: crate::runtime::code::UNSUPPORTED_PLATFORM,
                message: format!("platform {platform} is not in the runtime catalog"),
            })
    }
}

/// x.y.z 精确版本
pub fn is_exact_version(v: &str) -> bool {
    let mut parts = v.split('.');
    let ok = parts
        .by_ref()
        .take(3)
        .map(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        .eq([true, true, true]);
    ok && parts.next().is_none()
}

fn validate_asset_url(url: &str, uv_version: &str) -> Result<()> {
    let invalid = || RunnerError::InvalidInput(format!("invalid uv asset url: {url:?}"));
    let rest = url.strip_prefix("https://").ok_or_else(invalid)?;
    let (host, path) = rest.split_once('/').ok_or_else(invalid)?;
    if host != ALLOWED_HOST || !path.starts_with(URL_PREFIX.trim_start_matches('/')) {
        return Err(invalid());
    }
    // 资产必须位于固定版本的发布目录下（astral-sh/uv/releases/download/<tag>/...）
    let tag = path.split('/').nth(4).ok_or_else(invalid)?;
    if tag != uv_version {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_catalog_is_valid_and_selects_all_platforms() {
        let c = RuntimeCatalog::embedded().unwrap();
        assert_eq!(c.uv_version, "0.12.13");
        for platform in [
            "linux-x86_64-gnu",
            "linux-aarch64-gnu",
            "linux-x86_64-musl",
            "linux-aarch64-musl",
            "windows-x86_64",
            "windows-aarch64",
            "macos-x86_64",
            "macos-aarch64",
        ] {
            assert!(c.select(platform).is_ok(), "{platform}");
        }
        assert!(c.select("linux-riscv64-gnu").is_err());
    }

    #[test]
    fn exact_version_shape() {
        assert!(is_exact_version("0.12.13"));
        assert!(is_exact_version("3.12.9"));
        assert!(!is_exact_version("0.12"));
        assert!(!is_exact_version("0.12.x"));
        assert!(!is_exact_version("0.12.13.1"));
        assert!(!is_exact_version("beta1"));
    }

    #[test]
    fn url_allowlist_and_version_pinning_are_enforced() {
        let good = |v: &str| {
            format!(
            "https://github.com/astral-sh/uv/releases/download/{v}/uv-x86_64-unknown-linux-gnu.tar.gz"
        )
        };
        validate_asset_url(&good("0.12.13"), "0.12.13").unwrap();
        assert!(validate_asset_url(&good("0.12.12"), "0.12.13").is_err());
        assert!(validate_asset_url(
            "http://github.com/astral-sh/uv/releases/download/0.12.13/x",
            "0.12.13"
        )
        .is_err());
        assert!(validate_asset_url(
            "https://evil.com/astral-sh/uv/releases/download/0.12.13/x",
            "0.12.13"
        )
        .is_err());
        assert!(validate_asset_url(
            "https://github.com/other/repo/releases/download/0.12.13/x",
            "0.12.13"
        )
        .is_err());

        let text = format!(
            r#"{{"schema":1,"uvVersion":"0.12.13","assets":[{{"platform":"p","url":"{}","size":0,"sha256":"{}"}}]}}"#,
            good("0.12.13"),
            "z".repeat(64)
        );
        assert!(RuntimeCatalog::parse(&text).is_err(), "bad hex rejected");
        let dup = format!(
            r#"{{"schema":1,"uvVersion":"0.12.13","assets":[{{"platform":"p","url":"{}","size":0,"sha256":"{}"}},{{"platform":"p","url":"{}","size":0,"sha256":"{}"}}]}}"#,
            good("0.12.13"),
            "a".repeat(64),
            good("0.12.13"),
            "b".repeat(64)
        );
        assert!(
            RuntimeCatalog::parse(&dup).is_err(),
            "duplicate platform rejected"
        );
    }
}
