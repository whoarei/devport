//! Binary file transfers, independent of editor and run-upload limits.
pub(crate) mod host;
mod manager;
mod ssh;
#[cfg(test)]
mod tests;
mod wsl;

use crate::workspace::FileError;
use crate::workspace_ref::WorkspaceRef;
pub use manager::TransferManager;
use serde::{Deserialize, Serialize};

type Result<T> = std::result::Result<T, FileError>;
pub(crate) const FILE_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const TOTAL_LIMIT: u64 = 10 * 1024 * 1024 * 1024;
pub(crate) const ENTRY_LIMIT: usize = 10_000;
pub(crate) const CHUNK: usize = 32 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Attributes {
    pub kind: String,
    pub size: u64,
    pub modified: String,
    pub mode: Option<u32>,
    pub identity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub name: String,
    #[serde(flatten)]
    pub attrs: Attributes,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Directory {
    pub endpoint: WorkspaceRef,
    pub entries: Vec<Entry>,
    pub overwrite: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    pub source: WorkspaceRef,
    pub target: WorkspaceRef,
    pub paths: Vec<String>,
    #[serde(default)]
    pub exclude_project_files: bool,
    #[serde(default)]
    pub protected_paths: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    KeepBoth,
    Skip,
    Overwrite,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    pub path: String,
    pub attrs: Attributes,
    pub target_attrs: Option<Attributes>,
    pub state: String,
    pub target_path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plan {
    pub id: String,
    pub request: Request,
    pub items: Vec<Item>,
    pub total_bytes: u64,
    pub conflicts: usize,
    pub warnings: Vec<String>,
    pub overwrite: bool,
    pub keep_both: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    #[serde(default)]
    pub retry_of: Option<String>,
    #[serde(default)]
    pub superseded_by: Option<String>,
    pub request: Request,
    pub policy: ConflictPolicy,
    pub preserve_executable: bool,
    pub state: String,
    pub items: Vec<Item>,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub current_path: String,
    pub error: Option<String>,
    pub warnings: Vec<String>,
    pub updated_at: i64,
    pub sequence: u64,
    pub residuals: Vec<String>,
    #[serde(default)]
    pub target_identity: String,
}

#[derive(Debug, Serialize)]
pub struct TaskSummary {
    pub id: String,
    pub retry_of: Option<String>,
    pub superseded_by: Option<String>,
    pub first_path: String,
    pub selection_count: usize,
    pub source: WorkspaceRef,
    pub target: WorkspaceRef,
    pub state: String,
    pub total_bytes: u64,
    pub transferred_bytes: u64,
    pub current_path: String,
    pub error: Option<String>,
    pub sequence: u64,
    pub item_count: usize,
    pub completed: usize,
    pub skipped: usize,
    pub failed: usize,
    pub pending_count: usize,
    pub unknown_count: usize,
    pub residual_count: usize,
    pub warning_count: usize,
}

pub fn active(state: &str) -> bool {
    matches!(
        state,
        "queued" | "transferring" | "committing" | "canceling"
    )
}

fn error(code: &'static str, text: impl Into<String>) -> FileError {
    FileError::new(code, text)
}

pub(crate) fn relative(path: &str) -> Result<Vec<&str>> {
    let parts = path.split('/').collect::<Vec<_>>();
    for part in &parts {
        let stem = part
            .split('.')
            .next()
            .unwrap_or("")
            .trim_end()
            .to_uppercase();
        let reserved = matches!(
            stem.as_str(),
            "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
        ) || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        });
        if part.is_empty()
            || matches!(*part, "." | "..")
            || part.len() > 255
            || part.ends_with([' ', '.'])
            || part.contains(['\\', ':', '*', '?', '"', '<', '>', '|'])
            || part.chars().any(char::is_control)
            || reserved
        {
            return Err(error("path", "Invalid or non-portable transfer filename"));
        }
    }
    if parts.len() > 64 || path.len() > 4096 {
        return Err(error("path", "Path exceeds transfer limits"));
    }
    Ok(parts)
}

fn sibling(path: &str, index: usize) -> String {
    let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
    let (stem, extension) = name
        .rsplit_once('.')
        .filter(|(stem, _)| !stem.is_empty())
        .map(|(stem, extension)| (stem, format!(".{extension}")))
        .unwrap_or((name, String::new()));
    let name = format!("{stem} ({index}){extension}");
    if parent.is_empty() {
        name
    } else {
        format!("{parent}/{name}")
    }
}
