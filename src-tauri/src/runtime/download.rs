//! uv 资产的桌面端下载、安全解包与本地内容缓存（00027 §9）。
//!
//! - URL/长度/SHA256 全部来自 Runtime Catalog（下载前已校验 allowlist）；
//! - 解包只接受 Catalog 指定的单个 uv 可执行文件，拒绝绝对路径、`..`、链接和额外文件；
//! - 目录网络不可用或下载被禁用时返回明确错误（测试默认不依赖公网）。
use crate::error::{Result, RunnerError};
use crate::runtime::catalog::UvAsset;
use crate::runtime::code;
use sha2::Digest;

pub struct UvBinary {
    pub bytes: Vec<u8>,
    pub sha256: String,
}

pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = sha2::Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

/// 下载 Catalog 资产并校验长度与 SHA256（校验失败即报错，不使用坏资产）
pub fn download_asset(asset: &UvAsset, connect_timeout: std::time::Duration) -> Result<Vec<u8>> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(connect_timeout)
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| {
            RunnerError::managed(
                code::UV_ASSET_VERIFY,
                format!("cannot build downloader: {e}"),
            )
        })?;
    let response = client.get(&asset.url).send().map_err(|e| {
        RunnerError::managed(
            code::UV_ASSET_VERIFY,
            format!("uv asset download failed: {e}"),
        )
    })?;
    let bytes = response.bytes().map_err(|e| {
        RunnerError::managed(code::UV_ASSET_VERIFY, format!("uv asset read failed: {e}"))
    })?;
    verify_archive(asset, &bytes)?;
    Ok(bytes.to_vec())
}

fn verify_archive(asset: &UvAsset, data: &[u8]) -> Result<()> {
    if asset.size > 0 && data.len() as u64 != asset.size {
        return Err(RunnerError::managed(
            code::UV_ASSET_VERIFY,
            format!(
                "uv asset size mismatch: expected {}, got {}",
                asset.size,
                data.len()
            ),
        ));
    }
    let got = sha256_hex(data);
    if got != asset.sha256 {
        return Err(RunnerError::managed(
            code::UV_ASSET_VERIFY,
            "uv asset sha256 mismatch",
        ));
    }
    Ok(())
}

/// 从归档中解出唯一的 uv 可执行文件。
/// tar.gz（unix）或 zip（windows）：只接受单个常规文件条目，名字必须为 `uv`/`uv.exe`；
/// 允许一层归档自带目录前缀；拒绝绝对路径、`..`、链接与额外文件。
pub fn unpack_uv(archive: &[u8], windows: bool) -> Result<UvBinary> {
    let expect = if windows { "uv.exe" } else { "uv" };
    let bytes = if windows {
        unpack_zip(archive, expect)?
    } else {
        unpack_tar_gz(archive, expect)?
    };
    Ok(UvBinary {
        sha256: sha256_hex(&bytes),
        bytes,
    })
}

fn entry_name_ok(name: &str, expect: &str) -> Result<()> {
    let normalized = name.replace('\\', "/");
    if normalized.starts_with('/') || normalized.split('/').any(|p| p == "..") {
        return Err(RunnerError::managed(
            code::UV_ASSET_VERIFY,
            format!("uv archive contains unsafe path {name:?}"),
        ));
    }
    let leaf = normalized.rsplit('/').next().unwrap_or(normalized.as_str());
    if leaf != expect {
        return Err(RunnerError::managed(
            code::UV_ASSET_VERIFY,
            format!("uv archive contains unexpected file {name:?}"),
        ));
    }
    Ok(())
}

fn unpack_tar_gz(archive: &[u8], expect: &str) -> Result<Vec<u8>> {
    use std::io::Read;
    let decoder = flate2::read::GzDecoder::new(archive);
    let mut tar = tar::Archive::new(decoder);
    let mut found: Option<Vec<u8>> = None;
    for entry in tar.entries().map_err(|e| bad_archive(e.to_string()))? {
        let entry = entry.map_err(|e| bad_archive(e.to_string()))?;
        let header = entry.header();
        if matches!(
            header.entry_type(),
            tar::EntryType::Symlink | tar::EntryType::Link | tar::EntryType::GNULongLink
        ) {
            return Err(RunnerError::managed(
                code::UV_ASSET_VERIFY,
                "uv archive contains links",
            ));
        }
        if !header.entry_type().is_file() {
            continue;
        }
        let name = String::from_utf8_lossy(&header.path_bytes()).into_owned();
        entry_name_ok(&name, expect)?;
        if found.is_some() {
            return Err(RunnerError::managed(
                code::UV_ASSET_VERIFY,
                "uv archive contains more than one file",
            ));
        }
        let mut data = Vec::with_capacity(header.size().unwrap_or(0) as usize);
        entry
            .take(64 * 1024 * 1024)
            .read_to_end(&mut data)
            .map_err(|e| bad_archive(e.to_string()))?;
        found = Some(data);
    }
    found.ok_or_else(|| RunnerError::managed(code::UV_ASSET_VERIFY, "uv archive has no uv binary"))
}

fn unpack_zip(archive: &[u8], expect: &str) -> Result<Vec<u8>> {
    use std::io::Read;
    let reader = std::io::Cursor::new(archive);
    let mut zip = zip::ZipArchive::new(reader).map_err(|e| bad_archive(e.to_string()))?;
    let mut found: Option<Vec<u8>> = None;
    for i in 0..zip.len() {
        let file = zip.by_index(i).map_err(|e| bad_archive(e.to_string()))?;
        if file.is_symlink() || file.is_dir() {
            if file.is_symlink() {
                return Err(RunnerError::managed(
                    code::UV_ASSET_VERIFY,
                    "uv archive contains links",
                ));
            }
            continue;
        }
        entry_name_ok(file.name(), expect)?;
        if found.is_some() {
            return Err(RunnerError::managed(
                code::UV_ASSET_VERIFY,
                "uv archive contains more than one file",
            ));
        }
        let mut data = Vec::with_capacity(file.size() as usize);
        file.take(64 * 1024 * 1024)
            .read_to_end(&mut data)
            .map_err(|e| bad_archive(e.to_string()))?;
        found = Some(data);
    }
    found.ok_or_else(|| RunnerError::managed(code::UV_ASSET_VERIFY, "uv archive has no uv binary"))
}

fn bad_archive(detail: String) -> RunnerError {
    RunnerError::managed(
        code::UV_ASSET_VERIFY,
        format!("invalid uv archive: {detail}"),
    )
}

/// 本地内容缓存路径：downloads/<uv-version>/<platform>/<archive 文件名>
pub fn cache_path(
    cache_dir: &std::path::Path,
    uv_version: &str,
    platform: &str,
    url: &str,
) -> std::path::PathBuf {
    let file = url.rsplit('/').next().unwrap_or("uv.bin");
    cache_dir
        .join("uv-assets")
        .join(uv_version)
        .join(platform)
        .join(file)
}

/// 读取本地缓存资产并重新校验（缓存不降低校验强度）
pub fn cached_asset(
    cache_dir: &std::path::Path,
    asset: &UvAsset,
    uv_version: &str,
) -> Result<Option<Vec<u8>>> {
    let path = cache_path(cache_dir, uv_version, &asset.platform, &asset.url);
    let Ok(data) = std::fs::read(&path) else {
        return Ok(None);
    };
    match verify_archive(asset, &data) {
        Ok(()) => Ok(Some(data)),
        Err(_) => {
            let _ = std::fs::remove_file(&path);
            Ok(None)
        }
    }
}

pub fn store_cache(
    cache_dir: &std::path::Path,
    asset: &UvAsset,
    uv_version: &str,
    archive: &[u8],
) -> Result<()> {
    let path = cache_path(cache_dir, uv_version, &asset.platform, &asset.url);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("part");
    std::fs::write(&tmp, archive)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    use std::io::Write as _;

    /// 手写 ustar 头（tar 0.4 的 set_path 拒绝 `..`/绝对路径，无法用它构造恶意条目）
    fn raw_header(name: &str, size: u64) -> [u8; 512] {
        let mut h = [0u8; 512];
        let nb = name.as_bytes();
        assert!(nb.len() <= 100, "test entry name too long");
        h[..nb.len()].copy_from_slice(nb);
        h[100..108].copy_from_slice(b"0000755\0");
        h[108..116].copy_from_slice(b"0000000\0");
        h[116..124].copy_from_slice(b"0000000\0");
        h[124..136].copy_from_slice(format!("{:011o}\0", size).as_bytes());
        h[136..148].copy_from_slice(b"00000000000\0");
        h[148..156].fill(b' ');
        h[156] = b'0';
        h[257..263].copy_from_slice(b"ustar\0");
        h[263..265].copy_from_slice(b"00");
        let sum: u64 = h.iter().map(|&b| u64::from(b)).sum();
        h[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
        h
    }

    fn tar_gz_with(files: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Write as _;
        let mut buffer = Vec::new();
        {
            let mut encoder =
                flate2::write::GzEncoder::new(&mut buffer, flate2::Compression::fast());
            for (name, data) in files {
                encoder
                    .write_all(&raw_header(name, data.len() as u64))
                    .unwrap();
                encoder.write_all(data).unwrap();
                let pad = (512 - (data.len() % 512)) % 512;
                encoder.write_all(&[0u8; 512][..pad]).unwrap();
            }
            // tar 结束标记：两个全零块
            encoder.write_all(&[0u8; 1024]).unwrap();
            encoder.finish().unwrap();
        }
        buffer
    }

    #[test]
    fn unpack_accepts_single_binary_with_directory_prefix() {
        let archive = tar_gz_with(&[(
            "uv-x86_64-unknown-linux-gnu/uv",
            b"#!/bin/sh\necho uv 0.12.13",
        )]);
        let binary = unpack_uv(&archive, false).unwrap();
        assert!(binary.bytes.starts_with(b"#!"));
        assert_eq!(binary.sha256.len(), 64);
    }

    #[test]
    fn unpack_rejects_links_extra_files_and_path_escape() {
        // 额外文件
        let archive = tar_gz_with(&[("uv", b"a"), ("extra.txt", b"b")]);
        assert!(unpack_uv(&archive, false).is_err());
        // 路径逃逸
        let archive = tar_gz_with(&[("../uv", b"a")]);
        assert!(unpack_uv(&archive, false).is_err());
        // 绝对路径
        let archive = tar_gz_with(&[("/tmp/uv", b"a")]);
        assert!(unpack_uv(&archive, false).is_err());
        // 空归档
        let archive = tar_gz_with(&[]);
        assert!(unpack_uv(&archive, false).is_err());
    }

    #[test]
    fn unpack_rejects_symlinks() {
        let mut buffer = Vec::new();
        {
            let encoder = flate2::write::GzEncoder::new(&mut buffer, flate2::Compression::fast());
            let mut tar = tar::Builder::new(encoder);
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            header.set_cksum();
            tar.append_link(&mut header, "uv", "/bin/sh").unwrap();
            tar.finish().unwrap();
        }
        assert!(unpack_uv(&buffer, false).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn unpack_zip_windows_shape() {
        let mut buffer = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
            let options: zip::write::FileOptions<()> = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zip.start_file("uv-x86_64-pc-windows-msvc/uv.exe", options)
                .unwrap();
            zip.write_all(b"MZ").unwrap();
            zip.finish().unwrap();
        }
        let binary = unpack_uv(&buffer, true).unwrap();
        assert_eq!(binary.bytes, b"MZ");
    }

    #[test]
    fn cache_roundtrip_and_tamper_eviction() {
        let dir = std::env::temp_dir().join(format!("rr-dl-{}", uuid::Uuid::new_v4()));
        let asset = UvAsset {
            platform: "linux-x86_64-gnu".into(),
            url: "https://github.com/astral-sh/uv/releases/download/0.12.13/uv-x86_64-unknown-linux-gnu.tar.gz".into(),
            size: 0,
            sha256: sha256_hex(b"archive"),
        };
        assert!(cached_asset(&dir, &asset, "0.12.13").unwrap().is_none());
        store_cache(&dir, &asset, "0.12.13", b"archive").unwrap();
        assert_eq!(
            cached_asset(&dir, &asset, "0.12.13").unwrap().as_deref(),
            Some(b"archive".as_slice())
        );
        // 篡改缓存 → 校验失败并清除
        let path = cache_path(&dir, "0.12.13", &asset.platform, &asset.url);
        std::fs::write(&path, b"tampered").unwrap();
        assert!(cached_asset(&dir, &asset, "0.12.13").unwrap().is_none());
        assert!(!path.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
