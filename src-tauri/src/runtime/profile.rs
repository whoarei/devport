//! DeviceRuntimeProfile 探测与支持矩阵校验（00005-python-runtime.md）。
//!
//! 重要边界：uv 二进制能运行不代表 native wheel 兼容；安装后仍有实际 Python smoke test。
use crate::error::{Result, RunnerError};
use crate::runtime::code;
use crate::runtime::host::{check_cancel, ExecResult, RuntimeHost};
use crate::runtime::DeviceRuntimeProfile;
use std::sync::atomic::AtomicBool;

/// posix 探测脚本：输出单行 `key=value`，只依赖 uname/getconf/df 等基础工具
const POSIX_PROBE: &str = r#"
s=$(uname -s 2>/dev/null || echo unknown)
m=$(uname -m 2>/dev/null || echo unknown)
r=$(uname -r 2>/dev/null || echo unknown)
libc=none; lv=
if command -v getconf >/dev/null 2>&1; then
  g=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
  case "$g" in glibc*) libc=gnu; lv=${g#glibc }; lv=${lv# };; esac
fi
if [ "$libc" = none ] && ls /lib/ld-musl-* >/dev/null 2>&1; then libc=musl; fi
kb=$(df -k "$HOME" 2>/dev/null | awk 'NR==2{print $4}')
printf 'RRPROBE s=%s m=%s r=%s libc=%s lv=%s kb=%s home=%s\n' "$s" "$m" "$r" "$libc" "$lv" "${kb:-}" "$HOME"
"#;

fn parse_probe_line(
    line: &str,
) -> Option<(String, String, String, String, String, Option<u64>, String)> {
    let line = line.trim();
    let line = line.strip_prefix("RRPROBE ")?.trim();
    let mut s = None;
    let mut m = None;
    let mut r = String::new();
    let mut libc = "none".to_string();
    let mut lv = String::new();
    let mut kb: Option<u64> = None;
    let mut home = String::new();
    for part in line.split_whitespace() {
        let (k, v) = part.split_once('=')?;
        match k {
            "s" => s = Some(v.to_string()),
            "m" => m = Some(v.to_string()),
            "r" => r = v.to_string(),
            "libc" => libc = v.to_string(),
            "lv" => lv = v.to_string(),
            "kb" => kb = v.parse::<u64>().ok().map(|k| k * 1024),
            "home" => home = v.to_string(),
            _ => {}
        }
    }
    Some((s?, m?, r, libc, lv, kb, home))
}

pub fn map_os(uname_s: &str) -> String {
    match uname_s.to_ascii_lowercase().as_str() {
        "linux" => "linux",
        "darwin" => "macos",
        other => other,
    }
    .to_string()
}

pub fn map_arch(uname_m: &str) -> Option<String> {
    match uname_m.to_ascii_lowercase().as_str() {
        "x86_64" | "amd64" => Some("x86_64"),
        "aarch64" | "arm64" => Some("aarch64"),
        _ => None,
    }
    .map(str::to_string)
}

/// 通过 host 探测目标 profile；posix 远端执行探测脚本，Windows 本机直接构造
pub async fn probe(host: &dyn RuntimeHost, cancel: &AtomicBool) -> Result<DeviceRuntimeProfile> {
    if host.is_windows() {
        return probe_local_windows(host, cancel).await;
    }
    check_cancel(cancel)?;
    let probe = host
        .exec(
            &["/bin/sh".into(), "-c".into(), POSIX_PROBE.into()],
            &[],
            None,
            None,
            cancel,
        )
        .await?;
    if !probe.success() {
        return Err(RunnerError::managed(
            code::UNSUPPORTED_PLATFORM,
            format!("runtime probe failed: {}", probe.tail(400)),
        ));
    }
    let line = String::from_utf8_lossy(&probe.stdout);
    let (s, m, r, libc, lv, free, home) = parse_probe_line(&line).ok_or_else(|| {
        RunnerError::managed(
            code::UNSUPPORTED_PLATFORM,
            "cannot parse runtime probe output",
        )
    })?;
    let os = map_os(&s);
    let arch = map_arch(&m).ok_or_else(|| {
        RunnerError::managed(
            code::UNSUPPORTED_ARCH,
            format!("unsupported architecture {m:?}"),
        )
    })?;
    let libc = match os.as_str() {
        "macos" => None,
        _ if libc == "none" => None,
        _ => Some(libc),
    };
    let runtime_root = match &home {
        h if !h.is_empty() => format!(
            "{}/{}",
            h.trim_end_matches('/'),
            crate::runtime::RUNTIME_DIR.trim_start_matches('~')
        ),
        _ => host.root().to_string(),
    };
    let mut profile = DeviceRuntimeProfile {
        os,
        arch,
        libc,
        libc_version: (!lv.is_empty()).then_some(lv),
        kernel: (!r.is_empty()).then_some(r),
        home: (!home.is_empty()).then_some(home),
        runtime_root,
        root_writable: false,
        root_executable: false,
        free_bytes: free,
    };
    probe_root_usable(host, &mut profile, cancel).await?;
    Ok(profile)
}

/// Windows 本机 profile（Local transport；MSVC 工具链）
async fn probe_local_windows(
    host: &dyn RuntimeHost,
    cancel: &AtomicBool,
) -> Result<DeviceRuntimeProfile> {
    check_cancel(cancel)?;
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        other => {
            return Err(RunnerError::managed(
                code::UNSUPPORTED_ARCH,
                format!("unsupported architecture {other}"),
            ))
        }
    }
    .to_string();
    let mut profile = DeviceRuntimeProfile {
        os: "windows".into(),
        arch,
        libc: Some("msvc".into()),
        libc_version: None,
        kernel: None,
        home: dirs::home_dir().map(|p| p.to_string_lossy().into_owned()),
        runtime_root: host.root().to_string(),
        root_writable: false,
        root_executable: false,
        // Windows 暂不估算剩余空间（避免平台 API 依赖），空间检查跳过
        free_bytes: None,
    };
    probe_root_usable(host, &mut profile, cancel).await?;
    Ok(profile)
}

/// 验证 Runtime 根目录可写/可执行：建目录、写仅当前用户可执行的探针并实际运行
async fn probe_root_usable(
    host: &dyn RuntimeHost,
    profile: &mut DeviceRuntimeProfile,
    cancel: &AtomicBool,
) -> Result<()> {
    check_cancel(cancel)?;
    crate::runtime::validate_runtime_root(&profile.runtime_root, host.is_windows()).map_err(
        |_| {
            RunnerError::managed(
                code::UNSUPPORTED_PLATFORM,
                format!(
                    "runtime root {:?} is not a valid absolute path",
                    profile.runtime_root
                ),
            )
        },
    )?;
    host.mkdir_all(&profile.runtime_root).await?;
    let probe_file = host.join(
        &profile.runtime_root,
        &format!(".probe-{}", uuid::Uuid::new_v4()),
    );
    let script = if host.is_windows() {
        // Windows：写一个 .cmd 探针并执行；失败仅表示不可执行
        let path = format!("{probe_file}.cmd");
        host.write_file(&path, b"@echo off\r\nexit /b 0\r\n", 0o700)
            .await?;
        let result = host
            .exec(
                &["cmd.exe".into(), "/C".into(), path.clone()],
                &[],
                None,
                None,
                cancel,
            )
            .await;
        let _ = host.remove(&path).await;
        profile.root_writable = result.is_ok();
        profile.root_executable = result.as_ref().is_ok_and(|r| r.success());
        return Ok(());
    } else {
        host.write_file(&probe_file, b"#!/bin/sh\nexit 0\n", 0o700)
            .await?;
        host.exec(&[probe_file.clone()], &[], None, None, cancel)
            .await
    };
    profile.root_writable = true;
    profile.root_executable = script.as_ref().is_ok_and(|r| r.success());
    let _ = host.remove(&probe_file).await;
    Ok(())
}

/// 支持矩阵校验：Catalog 未明确列出的平台一律明确失败（00005-python-runtime.md）
pub fn check_support(profile: &DeviceRuntimeProfile) -> Result<()> {
    match profile.os.as_str() {
        "linux" | "macos" | "windows" => {}
        other => {
            return Err(RunnerError::managed(
                code::UNSUPPORTED_PLATFORM,
                format!("unsupported target OS {other:?}"),
            ))
        }
    }
    if !matches!(profile.arch.as_str(), "x86_64" | "aarch64") {
        return Err(RunnerError::managed(
            code::UNSUPPORTED_ARCH,
            format!("unsupported architecture {:?}", profile.arch),
        ));
    }
    match profile.os.as_str() {
        "linux" => match profile.libc.as_deref() {
            Some("gnu") | Some("musl") => {}
            other => {
                return Err(RunnerError::managed(
                    code::UNSUPPORTED_LIBC,
                    format!(
                    "unsupported libc {other:?}; only glibc and musl Linux targets are supported"
                ),
                ))
            }
        },
        "windows" | "macos" => {}
        _ => {}
    }
    if !profile.root_writable || !profile.root_executable {
        return Err(RunnerError::managed(
            code::ROOT_NOT_EXECUTABLE,
            format!(
                "runtime root {:?} is not writable/executable for the current user",
                profile.runtime_root
            ),
        ));
    }
    if let Some(free) = profile.free_bytes {
        if free < crate::runtime::MIN_FREE_BYTES {
            return Err(RunnerError::managed(
                code::INSUFFICIENT_SPACE,
                format!(
                    "insufficient disk space at runtime root: {} MiB free, {} MiB required",
                    free / (1024 * 1024),
                    crate::runtime::MIN_FREE_BYTES / (1024 * 1024)
                ),
            ));
        }
    }
    Ok(())
}

#[allow(dead_code)]
fn _assert_exec_result_send(_: ExecResult) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_probe_line() {
        let (s, m, r, libc, lv, kb, home) = parse_probe_line(
            "RRPROBE s=Linux m=x86_64 r=6.8.0 libc=gnu lv=2.35 kb=1024 home=/home/u",
        )
        .unwrap();
        assert_eq!(s, "Linux");
        assert_eq!(m, "x86_64");
        assert_eq!(r, "6.8.0");
        assert_eq!(libc, "gnu");
        assert_eq!(lv, "2.35");
        assert_eq!(kb, Some(1024 * 1024));
        assert_eq!(home, "/home/u");
        assert!(parse_probe_line("no marker").is_none());
        // musl 与 macOS 形状
        let (_, _, _, libc, _, _, _) =
            parse_probe_line("RRPROBE s=Linux m=aarch64 r=6.1 libc=musl lv= kb= home=/root")
                .unwrap();
        assert_eq!(libc, "musl");
        let (s, m, _, libc, _, _, _) =
            parse_probe_line("RRPROBE s=Darwin m=arm64 r=23 libc=none lv= kb= home=/Users/u")
                .unwrap();
        assert_eq!(map_os(&s), "macos");
        assert_eq!(map_arch(&m).as_deref(), Some("aarch64"));
        assert_eq!(libc, "none");
    }

    #[test]
    fn check_support_enforces_matrix() {
        let p =
            |os: &str, arch: &str, libc: Option<&str>, free: Option<u64>| DeviceRuntimeProfile {
                os: os.into(),
                arch: arch.into(),
                libc: libc.map(str::to_string),
                libc_version: None,
                kernel: None,
                home: None,
                runtime_root: "/home/u/.remote-runner/runtime-v1".into(),
                root_writable: true,
                root_executable: true,
                free_bytes: free,
            };
        assert!(check_support(&p("linux", "x86_64", Some("gnu"), Some(3 << 30))).is_ok());
        assert!(check_support(&p("linux", "aarch64", Some("musl"), Some(3 << 30))).is_ok());
        assert!(check_support(&p("macos", "aarch64", None, Some(3 << 30))).is_ok());
        assert!(check_support(&p("windows", "x86_64", Some("msvc"), None)).is_ok());
        assert!(
            check_support(&p("freebsd", "x86_64", Some("gnu"), Some(3 << 30)))
                .unwrap_err()
                .to_string()
                .contains(code::UNSUPPORTED_PLATFORM)
        );
        assert!(
            check_support(&p("linux", "riscv64", Some("gnu"), Some(3 << 30)))
                .unwrap_err()
                .to_string()
                .contains(code::UNSUPPORTED_ARCH)
        );
        assert!(check_support(&p("linux", "x86_64", None, Some(3 << 30)))
            .unwrap_err()
            .to_string()
            .contains(code::UNSUPPORTED_LIBC));
        assert!(
            check_support(&p("linux", "x86_64", Some("gnu"), Some(1024)))
                .unwrap_err()
                .to_string()
                .contains(code::INSUFFICIENT_SPACE)
        );
        let mut locked_down = p("linux", "x86_64", Some("gnu"), Some(3 << 30));
        locked_down.root_executable = false;
        assert!(check_support(&locked_down)
            .unwrap_err()
            .to_string()
            .contains(code::ROOT_NOT_EXECUTABLE));
    }
}
