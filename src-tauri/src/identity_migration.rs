//! One-time import before Tauri creates its WebView or opens application stores.
//! Originals remain an inert backup. Existing DevPort directories always win.
use std::{
    fs, io,
    path::{Path, PathBuf},
};

pub const APP_ID: &str = "com.devport.app";
const LEGACY_ID: &str = "com.devrunner.remote-runner";
const MARKER: &str = ".devport-import-v1";

#[derive(Clone, Copy)]
enum Kind {
    Config,
    WebView,
}

fn linked(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn check_directory(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !linked(&meta) => Ok(true),
        Ok(_) => Err(io::Error::other("migration path must be a real directory")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

fn copy_tree(source: &Path, target: &Path) -> io::Result<()> {
    if !check_directory(source)? {
        return Ok(());
    }
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let meta = fs::symlink_metadata(entry.path())?;
        if linked(&meta) {
            return Err(io::Error::other(
                "migration refuses symbolic links and junctions",
            ));
        }
        let destination = target.join(entry.file_name());
        if meta.is_dir() {
            copy_tree(&entry.path(), &destination)?;
        } else if meta.is_file() {
            // LevelDB recreates its process lock. Never copy an active lock handle.
            if entry.file_name() == "LOCK" {
                continue;
            }
            fs::copy(entry.path(), &destination)?;
            let after = fs::metadata(entry.path())?;
            if meta.len() != after.len() || meta.modified()? != after.modified()? {
                return Err(io::Error::other(
                    "legacy data changed during migration; close Remote Runner and retry",
                ));
            }
        } else {
            return Err(io::Error::other("migration refuses special files"));
        }
    }
    Ok(())
}

struct Staged(PathBuf);
impl Drop for Staged {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn import(roots: &[(PathBuf, Kind)]) -> io::Result<()> {
    let mut stages = Vec::new();
    // Prepare every missing destination before committing any of them.
    for (parent, kind) in roots {
        let source = parent.join(LEGACY_ID);
        let target = parent.join(APP_ID);
        if check_directory(&target)? || !check_directory(&source)? {
            continue;
        }
        let stage = Staged(parent.join(format!(".devport-import-{}", uuid::Uuid::new_v4())));
        fs::create_dir(&stage.0)?;
        match kind {
            Kind::Config => copy_tree(&source, &stage.0)?,
            Kind::WebView => {
                // Only persistent application preferences are needed from WebView2.
                // Browser caches, cookies and machine-bound credentials are not imported.
                let relative = Path::new("EBWebView/Default/Local Storage");
                let profile = source.join(relative);
                // Reject redirected parents as well as redirected children.
                for ancestor in [source.join("EBWebView"), source.join("EBWebView/Default")] {
                    check_directory(&ancestor)?;
                }
                let lock_path = profile.join("leveldb/LOCK");
                let _profile_lock = if lock_path.is_file() {
                    let file = fs::OpenOptions::new()
                        .read(true)
                        .write(true)
                        .open(lock_path)?;
                    file.try_lock().map_err(|_| {
                        io::Error::other("close Remote Runner before importing its preferences")
                    })?;
                    Some(file)
                } else {
                    None
                };
                copy_tree(&profile, &stage.0.join(relative))?;
            }
        }
        fs::write(
            stage.0.join(MARKER),
            b"Imported from Remote Runner. Original data retained as backup.\n",
        )?;
        stages.push((stage, target));
    }
    for (stage, target) in stages {
        fs::rename(&stage.0, target)?;
    }
    Ok(())
}

pub fn prepare() -> io::Result<()> {
    let config = dirs::config_dir()
        .ok_or_else(|| io::Error::other("configuration directory unavailable"))?;
    fs::create_dir_all(&config)?;
    // OS file locking survives neither process exit nor a crash, so retries cannot
    // be stranded by an abandoned marker. Serialize simultaneous first launches.
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(config.join(".devport-import.lock"))?;
    lock.lock()?;
    let mut roots = vec![(config, Kind::Config)];
    if let Some(data) = dirs::data_dir() {
        if !roots.iter().any(|(path, _)| path == &data) {
            roots.push((data, Kind::Config));
        }
    }
    if let Some(local) = dirs::data_local_dir() {
        if !roots.iter().any(|(path, _)| path == &local) {
            roots.push((
                local,
                if cfg!(windows) {
                    Kind::WebView
                } else {
                    Kind::Config
                },
            ));
        }
    }
    import(&roots)?;
    #[cfg(windows)]
    migrate_autostart()?;
    Ok(())
}

#[cfg(any(windows, test))]
fn legacy_startup(command: &str) -> bool {
    let Some(exe) = command.trim().strip_suffix(" --minimized") else {
        return false;
    };
    let exe = exe.trim_matches('"');
    let name = exe.rsplit(['/', '\\']).next().unwrap_or_default();
    name.eq_ignore_ascii_case("remote-runner.exe")
        || (name.starts_with("Remote.Runner_") && name.ends_with("_x64-portable.exe"))
}

#[cfg(windows)]
fn migrate_autostart() -> io::Result<()> {
    use winreg::{enums::*, RegKey};
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(run) = root.open_subkey_with_flags(
        r"Software\Microsoft\Windows\CurrentVersion\Run",
        KEY_READ | KEY_WRITE,
    ) else {
        return Ok(());
    };
    let old = run.get_value::<String, _>("Remote Runner").ok();
    let current = run.get_value::<String, _>("DevPort").ok();
    let exe = std::env::current_exe()?;
    let quoted = format!("\"{}\" --minimized", exe.display());
    let plain = format!("{} --minimized", exe.display());
    let owned = current
        .as_deref()
        .is_some_and(|value| value == quoted || value == plain);
    let import = current.is_none() && old.as_deref().is_some_and(legacy_startup);
    if !owned && !import {
        return Ok(());
    }
    if import {
        run.set_value("DevPort", &quoted)?;
    }
    if let Ok(approved) = root.open_subkey_with_flags(
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run",
        KEY_READ | KEY_WRITE,
    ) {
        if approved.get_raw_value("DevPort").is_err() {
            if let Ok(value) = approved.get_raw_value("Remote Runner") {
                approved.set_raw_value("DevPort", &value)?;
            }
        }
        let _ = approved.delete_value("Remote Runner");
    }
    if old.as_deref().is_some_and(legacy_startup) {
        run.delete_value("Remote Runner")?;
    }
    Ok(())
}

pub fn report_failure(error: &io::Error) {
    tracing::error!("DevPort data migration failed: {error}");
    #[cfg(windows)]
    {
        let message = format!("DevPort 无法迁移旧版数据。请关闭 Remote Runner 后重试。原始数据未被删除。\n\nDevPort could not import legacy data. Close Remote Runner and retry. Original data is retained.\n\n{error}");
        let message: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
        let title: Vec<u16> = "DevPort".encode_utf16().chain(Some(0)).collect();
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW(
                std::ptr::null_mut(),
                message.as_ptr(),
                title.as_ptr(),
                0x10,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_import_only_recognizes_known_legacy_commands_and_app_id_matches_tauri() {
        assert!(legacy_startup(
            r#""C:\Users\name\Remote Runner\remote-runner.exe" --minimized"#
        ));
        assert!(legacy_startup(
            r"C:\Users\name\remote-runner.exe --minimized"
        ));
        assert!(!legacy_startup(r"C:\Other\app.exe --minimized"));
        assert!(!legacy_startup(
            r"C:\Other\remote-runner.exe --different-argument"
        ));
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], APP_ID);
    }
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("devport-import-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn import_preserves_devices_drafts_logs_and_preferences_without_a_runtime_dependency() {
        let fixture = Fixture::new();
        let config = fixture.0.join("roaming");
        let local = fixture.0.join("local");
        let old = config.join(LEGACY_ID);
        fs::create_dir_all(old.join("run_logs")).unwrap();
        for (name, bytes) in [
            ("devices.json", b"device-secret".as_slice()),
            ("work-environment.json", b"unsaved draft"),
            ("run_logs/1.log", b"\0\xffoutput"),
        ] {
            fs::write(old.join(name), bytes).unwrap();
        }
        let profile = local
            .join(LEGACY_ID)
            .join("EBWebView/Default/Local Storage/leveldb");
        fs::create_dir_all(&profile).unwrap();
        fs::write(profile.join("000003.log"), b"legacy preferences").unwrap();
        import(&[
            (config.clone(), Kind::Config),
            (local.clone(), Kind::WebView),
        ])
        .unwrap();
        assert_eq!(
            fs::read(config.join(APP_ID).join("work-environment.json")).unwrap(),
            b"unsaved draft"
        );
        assert_eq!(
            fs::read(config.join(APP_ID).join("run_logs/1.log")).unwrap(),
            b"\0\xffoutput"
        );
        assert_eq!(
            fs::read(
                local
                    .join(APP_ID)
                    .join("EBWebView/Default/Local Storage/leveldb/000003.log")
            )
            .unwrap(),
            b"legacy preferences"
        );
        fs::write(config.join(APP_ID).join("devices.json"), b"new devices").unwrap();
        import(&[(config.clone(), Kind::Config)]).unwrap();
        assert_eq!(
            fs::read(config.join(APP_ID).join("devices.json")).unwrap(),
            b"new devices"
        );
        assert_eq!(
            fs::read(old.join("devices.json")).unwrap(),
            b"device-secret"
        );
        fs::remove_dir_all(old).unwrap();
        import(&[(config.clone(), Kind::Config)]).unwrap();
        assert_eq!(
            fs::read(config.join(APP_ID).join("devices.json")).unwrap(),
            b"new devices"
        );
    }

    #[test]
    fn existing_devport_data_wins_and_a_failed_preparation_commits_nothing() {
        let fixture = Fixture::new();
        let first = fixture.0.join("a");
        let second = fixture.0.join("b");
        fs::create_dir_all(first.join(LEGACY_ID)).unwrap();
        fs::write(first.join(LEGACY_ID).join("devices.json"), b"old").unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::write(second.join(LEGACY_ID), b"invalid directory").unwrap();
        assert!(import(&[(first.clone(), Kind::Config), (second, Kind::Config)]).is_err());
        assert!(!first.join(APP_ID).exists());
        assert_eq!(fs::read_dir(&first).unwrap().count(), 1);
        fs::create_dir_all(first.join(APP_ID)).unwrap();
        fs::write(first.join(APP_ID).join("devices.json"), b"new").unwrap();
        import(&[(first.clone(), Kind::Config)]).unwrap();
        assert_eq!(
            fs::read(first.join(APP_ID).join("devices.json")).unwrap(),
            b"new"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_running_legacy_webview_blocks_import_and_can_be_retried() {
        let fixture = Fixture::new();
        let profile = fixture
            .0
            .join(LEGACY_ID)
            .join("EBWebView/Default/Local Storage/leveldb");
        fs::create_dir_all(&profile).unwrap();
        fs::write(profile.join("LOCK"), b"").unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(profile.join("LOCK"))
            .unwrap();
        lock.lock().unwrap();
        assert!(import(&[(fixture.0.clone(), Kind::WebView)]).is_err());
        assert!(!fixture.0.join(APP_ID).exists());
        drop(lock);
        import(&[(fixture.0.clone(), Kind::WebView)]).unwrap();
        assert!(fixture.0.join(APP_ID).join(MARKER).is_file());
    }
}
