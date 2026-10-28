use super::{
    active, error, host::Host, relative, sibling, ConflictPolicy, Directory, Item, Plan, Request,
    Result, Task, TaskSummary, ENTRY_LIMIT, FILE_LIMIT, TOTAL_LIMIT,
};
use crate::{
    device::{DeviceProfile, DeviceStore},
    workspace_ref::WorkspaceRef,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::sync::{Notify, Semaphore};

struct Cancel {
    stopped: AtomicBool,
    notify: Notify,
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temp(PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn manager() -> (Temp, TransferManager, String) {
        let root = Temp(
            std::env::temp_dir().join(format!("rr-transfer-history-{}", uuid::Uuid::new_v4())),
        );
        let manager = TransferManager::new(&root.0);
        let id = uuid::Uuid::new_v4().to_string();
        let task: Task = serde_json::from_value(serde_json::json!({
            "id":id, "request":{"source":{"type":"local","dir":"/source"},"target":{"type":"local","dir":"/target"},"paths":["a", "b"]},
            "policy":"keep_both", "preserve_executable":false, "state":"queued", "items":[
                {"path":"a", "attrs":{"kind":"file", "size":5, "modified":"0", "mode":null, "identity":"a"}, "target_attrs":null, "state":"pending", "target_path":null, "error":null},
                {"path":"b", "attrs":{"kind":"file", "size":5, "modified":"0", "mode":null, "identity":"b"}, "target_attrs":null, "state":"pending", "target_path":null, "error":null}],
            "total_bytes":10, "transferred_bytes":0, "current_path":"", "error":null, "warnings":[], "updated_at":now(), "sequence":1, "residuals":[]
        })).unwrap();
        {
            let mut inner = manager.inner.lock();
            inner.tasks.push(task);
            manager.persist_locked(&inner).unwrap();
        }
        (root, manager, id)
    }

    #[test]
    fn journal_restores_committed_items_and_unknown_commit_without_recopying() {
        let (root, manager, id) = manager();
        manager
            .change(&id, true, |t| {
                t.state = "transferring".into();
                t.current_path = "a".into();
                t.items[0].state = "completed".into();
                t.items[0].target_path = Some("a".into());
                t.transferred_bytes = 5;
            })
            .unwrap();
        manager
            .change(&id, true, |t| {
                t.state = "committing".into();
                t.current_path = "b".into();
                t.items[1].state = "committing".into();
                t.residuals.push(format!(".rr-transfer-{id}-owned.part"));
            })
            .unwrap();
        let recovered = TransferManager::new(&root.0).task(&id).unwrap();
        assert_eq!(recovered.state, "interrupted");
        assert_eq!(recovered.items[0].state, "completed");
        assert_eq!(recovered.items[1].state, "unknown");
        assert_eq!(recovered.transferred_bytes, 5);
        assert_eq!(recovered.residuals.len(), 1);
    }

    #[test]
    fn compacted_history_ignores_older_journal_checkpoints_and_partial_final_line() {
        let (root, manager, id) = manager();
        manager
            .change(&id, true, |t| {
                t.state = "transferring".into();
                t.current_path = "a".into();
                t.items[0].state = "completed".into();
            })
            .unwrap();
        {
            let mut inner = manager.inner.lock();
            inner.tasks[0].sequence += 1;
            inner.tasks[0].transferred_bytes = 9;
            manager.persist_locked(&inner).unwrap();
        }
        std::fs::OpenOptions::new()
            .append(true)
            .open(journal(&root.0, &id))
            .unwrap()
            .write_all(b"{partial")
            .unwrap();
        let recovered = TransferManager::new(&root.0).task(&id).unwrap();
        assert_eq!(recovered.transferred_bytes, 9);
        assert_eq!(recovered.items[0].state, "completed");
    }

    #[test]
    fn queue_summary_keeps_the_selection_name_and_exposes_attention_without_item_payloads() {
        let (_root, manager, id) = manager();
        manager
            .change(&id, false, |task| {
                task.state = "partial".into();
                task.current_path = "b".into();
                task.items[0].state = "failed".into();
                task.items[0].error = Some("Permission denied".into());
                task.items[1].state = "unknown".into();
                task.items[1].error = Some("Commit acknowledgement lost".into());
            })
            .unwrap();
        let summaries = manager.summaries();
        let summary = &summaries[0];
        assert_eq!(summary.first_path, "a");
        assert_eq!(summary.selection_count, 2);
        assert_eq!(summary.failed, 2);
        assert_eq!(summary.unknown_count, 1);
        assert_eq!(summary.pending_count, 0);
        assert_eq!(summary.error.as_deref(), Some("Permission denied"));
        let payload = serde_json::to_value(summary).unwrap();
        assert!(payload.get("items").is_none());
        assert!(payload.get("request").is_none());
        manager
            .change(&id, false, |task| {
                task.items[0].state = "pending".into();
                task.items[1].state = "completed".into();
            })
            .unwrap();
        assert_eq!(manager.summaries()[0].pending_count, 1);
        assert_eq!(manager.summaries()[0].unknown_count, 0);
        assert!(manager.summaries()[0].error.is_none());
    }

    #[test]
    fn legacy_success_resolves_the_old_attempt_and_persists_links_without_rewriting_results() {
        let (root, manager, id) = manager();
        let mut original = manager.task(&id).unwrap();
        original.state = "interrupted".into();
        let mut success = original.clone();
        success.id = uuid::Uuid::new_v4().to_string();
        success.state = "completed".into();
        for item in &mut success.items {
            item.state = "completed".into();
            item.target_path = Some(item.path.clone());
        }
        {
            let mut inner = manager.inner.lock();
            inner.tasks = vec![success.clone(), original.clone()];
            manager.persist_locked(&inner).unwrap();
        }
        let repaired = TransferManager::new(&root.0);
        let old = repaired.task(&id).unwrap();
        assert_eq!(old.state, "interrupted");
        assert_eq!(old.items[0].state, "pending");
        assert_eq!(old.superseded_by.as_deref(), Some(success.id.as_str()));
        assert_eq!(
            repaired.task(&success.id).unwrap().retry_of.as_deref(),
            Some(id.as_str())
        );
        assert_eq!(repaired.summaries()[1].superseded_by, old.superseded_by);
        assert_eq!(
            TransferManager::new(&root.0).task(&id).unwrap().sequence,
            old.sequence
        );
        let stored: Vec<Task> =
            serde_json::from_slice(&std::fs::read(root.0.join("transfers.json")).unwrap()).unwrap();
        assert_eq!(stored[1].superseded_by, old.superseded_by);
    }

    #[test]
    fn legacy_repair_requires_matching_endpoints_metadata_and_all_unfinished_copies() {
        let (_root, manager, id) = manager();
        let mut original = manager.task(&id).unwrap();
        original.state = "interrupted".into();
        let mut success = original.clone();
        success.id = "new-success".into();
        success.state = "completed".into();
        for item in &mut success.items {
            item.state = "completed".into();
            item.target_path = Some(item.path.clone());
        }
        for mismatch in 0..9 {
            let mut old = original.clone();
            let mut newer = success.clone();
            match mismatch {
                0 => newer.request.source = WorkspaceRef::local("/different-source"),
                1 => newer.request.target = WorkspaceRef::local("/different-target"),
                2 => newer.items[0].attrs.modified = "changed".into(),
                3 => {
                    newer.items.pop();
                }
                4 => newer.items[0].state = "skipped".into(),
                5 => old.items[0].state = "unknown".into(),
                6 => newer.items[0].target_path = Some("a (1)".into()),
                7 => newer.target_identity = "different-device".into(),
                _ => newer.state = "failed".into(),
            }
            let mut tasks = vec![newer, old];
            assert!(
                !recover_completed_retries(&mut tasks),
                "mismatch {mismatch}"
            );
            assert!(tasks[1].superseded_by.is_none());
        }
        let mut tasks = vec![original.clone(), success.clone()];
        assert!(
            !recover_completed_retries(&mut tasks),
            "an older success must not retire a newer failure"
        );
        original.items[0].state = "completed".into();
        success.items.remove(0);
        let mut tasks = vec![success, original];
        assert!(
            recover_completed_retries(&mut tasks),
            "a retry only needs to cover unfinished entries"
        );
    }
}
impl Cancel {
    fn new() -> Self {
        Self {
            stopped: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }
    fn check(&self) -> Result<()> {
        if self.stopped.load(Ordering::Acquire) {
            Err(error("canceled", "Transfer canceled"))
        } else {
            Ok(())
        }
    }
}
struct SealedPlan {
    plan: Plan,
    source_device: Option<DeviceProfile>,
    target_device: Option<DeviceProfile>,
    created: std::time::Instant,
    retry_source: Option<(String, u64)>,
}
struct Inner {
    plans: HashMap<String, SealedPlan>,
    tasks: Vec<Task>,
    cancellations: HashMap<String, Arc<Cancel>>,
    devices: HashMap<String, Arc<Semaphore>>,
}

/// Append only the current item and state changes. Persisting a full 10000-item
/// history for each file would produce quadratic disk IO for small-file batches.
#[derive(Serialize, Deserialize)]
struct Checkpoint {
    state: String,
    bytes: u64,
    current: String,
    error: Option<String>,
    sequence: u64,
    updated_at: i64,
    item: Option<(usize, String, Option<String>, Option<String>)>,
    warnings: Vec<String>,
    added_residuals: Vec<String>,
    removed_residuals: Vec<String>,
}

fn journal(config: &Path, id: &str) -> PathBuf {
    config.join("transfer-journal").join(format!("{id}.jsonl"))
}

fn replay(config: &Path, task: &mut Task) {
    if uuid::Uuid::parse_str(&task.id).is_err() {
        return;
    }
    let Ok(file) = std::fs::File::open(journal(config, &task.id)) else {
        return;
    };
    use std::io::Read;
    for line in std::io::BufReader::new(file.take(32 * 1024 * 1024))
        .lines()
        .take(100_000)
    {
        let Ok(line) = line else {
            break;
        };
        let Ok(c): std::result::Result<Checkpoint, _> = serde_json::from_str(&line) else {
            break;
        };
        if c.sequence <= task.sequence {
            continue;
        }
        task.state = c.state;
        task.transferred_bytes = c.bytes;
        task.current_path = c.current;
        task.error = c.error;
        task.sequence = c.sequence;
        task.updated_at = c.updated_at;
        if let Some((index, state, target_path, error)) = c.item {
            if let Some(item) = task.items.get_mut(index) {
                item.state = state;
                item.target_path = target_path;
                item.error = error;
            }
        }
        task.warnings.extend(c.warnings);
        task.residuals.extend(c.added_residuals);
        task.residuals.retain(|p| !c.removed_residuals.contains(p));
    }
}

#[derive(Clone)]
pub struct TransferManager {
    inner: Arc<Mutex<Inner>>,
    slots: Arc<Semaphore>,
    config: PathBuf,
}

async fn timed<T>(future: impl std::future::Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(Duration::from_secs(60), future)
        .await
        .map_err(|_| error("io", "File transfer made no progress for 60 seconds"))?
}

fn device(endpoint: &WorkspaceRef, config: &Path) -> Result<Option<DeviceProfile>> {
    endpoint
        .device_ref()
        .map(|(id, _)| {
            DeviceStore::new(config)
                .get(id)
                .map_err(|e| error("device", e.to_string()))
        })
        .transpose()
}
fn same_device(a: &Option<DeviceProfile>, b: &Option<DeviceProfile>) -> bool {
    serde_json::to_vec(a).ok() == serde_json::to_vec(b).ok()
}
fn direction(request: &Request) -> Result<()> {
    if matches!(
        (&request.source, &request.target),
        (WorkspaceRef::Local { .. }, WorkspaceRef::Device { .. })
            | (WorkspaceRef::Device { .. }, WorkspaceRef::Local { .. })
    ) {
        Ok(())
    } else {
        Err(error(
            "unsupported",
            "Choose one local directory and one SSH/WSL directory",
        ))
    }
}
fn check_alias(source: &Host, target: &Host) -> Result<()> {
    if source.alias_unknown() || target.alias_unknown() {
        return Err(error(
            "path",
            "WSL path conversion is unavailable; cannot rule out overlapping directories",
        ));
    }
    if let (Some(a), Some(b)) = (source.local_alias(), target.local_alias()) {
        #[cfg(windows)]
        let (a, b) = {
            let normalize = |path: &Path| {
                PathBuf::from(
                    crate::verbatim::simplify(path)
                        .to_string_lossy()
                        .to_lowercase()
                        .replace("\\\\wsl.localhost\\", "\\\\wsl$\\"),
                )
            };
            (normalize(&a), normalize(&b))
        };
        if a.starts_with(&b) || b.starts_with(&a) {
            return Err(error(
                "path",
                "Source and target overlap or refer to the same filesystem directory",
            ));
        }
    }
    Ok(())
}
fn now() -> i64 {
    chrono::Utc::now().timestamp()
}
fn target_identity(profile: &Option<DeviceProfile>) -> String {
    profile
        .as_ref()
        .map(|p| {
            format!(
                "{:?}:{}:{}:{}:{:?}",
                p.transport, p.host, p.port, p.username, p.wsl
            )
        })
        .unwrap_or_else(|| "local".into())
}

/// Old histories did not record retry links. Retire an old attempt only when a
/// newer successful copy proves every unfinished path reached the same target
/// with identical source metadata. Never infer links from a filename alone.
fn recover_completed_retries(tasks: &mut [Task]) -> bool {
    let links = {
        let completed = tasks
            .iter()
            .enumerate()
            .filter(|(_, t)| t.state == "completed")
            .map(|(index, task)| {
                (
                    index,
                    task,
                    task.items
                        .iter()
                        .map(|item| (item.path.as_str(), item))
                        .collect::<HashMap<_, _>>(),
                )
            })
            .collect::<Vec<_>>();
        tasks
            .iter()
            .enumerate()
            .filter_map(|(index, original)| {
                if original.superseded_by.is_some()
                    || !matches!(
                        original.state.as_str(),
                        "failed" | "partial" | "canceled" | "interrupted"
                    )
                    || original.items.iter().any(|item| item.state == "unknown")
                {
                    return None;
                }
                let unfinished = original
                    .items
                    .iter()
                    .filter(|item| matches!(item.state.as_str(), "failed" | "pending"))
                    .collect::<Vec<_>>();
                if unfinished.is_empty() {
                    return None;
                }
                completed
                    .iter()
                    .find(|(newer, candidate, entries)| {
                        *newer < index
                            && candidate.request.source == original.request.source
                            && candidate.request.target == original.request.target
                            && candidate.target_identity == original.target_identity
                            && unfinished.iter().all(|item| {
                                entries.get(item.path.as_str()).is_some_and(|copy| {
                                    copy.state == "completed"
                                        && copy.attrs == item.attrs
                                        && copy.target_path.as_deref() == Some(item.path.as_str())
                                })
                            })
                    })
                    .map(|(_, candidate, _)| (original.id.clone(), candidate.id.clone()))
            })
            .collect::<Vec<_>>()
    };
    for (original_id, replacement_id) in &links {
        if let Some(original) = tasks.iter_mut().find(|t| &t.id == original_id) {
            original.superseded_by = Some(replacement_id.clone());
            original.sequence += 1;
        }
        if let Some(replacement) = tasks.iter_mut().find(|t| &t.id == replacement_id) {
            if replacement.retry_of.is_none() {
                replacement.retry_of = Some(original_id.clone());
                replacement.sequence += 1;
            }
        }
    }
    !links.is_empty()
}

impl TransferManager {
    pub fn new(config: &Path) -> Self {
        let mut tasks: Vec<Task> = std::fs::read(config.join("transfers.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        for task in &mut tasks {
            replay(config, task);
            if active(&task.state) {
                for item in &mut task.items {
                    if item.state == "committing" {
                        item.state = "unknown".into();
                    } else if item.state == "transferring" {
                        item.state = "pending".into();
                    }
                }
                task.state = "interrupted".into();
                task.error = Some("Application exited before transfer finished; check unknown items before retrying".into());
            }
        }
        tasks.retain(|t| t.updated_at >= now() - 7 * 86400 || !t.residuals.is_empty());
        let repaired = recover_completed_retries(&mut tasks);
        let manager = Self {
            inner: Arc::new(Mutex::new(Inner {
                plans: HashMap::new(),
                tasks,
                cancellations: HashMap::new(),
                devices: HashMap::new(),
            })),
            slots: Arc::new(Semaphore::new(2)),
            config: config.into(),
        };
        if repaired {
            if let Err(e) = manager.persist_locked(&manager.inner.lock()) {
                tracing::warn!(
                    "Could not persist repaired transfer retry links: {}",
                    e.message
                );
            }
        }
        manager
    }

    pub async fn list(&self, endpoint: WorkspaceRef) -> Result<Directory> {
        self.list_within(endpoint, "").await
    }

    /// Keep the canonical root fixed while listing a validated relative subdirectory.
    /// Unlike opening a subdirectory as a new root, this rejects links below the root.
    pub async fn list_within(&self, endpoint: WorkspaceRef, subdir: &str) -> Result<Directory> {
        if !subdir.is_empty() {
            relative(subdir)?;
        }
        let profile = device(&endpoint, &self.config)?;
        let mut host = timed(Host::open(&endpoint, profile.as_ref(), &self.config)).await?;
        if !subdir.is_empty() && host.endpoint(&endpoint) != endpoint {
            return Err(error(
                "path",
                "Directory root changed; refresh the directory tree",
            ));
        }
        let entries = timed(host.list(subdir)).await?;
        Ok(Directory {
            endpoint: host.endpoint(&endpoint),
            entries,
            overwrite: host.overwrite(),
        })
    }

    pub async fn mkdir(&self, endpoint: WorkspaceRef, name: String) -> Result<()> {
        if relative(&name)?.len() != 1 {
            return Err(error("path", "Directory name must be a single component"));
        }
        let profile = device(&endpoint, &self.config)?;
        let mut host = timed(Host::open(&endpoint, profile.as_ref(), &self.config)).await?;
        timed(host.mkdir(&name)).await
    }

    pub async fn plan(&self, request: Request) -> Result<Plan> {
        self.plan_selection(request, true).await
    }

    async fn plan_selection(&self, mut request: Request, recursive: bool) -> Result<Plan> {
        direction(&request)?;
        if request.paths.is_empty()
            || request.paths.len() > ENTRY_LIMIT
            || request.protected_paths.len() > ENTRY_LIMIT
        {
            return Err(error("too_large", "Choose 1–10000 entries"));
        }
        let source_device = device(&request.source, &self.config)?;
        let target_device = device(&request.target, &self.config)?;
        let mut source = timed(Host::open(
            &request.source,
            source_device.as_ref(),
            &self.config,
        ))
        .await?;
        let mut target = timed(Host::open(
            &request.target,
            target_device.as_ref(),
            &self.config,
        ))
        .await?;
        check_alias(&source, &target)?;
        request.source = source.endpoint(&request.source);
        request.target = target.endpoint(&request.target);
        let mut paths = request.paths.clone();
        paths.sort();
        paths.dedup();
        // Selecting a directory and its descendant must not copy the descendant twice.
        let mut roots: Vec<String> = vec![];
        for path in paths {
            relative(&path)?;
            if !recursive || !roots.iter().any(|p| path.starts_with(&format!("{p}/"))) {
                roots.push(path);
            }
        }
        request.paths = roots.clone();
        let mut stack = roots.into_iter().rev().collect::<Vec<_>>();
        let mut items = Vec::new();
        let mut bytes = 0;
        let mut warnings = Vec::new();
        let mut conflicts = 0;
        let mut names = HashSet::new();
        let target_is_local = matches!(request.target, WorkspaceRef::Local { .. });
        while let Some(path) = stack.pop() {
            relative(&path)?;
            if items.len() + warnings.len() >= ENTRY_LIMIT {
                return Err(error("too_large", "Transfer exceeds 10000 entries"));
            }
            if request.exclude_project_files
                && path
                    .split('/')
                    .any(|p| matches!(p, ".git" | ".hg" | ".svn" | ".venv" | "node_modules"))
            {
                warnings.push(format!("Excluded: {path}"));
                continue;
            }
            let attrs = timed(source.stat(&path))
                .await?
                .ok_or_else(|| error("not_found", format!("Source not found: {path}")))?;
            if !matches!(attrs.kind.as_str(), "file" | "dir") {
                warnings.push(format!("Unsupported {}: {path}", attrs.kind));
                continue;
            }
            // Conservative Windows collision check (even on a case-sensitive directory).
            let key = if target_is_local && cfg!(windows) {
                path.to_lowercase()
            } else {
                path.clone()
            };
            if !names.insert(key) {
                return Err(error(
                    "conflict",
                    format!("Destination filename collision: {path}"),
                ));
            }
            let target_attrs = timed(target.stat(&path)).await?;
            if target_attrs.as_ref().is_some_and(|a| a.kind != attrs.kind) {
                return Err(error(
                    "conflict",
                    format!("File/directory type conflict: {path}"),
                ));
            }
            if attrs.kind == "file" {
                if attrs.size > FILE_LIMIT {
                    return Err(error("too_large", format!("File exceeds 2 GiB: {path}")));
                }
                bytes += attrs.size;
                if bytes > TOTAL_LIMIT {
                    return Err(error("too_large", "Transfer exceeds 10 GiB"));
                }
                if target_attrs.is_some() {
                    conflicts += 1;
                }
            } else if recursive {
                let entries = timed(source.list(&path)).await?;
                for entry in entries.into_iter().rev() {
                    if relative(&entry.name)?.len() != 1 {
                        return Err(error("path", "Invalid device filename"));
                    }
                    let child = format!("{path}/{}", entry.name);
                    if matches!(entry.attrs.kind.as_str(), "link" | "special") {
                        warnings.push(format!("Unsupported {}: {child}", entry.attrs.kind));
                    } else {
                        stack.push(child);
                    }
                }
                if stack.len() + items.len() + warnings.len() > ENTRY_LIMIT {
                    return Err(error("too_large", "Transfer exceeds 10000 entries"));
                }
            }
            items.push(Item {
                path,
                attrs,
                target_attrs,
                state: "pending".into(),
                target_path: None,
                error: None,
            });
        }
        if items.is_empty() {
            return Err(error(
                "unsupported",
                "No transferable files or directories selected",
            ));
        }
        if !target.safe_publish()
            && items
                .iter()
                .any(|i| i.attrs.kind == "file" && i.target_attrs.is_none())
        {
            return Err(error(
                "unsupported",
                "SFTP server lacks hardlink@openssh.com; safe creation of new files is unavailable",
            ));
        }
        let plan = Plan {
            id: uuid::Uuid::new_v4().to_string(),
            request,
            items,
            total_bytes: bytes,
            conflicts,
            warnings,
            overwrite: target.overwrite(),
            keep_both: target.safe_publish(),
        };
        let mut inner = self.inner.lock();
        inner
            .plans
            .retain(|_, p| p.created.elapsed() < Duration::from_secs(300));
        if inner.plans.len() >= 8 {
            return Err(error(
                "busy",
                "Too many pending plans; start or discard an existing plan",
            ));
        }
        inner.plans.insert(
            plan.id.clone(),
            SealedPlan {
                plan: plan.clone(),
                source_device,
                target_device,
                created: std::time::Instant::now(),
                retry_source: None,
            },
        );
        Ok(plan)
    }

    pub fn discard_plan(&self, id: &str) {
        self.inner.lock().plans.remove(id);
    }

    pub fn snapshot(&self) -> Vec<Task> {
        self.inner.lock().tasks.clone()
    }
    pub fn has_active(&self) -> bool {
        self.inner.lock().tasks.iter().any(|t| active(&t.state))
    }

    pub fn summaries(&self) -> Vec<TaskSummary> {
        self.inner
            .lock()
            .tasks
            .iter()
            .map(|t| TaskSummary {
                id: t.id.clone(),
                retry_of: t.retry_of.clone(),
                superseded_by: t.superseded_by.clone(),
                first_path: t.request.paths.first().cloned().unwrap_or_default(),
                selection_count: t.request.paths.len(),
                source: t.request.source.clone(),
                target: t.request.target.clone(),
                state: t.state.clone(),
                total_bytes: t.total_bytes,
                transferred_bytes: t.transferred_bytes,
                current_path: t.current_path.clone(),
                error: t.error.clone().or_else(|| {
                    t.items.iter().find_map(|item| {
                        matches!(item.state.as_str(), "failed" | "unknown")
                            .then(|| item.error.clone())
                            .flatten()
                    })
                }),
                sequence: t.sequence,
                item_count: t.items.len(),
                completed: t.items.iter().filter(|i| i.state == "completed").count(),
                skipped: t.items.iter().filter(|i| i.state == "skipped").count(),
                failed: t
                    .items
                    .iter()
                    .filter(|i| matches!(i.state.as_str(), "failed" | "unknown"))
                    .count(),
                pending_count: t.items.iter().filter(|i| i.state == "pending").count(),
                unknown_count: t.items.iter().filter(|i| i.state == "unknown").count(),
                residual_count: t.residuals.len(),
                warning_count: t.warnings.len(),
            })
            .collect()
    }

    pub fn task(&self, id: &str) -> Result<Task> {
        self.inner
            .lock()
            .tasks
            .iter()
            .find(|t| t.id == id)
            .cloned()
            .ok_or_else(|| error("not_found", "Transfer not found"))
    }

    fn persist_locked(&self, inner: &Inner) -> Result<()> {
        std::fs::create_dir_all(&self.config)?;
        let temp = self.config.join("transfers.json.tmp");
        let bytes = serde_json::to_vec(&inner.tasks).map_err(|e| error("io", e.to_string()))?;
        std::fs::write(&temp, bytes)?;
        std::fs::rename(temp, self.config.join("transfers.json"))?;
        Ok(())
    }

    fn change(&self, id: &str, durable: bool, update: impl FnOnce(&mut Task)) -> Result<()> {
        let mut inner = self.inner.lock();
        let task = inner
            .tasks
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| error("not_found", "Transfer not found"))?;
        let warnings_before = task.warnings.len();
        let residuals_before = if durable {
            task.residuals.clone()
        } else {
            vec![]
        };
        update(task);
        task.sequence += 1;
        task.updated_at = now();
        if durable {
            let checkpoint = Checkpoint {
                state: task.state.clone(),
                bytes: task.transferred_bytes,
                current: task.current_path.clone(),
                error: task.error.clone(),
                sequence: task.sequence,
                updated_at: task.updated_at,
                item: task
                    .items
                    .iter()
                    .enumerate()
                    .find(|(_, i)| i.path == task.current_path)
                    .map(|(index, i)| {
                        (
                            index,
                            i.state.clone(),
                            i.target_path.clone(),
                            i.error.clone(),
                        )
                    }),
                warnings: task.warnings[warnings_before..].to_vec(),
                added_residuals: task
                    .residuals
                    .iter()
                    .filter(|p| !residuals_before.contains(p))
                    .cloned()
                    .collect(),
                removed_residuals: residuals_before
                    .iter()
                    .filter(|p| !task.residuals.contains(p))
                    .cloned()
                    .collect(),
            };
            let path = journal(&self.config, id);
            std::fs::create_dir_all(path.parent().unwrap())?;
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)?;
            let mut bytes =
                serde_json::to_vec(&checkpoint).map_err(|e| error("io", e.to_string()))?;
            bytes.push(b'\n');
            file.write_all(&bytes)?;
            file.sync_data()?;
            if !active(&task.state) {
                self.persist_locked(&inner)?;
                let _ = std::fs::remove_file(path);
            }
        }
        Ok(())
    }

    pub fn start(
        &self,
        plan_id: &str,
        policy: ConflictPolicy,
        preserve_executable: bool,
    ) -> Result<String> {
        let mut inner = self.inner.lock();
        if inner.tasks.iter().filter(|t| active(&t.state)).count() >= 100 {
            return Err(error("busy", "Transfer queue is full"));
        }
        let sealed = inner
            .plans
            .remove(plan_id)
            .ok_or_else(|| error("not_found", "Transfer plan expired; scan again"))?;
        if sealed.created.elapsed() > Duration::from_secs(300) {
            return Err(error("conflict", "Transfer plan expired; scan again"));
        }
        if let Some((id, sequence)) = &sealed.retry_source {
            if !inner.tasks.iter().any(|task| {
                task.id == *id
                    && task.sequence == *sequence
                    && !active(&task.state)
                    && task.superseded_by.is_none()
                    && !task.items.iter().any(|item| item.state == "unknown")
            }) {
                return Err(error(
                    "conflict",
                    "Original transfer changed; scan the retry again",
                ));
            }
        }
        if !same_device(
            &sealed.source_device,
            &device(&sealed.plan.request.source, &self.config)?,
        ) || !same_device(
            &sealed.target_device,
            &device(&sealed.plan.request.target, &self.config)?,
        ) {
            return Err(error(
                "conflict",
                "Device configuration changed; scan again",
            ));
        }
        let plan = sealed.plan;
        if policy == ConflictPolicy::KeepBoth && !plan.keep_both {
            return Err(error(
                "unsupported",
                "Target does not support safe publication without overwrite",
            ));
        }
        if policy == ConflictPolicy::Overwrite && !plan.overwrite {
            return Err(error(
                "unsupported",
                "Target does not support safe overwrite",
            ));
        }
        if policy == ConflictPolicy::Overwrite
            && plan.items.iter().any(|i| {
                plan.request.protected_paths.iter().any(|path| {
                    if cfg!(windows) && matches!(plan.request.target, WorkspaceRef::Local { .. }) {
                        path.to_lowercase() == i.path.to_lowercase()
                    } else {
                        path == &i.path
                    }
                })
            })
        {
            return Err(error(
                "conflict",
                "Close target editor tabs before overwriting",
            ));
        }
        // Bound history and in-memory item metadata as well as queue length.
        while inner.tasks.len() >= 100
            || inner.tasks.iter().map(|t| t.items.len()).sum::<usize>() + plan.items.len() > 100_000
        {
            if let Some(index) = inner.tasks.iter().rposition(|t| {
                !active(&t.state)
                    && t.residuals.is_empty()
                    && sealed
                        .retry_source
                        .as_ref()
                        .is_none_or(|(id, _)| t.id != *id)
            }) {
                inner.tasks.remove(index);
            } else {
                return Err(error(
                    "busy",
                    "Transfer history has too many active or uncleaned entries",
                ));
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = Arc::new(Cancel::new());
        let device_id = plan
            .request
            .source
            .device_ref()
            .or_else(|| plan.request.target.device_ref())
            .unwrap()
            .0
            .to_string();
        let device_slot = inner
            .devices
            .entry(device_id)
            .or_insert_with(|| Arc::new(Semaphore::new(1)))
            .clone();
        let task = Task {
            id: id.clone(),
            retry_of: sealed.retry_source.as_ref().map(|(id, _)| id.clone()),
            superseded_by: None,
            request: plan.request,
            policy,
            preserve_executable,
            state: "queued".into(),
            items: plan.items,
            total_bytes: plan.total_bytes,
            transferred_bytes: 0,
            current_path: String::new(),
            error: None,
            warnings: plan.warnings,
            updated_at: now(),
            sequence: 1,
            residuals: vec![],
            target_identity: target_identity(&sealed.target_device),
        };
        let original_before = task
            .retry_of
            .as_ref()
            .and_then(|original_id| inner.tasks.iter_mut().find(|t| t.id == *original_id))
            .map(|original| {
                let before = original.clone();
                original.superseded_by = Some(id.clone());
                original.sequence += 1;
                before
            });
        inner.tasks.insert(0, task.clone());
        inner.cancellations.insert(id.clone(), cancel.clone());
        if let Err(e) = self.persist_locked(&inner) {
            inner.tasks.retain(|t| t.id != id);
            inner.cancellations.remove(&id);
            if let Some(original) = original_before {
                if let Some(stored) = inner.tasks.iter_mut().find(|t| t.id == original.id) {
                    *stored = original;
                }
            }
            return Err(e);
        }
        drop(inner);
        let manager = self.clone();
        // transfer_start is synchronous IPC and can run outside Tokio on the UI
        // thread. Use Tauri's runtime, as RunManager and TerminalManager do.
        tauri::async_runtime::spawn(async move {
            let result = manager
                .execute(
                    &task,
                    sealed.source_device,
                    sealed.target_device,
                    &cancel,
                    device_slot,
                )
                .await;
            let _ = manager.change(&task.id, true, |t| {
                if let Err(e) = result {
                    t.error = Some(e.message);
                    t.state = if e.code == "canceled" {
                        "canceled"
                    } else if t.items.iter().any(|i| i.state == "completed") {
                        "partial"
                    } else {
                        "failed"
                    }
                    .into();
                } else {
                    t.state = if t
                        .items
                        .iter()
                        .any(|i| matches!(i.state.as_str(), "failed" | "unknown"))
                    {
                        if t.items.iter().any(|i| i.state == "completed") {
                            "partial"
                        } else {
                            "failed"
                        }
                    } else {
                        "completed"
                    }
                    .into();
                }
                for item in &mut t.items {
                    if matches!(item.state.as_str(), "transferring" | "committing") {
                        item.state = "failed".into();
                        item.error = t.error.clone();
                    }
                }
            });
            manager.inner.lock().cancellations.remove(&task.id);
        });
        Ok(id)
    }

    pub fn cancel(&self, id: &str) -> Result<()> {
        let cancel = self.inner.lock().cancellations.get(id).cloned();
        if let Some(cancel) = cancel {
            cancel.stopped.store(true, Ordering::Release);
            cancel.notify.notify_one();
            self.change(id, false, |t| {
                if active(&t.state) {
                    t.state = "canceling".into();
                }
            })?;
        }
        Ok(())
    }

    pub async fn cancel_all(&self) -> Result<()> {
        let ids = self
            .inner
            .lock()
            .cancellations
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for id in ids {
            self.cancel(&id)?;
        }
        tokio::time::timeout(Duration::from_secs(120), async {
            while !self.inner.lock().cancellations.is_empty() {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .map_err(|_| {
            error(
                "busy",
                "Transfers are still cleaning up; try quitting again",
            )
        })
    }

    pub async fn retry(&self, id: &str) -> Result<Plan> {
        let task = self.task(id)?;
        if task.superseded_by.is_some() {
            return Err(error(
                "conflict",
                "This attempt has already been retried; use the latest attempt",
            ));
        }
        if active(&task.state) {
            return Err(error("busy", "Transfer is still active"));
        }
        if task.items.iter().any(|i| i.state == "unknown") {
            return Err(error(
                "unknown",
                "Check files with unknown commit results before making a new selection",
            ));
        }
        let original_sequence = task.sequence;
        let mut request = task.request;
        request.paths = task
            .items
            .iter()
            .filter(|i| matches!(i.state.as_str(), "failed" | "pending"))
            .map(|i| i.path.clone())
            .collect();
        let plan = self.plan_selection(request, false).await?;
        let mut inner = self.inner.lock();
        if !inner.tasks.iter().any(|task| {
            task.id == id
                && task.sequence == original_sequence
                && task.superseded_by.is_none()
                && !active(&task.state)
        }) {
            inner.plans.remove(&plan.id);
            return Err(error(
                "conflict",
                "Original transfer changed; scan the retry again",
            ));
        }
        inner
            .plans
            .get_mut(&plan.id)
            .ok_or_else(|| error("not_found", "Retry plan expired"))?
            .retry_source = Some((id.to_owned(), original_sequence));
        Ok(plan)
    }

    async fn execute(
        &self,
        task: &Task,
        source_device: Option<DeviceProfile>,
        target_device: Option<DeviceProfile>,
        cancel: &Cancel,
        device_slot: Arc<Semaphore>,
    ) -> Result<()> {
        cancel.check()?;
        let _device = tokio::select! { permit = device_slot.acquire() => permit.map_err(|_| error("io", "Device queue closed"))?, _ = cancel.notify.notified() => return Err(error("canceled", "Transfer canceled")) };
        let _global = tokio::select! { permit = self.slots.acquire() => permit.map_err(|_| error("io", "Transfer queue closed"))?, _ = cancel.notify.notified() => return Err(error("canceled", "Transfer canceled")) };
        cancel.check()?;
        // Queued transfers never silently use edited/replaced device configurations.
        if !same_device(&source_device, &device(&task.request.source, &self.config)?)
            || !same_device(&target_device, &device(&task.request.target, &self.config)?)
        {
            return Err(error(
                "conflict",
                "Device configuration changed while queued",
            ));
        }
        let mut source = timed(Host::open(
            &task.request.source,
            source_device.as_ref(),
            &self.config,
        ))
        .await?;
        let mut target = timed(Host::open(
            &task.request.target,
            target_device.as_ref(),
            &self.config,
        ))
        .await?;
        if target.endpoint(&task.request.target) != task.request.target
            || source.endpoint(&task.request.source) != task.request.source
        {
            return Err(error(
                "path",
                "Transfer root now resolves to a different directory",
            ));
        }
        check_alias(&source, &target)?;
        self.change(&task.id, true, |t| t.state = "transferring".into())?;
        for (index, item) in task.items.iter().enumerate() {
            cancel.check()?;
            self.change(&task.id, false, |t| t.current_path = item.path.clone())?;
            let result = if item.attrs.kind == "dir" {
                let components = relative(&item.path)?;
                let mut result = Ok(Some(item.path.clone()));
                for depth in 1..=components.len() {
                    cancel.check()?;
                    if let Err(e) = timed(target.mkdir(&components[..depth].join("/"))).await {
                        result = Err(e);
                        break;
                    }
                }
                result
            } else {
                self.copy_file(task, index, item, &mut source, &mut target, cancel)
                    .await
            };
            match result {
                Ok(path) => self.change(&task.id, true, |t| {
                    t.items[index].state = if path.is_some() {
                        "completed"
                    } else {
                        "skipped"
                    }
                    .into();
                    t.items[index].target_path = path;
                    t.state = "transferring".into();
                })?,
                Err(e) => {
                    let fatal = matches!(e.code, "io" | "unknown" | "canceled");
                    self.change(&task.id, true, |t| {
                        t.items[index].state = if e.code == "unknown" {
                            "unknown"
                        } else {
                            "failed"
                        }
                        .into();
                        t.items[index].error = Some(e.message.clone());
                    })?;
                    if fatal {
                        return Err(e);
                    }
                }
            }
        }
        Ok(())
    }

    async fn copy_file(
        &self,
        task: &Task,
        index: usize,
        item: &Item,
        source: &mut Host,
        target: &mut Host,
        cancel: &Cancel,
    ) -> Result<Option<String>> {
        let current = timed(target.stat(&item.path)).await?;
        if current != item.target_attrs {
            return Err(error(
                "conflict",
                "Target changed after preflight; scan again",
            ));
        }
        if current.is_some() && task.policy == ConflictPolicy::Skip {
            return Ok(None);
        }
        let mut path = item.path.clone();
        let mut expected = current;
        if expected.is_some() && task.policy == ConflictPolicy::KeepBoth {
            let mut found = false;
            for i in 1..=1000 {
                cancel.check()?;
                let candidate = sibling(&path, i);
                if timed(target.stat(&candidate)).await?.is_none() {
                    path = candidate;
                    expected = None;
                    found = true;
                    break;
                }
            }
            if !found {
                return Err(error("conflict", "No available duplicate filename"));
            }
        }
        // Failed nested files can be retried without recopying successful siblings.
        let components = relative(&path)?;
        for depth in 1..components.len() {
            cancel.check()?;
            timed(target.mkdir(&components[..depth].join("/"))).await?;
        }
        let name = format!(".rr-transfer-{}-{}.part", task.id, uuid::Uuid::new_v4());
        let temp = path
            .rsplit_once('/')
            .map(|(parent, _)| format!("{parent}/{name}"))
            .unwrap_or(name);
        let (mut reader, opened) = timed(source.open_read(&item.path)).await?;
        if opened != item.attrs {
            let _ = timed(source.close(reader, false, None)).await;
            return Err(error("conflict", "Source changed after preflight"));
        }
        self.change(&task.id, true, |t| {
            t.current_path = item.path.clone();
            t.items[index].state = "transferring".into();
            t.residuals.push(temp.clone());
        })?;
        let mut writer = match timed(target.create_temp(&temp)).await {
            Ok(handle) => handle,
            Err(e) => {
                let _ = timed(source.close(reader, false, None)).await;
                if timed(target.stat(&temp)).await?.is_none() {
                    self.change(&task.id, true, |t| t.residuals.retain(|p| p != &temp))?;
                }
                return Err(e);
            }
        };
        let copied = async {
            let mut offset = 0;
            loop {
                cancel.check()?;
                let bytes = timed(source.read(&mut reader, offset)).await?;
                if bytes.is_empty() {
                    break;
                }
                if bytes.len() > super::CHUNK || offset + bytes.len() as u64 > item.attrs.size {
                    return Err(error("conflict", "Source grew during transfer"));
                }
                let count = bytes.len() as u64;
                timed(target.write(&mut writer, offset, bytes)).await?;
                offset += count;
                self.change(&task.id, false, |t| t.transferred_bytes += count)?;
            }
            if offset != item.attrs.size {
                return Err(error("conflict", "Source size changed during transfer"));
            }
            Ok(())
        }
        .await;
        let source_closed = timed(source.close(reader, false, None)).await;
        let mode = expected.as_ref().and_then(|a| a.mode).or_else(|| {
            if task.preserve_executable {
                item.attrs.mode.map(|m| 0o600 | (m & 0o111))
            } else {
                None
            }
        });
        let target_closed = timed(target.close(writer, true, mode)).await;
        let result = async {
            copied?;
            if source_closed? != item.attrs
                || timed(source.stat(&item.path)).await? != Some(item.attrs.clone())
            {
                return Err(error("conflict", "Source changed during transfer"));
            }
            if target_closed?.size != item.attrs.size {
                return Err(error("io", "Transferred size mismatch"));
            }
            cancel.check()?;
            self.change(&task.id, true, |t| {
                t.state = "committing".into();
                t.items[index].state = "committing".into();
                t.items[index].target_path = Some(path.clone());
            })?;
            timed(target.commit(
                &temp,
                &path,
                expected.is_some() && task.policy == ConflictPolicy::Overwrite,
                &expected,
            ))
            .await
            .map_err(|e| {
                if e.code == "io" {
                    error(
                        "unknown",
                        format!(
                            "Commit acknowledgement lost; check destination: {}",
                            e.message
                        ),
                    )
                } else {
                    e
                }
            })?;
            Ok(Some(path))
        }
        .await;
        match timed(target.remove_temp(&temp)).await {
            Ok(()) => {
                self.change(&task.id, true, |t| t.residuals.retain(|p| p != &temp))?;
            }
            Err(e) if e.code == "not_found" => {
                self.change(&task.id, true, |t| t.residuals.retain(|p| p != &temp))?;
            }
            Err(e) => {
                self.change(&task.id, true, |t| {
                    t.warnings.push(format!(
                        "Temporary file cleanup pending: {temp}: {}",
                        e.message
                    ))
                })?;
            }
        }
        result
    }

    pub async fn cleanup(&self, id: &str) -> Result<()> {
        let task = self.task(id)?;
        if active(&task.state) {
            return Err(error("busy", "Transfer is still active"));
        }
        let profile = device(&task.request.target, &self.config)?;
        if task.target_identity != target_identity(&profile) {
            return Err(error(
                "conflict",
                "Target device identity changed; restore its configuration before cleanup",
            ));
        }
        let mut target = timed(Host::open(
            &task.request.target,
            profile.as_ref(),
            &self.config,
        ))
        .await?;
        if target.endpoint(&task.request.target) != task.request.target {
            return Err(error(
                "path",
                "Cleanup root now resolves to a different directory",
            ));
        }
        for temp in &task.residuals {
            let name = temp.rsplit('/').next().unwrap_or("");
            if !name.starts_with(&format!(".rr-transfer-{}-", task.id)) || !name.ends_with(".part")
            {
                return Err(error("path", "Invalid cleanup ownership"));
            }
            match timed(target.remove_temp(temp)).await {
                Ok(()) => {}
                Err(e) if e.code == "not_found" => {}
                Err(e) => return Err(e),
            }
            self.change(id, true, |t| t.residuals.retain(|p| p != temp))?;
        }
        Ok(())
    }
}
