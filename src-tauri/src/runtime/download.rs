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
/// tar.gz（unix）或 zip（windows）：只接受常规文件条目，主二进制名字必须为 `uv`/`uv.exe`；
/// 官方发布资产在同一目录随附 `uvx`（windows 另有 `uvw.exe`），这些伴生文件被容忍但跳过、
/// 不参与部署；允许一层归档自带目录前缀；拒绝绝对路径、`..`、链接与其余额外文件。
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

/// 归档条目分类：只有主二进制会被解出，官方随附的伴生可执行文件（`uvx`、`uvw.exe`）
/// 允许存在但必须与主二进制同目录，其余条目一律拒绝。
struct ArchiveLayout {
    expect: String,
    companions: Vec<String>,
    main_dir: Option<String>,
    main_count: usize,
    companion_leaves: Vec<String>,
    companion_dirs: Vec<String>,
}

impl ArchiveLayout {
    fn new(expect: &str) -> Self {
        let (stem, suffix) = match expect.strip_suffix(".exe") {
            Some(stem) => (stem, ".exe"),
            None => (expect, ""),
        };
        let mut companions = vec![format!("{stem}x{suffix}")];
        if !suffix.is_empty() {
            // `uvw.exe`：windows 上隐藏控制台的启动器，unix 资产不含
            companions.push(format!("{stem}w{suffix}"));
        }
        Self {
            expect: expect.to_string(),
            companions,
            main_dir: None,
            main_count: 0,
            companion_leaves: Vec::new(),
            companion_dirs: Vec::new(),
        }
    }

    /// `Ok(true)` = 主二进制（需要读取内容），`Ok(false)` = 可跳过的伴生文件
    fn classify(&mut self, name: &str) -> Result<bool> {
        let normalized = name.replace('\\', "/");
        if normalized.starts_with('/') || normalized.split('/').any(|p| p == "..") {
            return Err(RunnerError::managed(
                code::UV_ASSET_VERIFY,
                format!("uv archive contains unsafe path {name:?}"),
            ));
        }
        let (dir, leaf) = match normalized.rfind('/') {
            Some(index) => (
                normalized[..index].to_string(),
                normalized[index + 1..].to_string(),
            ),
            None => (String::new(), normalized.clone()),
        };
        if leaf == self.expect {
            self.main_count += 1;
            if self.main_count > 1 {
                return Err(RunnerError::managed(
                    code::UV_ASSET_VERIFY,
                    "uv archive contains more than one file",
                ));
            }
            self.main_dir = Some(dir);
            return Ok(true);
        }
        if self.companions.contains(&leaf) {
            if self.companion_leaves.contains(&leaf) {
                return Err(RunnerError::managed(
                    code::UV_ASSET_VERIFY,
                    format!("uv archive contains more than one {leaf}"),
                ));
            }
            self.companion_leaves.push(leaf);
            self.companion_dirs.push(dir);
            return Ok(false);
        }
        Err(RunnerError::managed(
            code::UV_ASSET_VERIFY,
            format!("uv archive contains unexpected file {name:?}"),
        ))
    }

    fn finish(&self, main: Option<Vec<u8>>) -> Result<Vec<u8>> {
        let main = main.ok_or_else(|| {
            RunnerError::managed(code::UV_ASSET_VERIFY, "uv archive has no uv binary")
        })?;
        if let Some(main_dir) = &self.main_dir {
            if self.companion_dirs.iter().any(|dir| dir != main_dir) {
                return Err(RunnerError::managed(
                    code::UV_ASSET_VERIFY,
                    "uv archive contains a companion binary outside the uv directory",
                ));
            }
        }
        Ok(main)
    }
}

fn unpack_tar_gz(archive: &[u8], expect: &str) -> Result<Vec<u8>> {
    use std::io::Read;
    let decoder = flate2::read::GzDecoder::new(archive);
    let mut tar = tar::Archive::new(decoder);
    let mut layout = ArchiveLayout::new(expect);
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
        if !layout.classify(&name)? {
            continue;
        }
        let mut data = Vec::with_capacity(header.size().unwrap_or(0) as usize);
        entry
            .take(64 * 1024 * 1024)
            .read_to_end(&mut data)
            .map_err(|e| bad_archive(e.to_string()))?;
        found = Some(data);
    }
    layout.finish(found)
}

fn unpack_zip(archive: &[u8], expect: &str) -> Result<Vec<u8>> {
    use std::io::Read;
    let reader = std::io::Cursor::new(archive);
    let mut zip = zip::ZipArchive::new(reader).map_err(|e| bad_archive(e.to_string()))?;
    let mut layout = ArchiveLayout::new(expect);
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
        if !layout.classify(file.name())? {
            continue;
        }
        let mut data = Vec::with_capacity(file.size() as usize);
        file.take(64 * 1024 * 1024)
            .read_to_end(&mut data)
            .map_err(|e| bad_archive(e.to_string()))?;
        found = Some(data);
    }
    layout.finish(found)
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

    /// 用 tar::Builder 构造官方发布布局（目录条目 + 合法条目名，无需手写头）
    fn tar_gz_release(dir: &str, files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buffer = Vec::new();
        {
            let encoder = flate2::write::GzEncoder::new(&mut buffer, flate2::Compression::fast());
            let mut builder = tar::Builder::new(encoder);
            if !dir.is_empty() {
                let mut header = tar::Header::new_gnu();
                header.set_entry_type(tar::EntryType::Directory);
                header.set_size(0);
                header.set_mode(0o755);
                header.set_cksum();
                builder.append_data(&mut header, dir, &[][..]).unwrap();
            }
            for (name, data) in files {
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(0o755);
                header.set_cksum();
                builder.append_data(&mut header, name, *data).unwrap();
            }
            builder.finish().unwrap();
        }
        buffer
    }

    /// 真实资产（0.12.13）在同一目录随附 `uvx`；x86_64 linux 归档里它排在 `uv` 之前
    #[test]
    fn unpack_accepts_release_companion_in_either_order() {
        let dir = "uv-x86_64-unknown-linux-gnu";
        for files in [
            vec![
                (format!("{dir}/uvx"), &b"trampoline"[..]),
                (format!("{dir}/uv"), &b"#!/bin/sh\nuv"[..]),
            ],
            vec![
                (format!("{dir}/uv"), &b"#!/bin/sh\nuv"[..]),
                (format!("{dir}/uvx"), &b"trampoline"[..]),
            ],
        ] {
            let entries: Vec<(&str, &[u8])> = files.iter().map(|(n, d)| (n.as_str(), *d)).collect();
            let binary = unpack_uv(&tar_gz_release(dir, &entries), false).unwrap();
            assert_eq!(binary.bytes, b"#!/bin/sh\nuv");
        }
    }

    #[test]
    fn unpack_rejects_companion_without_main_outside_dir_and_duplicated() {
        let dir = "uv-x86_64-unknown-linux-gnu";
        // 只有伴生文件：没有主二进制
        let archive = tar_gz_release(dir, &[(format!("{dir}/uvx").as_str(), &b"x"[..])]);
        assert!(unpack_uv(&archive, false).is_err());
        // 伴生文件不在主二进制目录内
        let archive = tar_gz_release(
            "",
            &[
                ("uv", &b"a"[..]),
                ("other/uvx", &b"x"[..]),
                ("uvx", &b"x"[..]),
            ],
        );
        assert!(unpack_uv(&archive, false).is_err());
        // 重复的伴生文件
        let archive = tar_gz_release(
            dir,
            &[("uv", &b"a"[..]), ("uvx", &b"x"[..]), ("uvx", &b"y"[..])],
        );
        assert!(unpack_uv(&archive, false).is_err());
        // 伴生文件之外的额外文件仍然拒绝
        let archive = tar_gz_release(
            dir,
            &[("uv", &b"a"[..]), ("uvx", &b"x"[..]), ("uvz", &b"z"[..])],
        );
        assert!(unpack_uv(&archive, false).is_err());
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

    /// 真实 windows 资产（0.12.13）无目录前缀，含 `uv.exe` + `uvx.exe` + `uvw.exe`
    #[cfg(windows)]
    #[test]
    fn unpack_zip_accepts_release_companions() {
        let mut buffer = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
            let options: zip::write::FileOptions<()> = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, data) in [
                ("uv.exe", &b"MZ"[..]),
                ("uvx.exe", &b"MZx"[..]),
                ("uvw.exe", &b"MZw"[..]),
            ] {
                zip.start_file(name, options).unwrap();
                zip.write_all(data).unwrap();
            }
            zip.finish().unwrap();
        }
        let binary = unpack_uv(&buffer, true).unwrap();
        assert_eq!(binary.bytes, b"MZ");

        // 未知的额外文件仍被拒绝
        let mut buffer = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(&mut buffer));
            let options: zip::write::FileOptions<()> = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            for (name, data) in [("uv.exe", &b"MZ"[..]), ("sshed.exe", &b"x"[..])] {
                zip.start_file(name, options).unwrap();
                zip.write_all(data).unwrap();
            }
            zip.finish().unwrap();
        }
        assert!(unpack_uv(&buffer, true).is_err());
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
