//! Bounded, local-only restart metadata and editor drafts. Never executes content.
use crate::{
    commands::AppState,
    error::{Result, RunnerError},
    workspace_ref::WorkspaceRef,
};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::Path,
};

const LIMIT: u64 = 32 * 1024 * 1024;
const FILE_LIMIT: usize = 1024 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Environment {
    version: u32,
    current: Option<WorkspaceRef>,
    workspaces: Vec<WorkspaceSession>,
    terminals: Vec<Terminal>,
    active_terminal: Option<String>,
    transfer: Transfer,
    window: Option<Window>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceSession {
    workspace: WorkspaceRef,
    files: Vec<File>,
    active_file: Option<String>,
    expanded: Vec<String>,
    tree_scroll: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    name: String,
    language: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    view: Option<Location>,
    #[serde(skip_serializing_if = "Option::is_none")]
    draft: Option<Draft>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Location {
    anchor: u32,
    head: u32,
    scroll_top: f64,
    scroll_left: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Draft {
    content: String,
    saved_content: String,
    revision: String,
    eol: String,
    bom: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Terminal {
    id: String,
    device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace: Option<TerminalWorkspace>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TerminalWorkspace {
    workspace: WorkspaceRef,
    subdir: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Transfer {
    device_id: Option<String>,
    hidden: bool,
    exclude: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Window {
    x: i32,
    y: i32,
    width: f64,
    height: f64,
    maximized: bool,
}
fn invalid(message: &str) -> RunnerError {
    RunnerError::InvalidInput(format!("work environment: {message}"))
}
fn relative(path: &str, root: bool) -> Result<()> {
    if root && path.is_empty() {
        return Ok(());
    }
    if path.len() > 4096
        || path.contains(['\0', '\r', '\n'])
        || path.starts_with(['/', '\\'])
        || path
            .split(['/', '\\'])
            .any(|p| p.is_empty() || p == "." || p == ".." || p.contains(':'))
    {
        return Err(invalid("invalid relative path"));
    }
    Ok(())
}
fn source(workspace: &WorkspaceRef) -> Result<()> {
    match workspace {
        WorkspaceRef::Local { dir }
            if dir.len() <= 32768
                && !dir.contains(['\0', '\r', '\n'])
                && Path::new(dir).is_absolute() =>
        {
            Ok(())
        }
        WorkspaceRef::Device { device_id, path }
            if !device_id.is_empty() && device_id.len() <= 256 && path.len() <= 4096 =>
        {
            crate::workspace_ref::validate_device_path(path)
                .map_err(|_| invalid("invalid device workspace"))
        }
        _ => Err(invalid("invalid workspace")),
    }
}
fn scroll(value: f64) -> bool {
    value.is_finite() && (0.0..=100_000_000.0).contains(&value)
}
impl Environment {
    fn validate(&self) -> Result<()> {
        if self.version != 1 || self.workspaces.len() > 10 || self.terminals.len() > 8 {
            return Err(invalid("unsupported version or too many entries"));
        }
        if let Some(current) = &self.current {
            source(current)?;
        }
        let mut sources = std::collections::HashSet::new();
        for state in &self.workspaces {
            source(&state.workspace)?;
            if !sources.insert(serde_json::to_string(&state.workspace).unwrap())
                || state.files.len() > 256
                || state.expanded.len() > 256
                || !scroll(state.tree_scroll)
            {
                return Err(invalid("invalid workspace view limits"));
            }
            let mut files = std::collections::HashSet::new();
            for file in &state.files {
                relative(&file.name, false)?;
                if !files.insert(&file.name)
                    || !["python", "shell", "text"].contains(&file.language.as_str())
                {
                    return Err(invalid("invalid file record"));
                }
                if let Some(v) = &file.view {
                    if !scroll(v.scroll_top) || !scroll(v.scroll_left) {
                        return Err(invalid("invalid editor scroll position"));
                    }
                }
                if let Some(d) = &file.draft {
                    if d.content.len() > FILE_LIMIT
                        || d.saved_content.len() > FILE_LIMIT
                        || d.revision.len() > 4096
                        || !["lf", "crlf"].contains(&d.eol.as_str())
                    {
                        return Err(invalid("invalid draft or draft exceeds 1 MiB"));
                    }
                }
            }
            if state
                .active_file
                .as_ref()
                .is_some_and(|path| !files.contains(path))
            {
                return Err(invalid("active file missing from tabs"));
            }
            for path in &state.expanded {
                relative(path, false)?;
            }
        }
        let mut terminals = std::collections::HashSet::new();
        for terminal in &self.terminals {
            if terminal.id.is_empty()
                || terminal.id.len() > 256
                || terminal.device_id.is_empty()
                || terminal.device_id.len() > 256
                || !terminals.insert(&terminal.id)
            {
                return Err(invalid("invalid terminal descriptor"));
            }
            if let Some(w) = &terminal.workspace {
                source(&w.workspace)?;
                relative(&w.subdir, true)?;
            }
        }
        if self
            .active_terminal
            .as_ref()
            .is_some_and(|id| !terminals.contains(id))
        {
            return Err(invalid("active terminal missing from tabs"));
        }
        if self
            .transfer
            .device_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 256)
        {
            return Err(invalid("invalid transfer device"));
        }
        if let Some(w) = &self.window {
            if !w.width.is_finite()
                || !w.height.is_finite()
                || !(100.0..=32768.0).contains(&w.width)
                || !(100.0..=32768.0).contains(&w.height)
            {
                return Err(invalid("invalid window bounds"));
            }
        }
        Ok(())
    }
}
fn read(root: &Path) -> Result<Option<Environment>> {
    let file = match std::fs::File::open(root.join("work-environment.json")) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let mut bytes = Vec::new();
    file.take(LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > LIMIT {
        return Err(invalid("snapshot exceeds 32 MiB"));
    }
    let state: Environment =
        serde_json::from_slice(&bytes).map_err(|_| invalid("invalid snapshot JSON"))?;
    state.validate()?;
    Ok(Some(state))
}
fn write(root: &Path, snapshot: &Environment) -> Result<()> {
    snapshot.validate()?;
    let bytes = serde_json::to_vec(snapshot).map_err(|_| invalid("cannot encode snapshot"))?;
    if bytes.len() as u64 > LIMIT {
        return Err(invalid("snapshot exceeds 32 MiB"));
    }
    std::fs::create_dir_all(root)?;
    let temp = root.join(format!(".work-environment-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, root.join("work-environment.json"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result
}
#[tauri::command]
pub async fn read_work_environment(
    state: tauri::State<'_, AppState>,
) -> Result<Option<Environment>> {
    let root = state.config_dir.clone();
    tokio::task::spawn_blocking(move || read(&root))
        .await
        .map_err(|e| invalid(&e.to_string()))?
}
#[tauri::command]
pub async fn save_work_environment(
    state: tauri::State<'_, AppState>,
    snapshot: Environment,
) -> Result<()> {
    let root = state.config_dir.clone();
    tokio::task::spawn_blocking(move || write(&root, &snapshot))
        .await
        .map_err(|e| invalid(&e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample(root: &Path) -> Environment {
        serde_json::from_value(serde_json::json!({"version":1,"current":{"type":"local","dir":root},
            "workspaces":[{"workspace":{"type":"local","dir":root},"files":[{"name":"src/main.py","language":"python",
                "view":{"anchor":8,"head":12,"scroll_top":120,"scroll_left":2},
                "draft":{"content":"print('草稿')\n","saved_content":"print('base')\n","revision":"revision-1","eol":"lf","bom":false}}],
                "active_file":"src/main.py","expanded":["src"],"tree_scroll":80}],
            "terminals":[{"id":"tab-1","device_id":"device-1","workspace":{"workspace":{"type":"local","dir":root},"subdir":"src"}}],
            "active_terminal":"tab-1","transfer":{"device_id":"device-1","hidden":true,"exclude":true},
            "window":{"x":-1920,"y":0,"width":1280,"height":800,"maximized":true}})).unwrap()
    }
    #[test]
    fn snapshots_round_trip_replace_atomically_and_keep_drafts_out_of_the_workspace() {
        let root = std::env::temp_dir().join(format!("rr-environment-{}", uuid::Uuid::new_v4()));
        assert!(read(&root).unwrap().is_none());
        let mut state = sample(&root);
        write(&root, &state).unwrap();
        assert_eq!(
            read(&root).unwrap().unwrap().workspaces[0].files[0]
                .draft
                .as_ref()
                .unwrap()
                .content,
            "print('草稿')\n"
        );
        state.current = None;
        state.workspaces[0].files[0].draft = None;
        write(&root, &state).unwrap();
        let loaded = read(&root).unwrap().unwrap();
        assert!(loaded.current.is_none());
        assert!(loaded.workspaces[0].files[0].draft.is_none());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_unsafe_paths_duplicates_and_limits_without_overwriting_a_good_snapshot() {
        let root = std::env::temp_dir().join(format!("rr-environment-{}", uuid::Uuid::new_v4()));
        let state = sample(&root);
        write(&root, &state).unwrap();
        let original = std::fs::read(root.join("work-environment.json")).unwrap();
        for path in [
            "../escape",
            "/absolute",
            "C:\\escape",
            "a/../b",
            "a\\..\\b",
            "",
            "a\0b",
        ] {
            let mut bad = state.clone();
            bad.workspaces[0].files[0].name = path.into();
            assert!(write(&root, &bad).is_err(), "{path:?}");
        }
        let mut bad = state.clone();
        bad.version = 2;
        assert!(write(&root, &bad).is_err());
        let mut bad = state.clone();
        bad.workspaces.push(bad.workspaces[0].clone());
        assert!(write(&root, &bad).is_err());
        let mut bad = state.clone();
        bad.terminals = vec![bad.terminals[0].clone(); 9];
        assert!(write(&root, &bad).is_err());
        let mut bad = state.clone();
        bad.workspaces[0].files[0].draft.as_mut().unwrap().content = "x".repeat(FILE_LIMIT + 1);
        assert!(write(&root, &bad).is_err());
        let mut bad = state.clone();
        bad.current = Some(WorkspaceRef::device("d", "/a/../b"));
        assert!(write(&root, &bad).is_err());
        let mut bad = state.clone();
        bad.window.as_mut().unwrap().width = f64::NAN;
        assert!(write(&root, &bad).is_err());
        assert_eq!(
            std::fs::read(root.join("work-environment.json")).unwrap(),
            original
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn corrupt_or_oversized_snapshots_are_rejected_and_preserved() {
        let root = std::env::temp_dir().join(format!("rr-environment-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("work-environment.json");
        std::fs::write(&path, b"corrupt draft backup").unwrap();
        assert!(read(&root).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"corrupt draft backup");
        std::fs::File::create(&path)
            .unwrap()
            .set_len(LIMIT + 1)
            .unwrap();
        assert!(read(&root).unwrap_err().to_string().contains("32 MiB"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
