//! Directory opens from Explorer or the command line, including single-instance relaunches.
use crate::{workspace, workspace_ref::WorkspaceRef};
use parking_lot::Mutex;
use serde::Serialize;
use std::path::Path;
use tauri::{Emitter, Manager};

pub const OPEN_REQUESTED_EVENT: &str = "workspace://open-requested";

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum WorkspaceLaunch {
    Open { workspace: WorkspaceRef },
    Error { message: String },
}

/// Keep the latest pending selection while startup or an unsaved-file prompt is busy.
#[derive(Default)]
pub struct WorkspaceLaunchState(Mutex<Option<WorkspaceLaunch>>);

impl WorkspaceLaunchState {
    pub fn new(args: &[String], cwd: &Path) -> Self {
        Self(Mutex::new(request(args, cwd)))
    }
}

fn parse(args: &[String], cwd: &Path) -> Result<Option<WorkspaceRef>, String> {
    if args.get(1).map(String::as_str) != Some("--open-workspace") {
        return Ok(None);
    }
    if args.len() != 3 || args[2].trim().is_empty() || args[2].contains(['\0', '\r', '\n']) {
        return Err("Expected --open-workspace <directory>".into());
    }
    // A second process's relative path belongs to its cwd, not the running app's.
    let path = cwd.join(&args[2]);
    let dir = path.to_str().ok_or("Workspace path is not valid Unicode")?;
    let path = workspace::terminal_dir(dir, "").map_err(|error| error.to_string())?;
    let dir = path.to_str().ok_or("Workspace path is not valid Unicode")?;
    Ok(Some(WorkspaceRef::local(dir)))
}

fn request(args: &[String], cwd: &Path) -> Option<WorkspaceLaunch> {
    match parse(args, cwd) {
        Ok(Some(workspace)) => Some(WorkspaceLaunch::Open { workspace }),
        Ok(None) => None,
        Err(message) => Some(WorkspaceLaunch::Error { message }),
    }
}

pub fn receive(app: &tauri::AppHandle, args: &[String], cwd: &Path) {
    let Some(request) = request(args, cwd) else {
        return;
    };
    *app.state::<WorkspaceLaunchState>().0.lock() = Some(request);
    // The stored request also covers first launch, before the WebView can listen.
    if let Err(error) = app.emit_to(crate::tray::MAIN_WINDOW_LABEL, OPEN_REQUESTED_EVENT, ()) {
        tracing::warn!("notify workspace launch failed: {error}");
    }
}

#[tauri::command]
pub fn take_workspace_launch(
    state: tauri::State<'_, WorkspaceLaunchState>,
) -> Option<WorkspaceLaunch> {
    state.0.lock().take()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn only_an_explicit_single_directory_argument_is_opened() {
        let cwd = std::env::temp_dir();
        for values in [
            vec!["devport.exe"],
            vec!["devport.exe", "--minimized"],
            vec!["devport.exe", "some-directory"],
        ] {
            assert_eq!(parse(&args(&values), &cwd).unwrap(), None);
        }
        for values in [
            vec!["devport.exe", "--open-workspace"],
            vec!["devport.exe", "--open-workspace", ""],
            vec!["devport.exe", "--open-workspace", "\n"],
            vec!["devport.exe", "--open-workspace", ".", "extra"],
        ] {
            assert!(parse(&args(&values), &cwd).is_err());
        }
    }

    #[test]
    fn resolves_spaces_unicode_and_relative_paths_against_the_callers_cwd() {
        let root = std::env::temp_dir().join(format!("devport-launch-{}", uuid::Uuid::new_v4()));
        let directory = root.join("工作区 with spaces & symbols");
        std::fs::create_dir_all(&directory).unwrap();
        let expected = Some(WorkspaceRef::local(
            workspace::terminal_dir(directory.to_str().unwrap(), "")
                .unwrap()
                .to_str()
                .unwrap(),
        ));
        for value in [
            directory.to_str().unwrap().to_string(),
            "工作区 with spaces & symbols".to_string(),
            directory.join(".").to_str().unwrap().to_string(),
        ] {
            assert_eq!(
                parse(&args(&["devport.exe", "--open-workspace", &value]), &root).unwrap(),
                expected
            );
        }
        let file = root.join("file.txt");
        std::fs::write(&file, "text").unwrap();
        for value in [file, root.join("missing")] {
            assert!(parse(
                &args(&["devport.exe", "--open-workspace", value.to_str().unwrap()]),
                &root
            )
            .is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn accepts_a_drive_root_with_the_explorer_dot_suffix() {
        let cwd = std::env::current_dir().unwrap();
        let root = cwd.ancestors().last().unwrap();
        let value = root.join(".");
        let selected = parse(
            &args(&["devport.exe", "--open-workspace", value.to_str().unwrap()]),
            &cwd,
        )
        .unwrap()
        .unwrap();
        assert_eq!(selected.local_dir(), root.to_str());
    }
}
