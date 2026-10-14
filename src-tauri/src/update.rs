//! Stable Windows NSIS updates. Rust owns the checked update and installation gate.
use crate::commands::AppState;
use crate::error::{Result, RunnerError};
use serde::Serialize;
#[cfg(any(all(windows, not(debug_assertions)), test))]
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::{Mutex, RwLock, RwLockReadGuard, RwLockWriteGuard};

const RELEASES_URL: &str = "https://github.com/whoarei/remote-runner/releases/latest";

#[derive(Default)]
pub struct UpdateState {
    // Serialize checks/installs and pin the exact metadata the user reviewed.
    checked: Mutex<Option<Update>>,
    run_gate: RwLock<()>,
}

impl UpdateState {
    pub fn allow_run(&self) -> Result<RwLockReadGuard<'_, ()>> {
        self.run_gate
            .try_read()
            .map_err(|_| RunnerError::Update("正在升级，请等待应用重新启动".into()))
    }

    fn begin_install(
        &self,
        has_active_runs: impl FnOnce() -> bool,
    ) -> Result<RwLockWriteGuard<'_, ()>> {
        let guard = self
            .run_gate
            .try_write()
            .map_err(|_| RunnerError::Update("任务正在启动或应用正在升级，请稍后重试".into()))?;
        if has_active_runs() {
            return Err(RunnerError::Update(
                "请先停止所有运行任务并关闭终端，再安装更新".into(),
            ));
        }
        Ok(guard)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AppUpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    pub download_url: String,
    pub can_auto_install: bool,
}

#[derive(Debug, Clone, Serialize)]
struct DownloadProgress {
    phase: &'static str,
    downloaded: u64,
    total: Option<u64>,
}

// Compare actual files, not directory prefixes. NSIS quotes InstallLocation.
#[cfg(any(all(windows, not(debug_assertions)), test))]
fn matches_installation(exe: &Path, location: &str, uninstaller: &str) -> bool {
    let root = Path::new(location.trim_matches('"'));
    let uninstall = Path::new(uninstaller.trim_matches('"'));
    if !root.is_absolute() || !uninstall.is_absolute() || !root.join("uninstall.exe").is_file() {
        return false;
    }
    match (
        exe.canonicalize(),
        root.join("remote-runner.exe").canonicalize(),
        uninstall.canonicalize(),
        root.join("uninstall.exe").canonicalize(),
    ) {
        (Ok(exe), Ok(installed), Ok(uninstall), Ok(expected)) => {
            exe == installed && uninstall == expected
        }
        _ => false,
    }
}

fn current_exe_is_installed() -> bool {
    // This release channel builds currentUser NSIS only. Other forms use manual download.
    #[cfg(all(windows, target_arch = "x86_64", not(debug_assertions)))]
    {
        use winreg::{enums::*, RegKey};
        let Ok(exe) = std::env::current_exe() else {
            return false;
        };
        let root = RegKey::predef(HKEY_CURRENT_USER);
        for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
            let Ok(key) = root.open_subkey_with_flags(
                r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Remote Runner",
                KEY_READ | view,
            ) else {
                continue;
            };
            if let (Ok(location), Ok(uninstall)) = (
                key.get_value::<String, _>("InstallLocation"),
                key.get_value::<String, _>("UninstallString"),
            ) {
                if matches_installation(&exe, &location, &uninstall) {
                    return true;
                }
            }
        }
    }
    false
}

fn newer_stable(current: &semver::Version, candidate: &semver::Version) -> bool {
    candidate.pre.is_empty() && candidate.cmp_precedence(current).is_gt()
}

fn validate_candidate(version: &str, url: &str, signature: &str) -> Result<()> {
    let prefix = format!("https://github.com/whoarei/remote-runner/releases/download/v{version}/");
    let asset = url.strip_prefix(&prefix).unwrap_or_default();
    if signature.trim().is_empty()
        || asset.is_empty()
        || !asset.ends_with("-setup.exe")
        || asset.contains(['/', '?', '#'])
    {
        return Err(RunnerError::Update(
            "更新清单的安装包地址或签名无效，请使用下载页面".into(),
        ));
    }
    Ok(())
}

fn require_checked_version(checked: Option<&str>, expected: &str) -> Result<()> {
    if checked != Some(expected) {
        return Err(RunnerError::Update("更新信息已失效，请重新检查更新".into()));
    }
    Ok(())
}

#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<Option<AppUpdateInfo>> {
    let mut checked = state
        .checked
        .try_lock()
        .map_err(|_| RunnerError::Update("正在检查或安装更新，请稍后重试".into()))?;
    *checked = None;
    let update = app
        .updater_builder()
        .timeout(Duration::from_secs(30))
        .version_comparator(|current, release| newer_stable(&current, &release.version))
        .build()
        .map_err(|e| RunnerError::Update(e.to_string()))?
        .check()
        .await
        .map_err(|e| RunnerError::Update(e.to_string()))?;
    let Some(mut update) = update else {
        return Ok(None);
    };
    validate_candidate(
        &update.version,
        update.download_url.as_str(),
        &update.signature,
    )?;
    // The plugin does not carry the check timeout into the download.
    update.timeout = Some(Duration::from_secs(600));
    let info = AppUpdateInfo {
        current_version: app.package_info().version.to_string(),
        latest_version: update.version.clone(),
        notes: update.body.clone(),
        published_at: update.date.map(|d| d.to_string()),
        download_url: RELEASES_URL.into(),
        can_auto_install: current_exe_is_installed(),
    };
    *checked = Some(update);
    Ok(Some(info))
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
    runs: State<'_, AppState>,
    expected_version: String,
) -> Result<()> {
    if !current_exe_is_installed() {
        return Err(RunnerError::Update(
            "未检测到受支持的 NSIS 安装，请使用下载页面更新".into(),
        ));
    }
    let checked = state
        .checked
        .try_lock()
        .map_err(|_| RunnerError::Update("正在检查或安装更新，请稍后重试".into()))?;
    require_checked_version(
        checked.as_ref().map(|u| u.version.as_str()),
        &expected_version,
    )?;
    let update = checked.as_ref().unwrap();
    // run_script holds the read side until the run is registered, closing the start/install race.
    let _gate = state.begin_install(|| {
        !runs.run_manager.list_running().is_empty()
            || runs.terminal_manager.has_active()
            || runs.transfer_manager.has_active()
    })?;
    let mut downloaded = 0u64;
    let mut last_emit = Instant::now();
    let bytes = update
        .download(
            |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                if last_emit.elapsed() >= Duration::from_millis(100) || total == Some(downloaded) {
                    let _ = app.emit(
                        "app-update://progress",
                        DownloadProgress {
                            phase: "downloading",
                            downloaded,
                            total,
                        },
                    );
                    last_emit = Instant::now();
                }
            },
            || {
                let _ = app.emit(
                    "app-update://progress",
                    DownloadProgress {
                        phase: "verifying",
                        downloaded: 0,
                        total: None,
                    },
                );
            },
        )
        .await
        .map_err(|e| RunnerError::Update(e.to_string()))?;
    // download() verifies the embedded minisign public key before returning bytes.
    let _ = app.emit(
        "app-update://progress",
        DownloadProgress {
            phase: "installing",
            downloaded,
            total: Some(downloaded),
        },
    );
    // Windows exits here after launching NSIS; the installer restarts the app (/R).
    update
        .install(bytes)
        .map_err(|e| RunnerError::Update(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_versions_use_semver_precedence() {
        for (current, candidate, expected) in [
            ("0.2.0", "0.10.0", true),
            ("0.2.0", "0.2.0", false),
            ("0.3.0", "0.2.0", false),
            ("0.2.0", "0.3.0-rc.1", false),
            ("0.2.0", "0.2.0+build2", false),
            ("0.3.0-rc.1", "0.3.0", true),
        ] {
            assert_eq!(
                newer_stable(&current.parse().unwrap(), &candidate.parse().unwrap()),
                expected
            );
        }
    }

    #[test]
    fn rejects_changed_or_unchecked_updates() {
        assert!(require_checked_version(None, "0.3.0").is_err());
        assert!(require_checked_version(Some("0.4.0"), "0.3.0").is_err());
        assert!(require_checked_version(Some("0.3.0"), "0.3.0").is_ok());
    }

    #[test]
    fn validates_update_asset_origin_and_format() {
        let valid = "https://github.com/whoarei/remote-runner/releases/download/v0.3.0/Remote.Runner_0.3.0_x64-setup.exe";
        assert!(validate_candidate("0.3.0", valid, "signature").is_ok());
        assert!(validate_candidate("0.3.0", valid, "").is_err());
        for invalid in [
            valid.replace("https:", "http:"),
            valid.replace("github.com", "evil.example"),
            valid.replace("whoarei", "other"),
            valid.replace("v0.3.0", "v0.4.0"),
            valid.replace("-setup.exe", "-portable.exe"),
            format!("{valid}?redirect=1"),
        ] {
            assert!(validate_candidate("0.3.0", &invalid, "signature").is_err());
        }
    }

    #[test]
    fn install_gate_blocks_runs_and_releases_on_failure() {
        let state = UpdateState::default();
        let start = state.allow_run().unwrap();
        assert!(state.begin_install(|| false).is_err());
        drop(start);
        assert!(state.begin_install(|| true).is_err());
        let install = state.begin_install(|| false).unwrap();
        assert!(state.allow_run().is_err());
        assert!(state.begin_install(|| false).is_err());
        drop(install);
        assert!(state.allow_run().is_ok());
    }

    #[test]
    fn installation_requires_exact_registered_files() {
        let root = std::env::temp_dir().join(format!("rr-update-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let exe = root.join("remote-runner.exe");
        let uninstall = root.join("uninstall.exe");
        let portable = root.join("portable.exe");
        std::fs::write(&exe, b"test").unwrap();
        std::fs::write(&portable, b"test").unwrap();
        let location = format!("\"{}\"", root.display());
        let uninstaller = format!("\"{}\"", uninstall.display());
        assert!(!matches_installation(&exe, &location, &uninstaller));
        std::fs::write(&uninstall, b"test").unwrap();
        assert!(matches_installation(&exe, &location, &uninstaller));
        assert!(!matches_installation(&portable, &location, &uninstaller));
        assert!(!matches_installation(
            &exe,
            &location,
            &portable.to_string_lossy()
        ));
        assert!(!matches_installation(&exe, "relative/path", &uninstaller));
        std::fs::remove_dir_all(root).unwrap();
    }
}
