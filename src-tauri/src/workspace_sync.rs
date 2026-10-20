//! Reusable SSH/WSL execution workspaces. Ownership is recorded separately from
//! workload files; only manifest-owned files may be removed. A persistent remote
//! lease spans synchronization AND execution, and is never stolen by timeout.
use crate::{
    device::{DeviceProfile, TransportKind},
    error::{Result, RunnerError},
    file_transfer::{host::Host, Attributes, CHUNK},
    runtime::host::{cancelled, check_cancel},
    workspace_ref::WorkspaceRef,
    workspace_upload::{self, Policy, Source},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Write,
    path::Path,
    sync::{atomic::AtomicBool, Arc, OnceLock, Weak},
};
use tokio::sync::{Mutex, OwnedMutexGuard};

const VERSION: u32 = 1;
// Bump when workspace_upload's content transformation rules change. This is
// independent of VERSION, which also determines persistent workspace identity.
const SOURCE_CACHE_VERSION: u32 = 1;
const MANIFEST_LIMIT: usize = 8 * 1024 * 1024;
const JOURNAL_LIMIT: usize = MANIFEST_LIMIT * 4;
type Locks = parking_lot::Mutex<BTreeMap<String, Weak<Mutex<()>>>>;
static LOCKS: OnceLock<Locks> = OnceLock::new();
static CLIENT_ID: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

fn failure(message: impl Into<String>) -> RunnerError {
    RunnerError::TaskFailed(format!("workspace sync: {}", message.into()))
}
fn map(error: crate::workspace::FileError) -> RunnerError {
    if error.code == "canceled" {
        return crate::runtime::host::canceled_error();
    }
    failure(error.to_string())
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Report {
    pub destination: String,
    pub added: u64,
    pub updated: u64,
    pub deleted: u64,
    pub skipped: u64,
    pub permissions: u64,
    pub uploaded_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    directory: bool,
    sha256: String,
    size: u64,
    mode: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<SourceStamp>,
}

/// Attributes of the source file, never the target's clock or normalized size.
/// Kept in the target manifest so the source workspace needs no cache files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceStamp {
    version: u32,
    size: u64,
    modified_ns: String,
    identity: String,
}

impl SourceStamp {
    fn matches_cache(&self, other: &Self) -> bool {
        self.version == other.version
            && self.size == other.size
            && self.modified_ns == other.modified_ns
    }

    fn from_metadata(meta: &std::fs::Metadata) -> Option<Self> {
        let modified_ns = meta
            .modified()
            .ok()?
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_nanos()
            .to_string();
        #[cfg(unix)]
        let identity = {
            use std::os::unix::fs::MetadataExt;
            format!(
                "unix:{}:{}:{}:{}",
                meta.dev(),
                meta.ino(),
                meta.ctime(),
                meta.ctime_nsec()
            )
        };
        #[cfg(windows)]
        let identity = {
            use std::os::windows::fs::MetadataExt;
            format!("windows:{}", meta.creation_time())
        };
        #[cfg(not(any(unix, windows)))]
        let identity = format!("{:?}", meta.created().ok()?);
        Some(Self {
            version: SOURCE_CACHE_VERSION,
            size: meta.len(),
            modified_ns,
            identity,
        })
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    workspace_id: String,
    entries: BTreeMap<String, Record>,
}
impl Manifest {
    fn empty(id: &str) -> Self {
        Self {
            version: VERSION,
            workspace_id: id.into(),
            entries: BTreeMap::new(),
        }
    }
    fn validate(&self, id: &str, policy: Policy) -> Result<()> {
        if self.version != VERSION
            || self.workspace_id != id
            || self.entries.len() > policy.entry_limit
        {
            return Err(failure(
                "invalid manifest version, identity or entry count; no files were removed",
            ));
        }
        let mut total = 0u64;
        for (path, entry) in &self.entries {
            crate::file_transfer::relative(path).map_err(map)?;
            if path.len() > policy.path_limit
                || entry.mode > 0o777
                || path
                    .split('/')
                    .any(|p| matches!(p, ".git" | ".hg" | ".svn"))
                || path.split('/').next() == Some(".runner")
            {
                return Err(failure("invalid manifest path or mode"));
            }
            if let Some(source) = &entry.source {
                if entry.directory
                    || source.size > policy.file_limit
                    || entry.size > source.size
                    || source.modified_ns.len() > 39
                    || source.modified_ns.parse::<u128>().is_err()
                    || source.identity.is_empty()
                    || source.identity.len() > 128
                {
                    return Err(failure("invalid source cache record"));
                }
            }
            if entry.directory {
                if entry.size != 0 || !entry.sha256.is_empty() {
                    return Err(failure("invalid directory record"));
                }
            } else {
                if entry.sha256.len() != 64
                    || !entry.sha256.bytes().all(|b| b.is_ascii_hexdigit())
                    || entry.size > policy.file_limit
                {
                    return Err(failure("invalid file record"));
                }
                total += entry.size;
            }
            if total > policy.total_limit as u64 {
                return Err(failure("manifest exceeds workspace limit"));
            }
            // Every ancestor is explicitly recorded as a directory.
            let mut parent = path.as_str();
            while let Some((ancestor, _)) = parent.rsplit_once('/') {
                if !self.entries.get(ancestor).is_some_and(|e| e.directory) {
                    return Err(failure("manifest has a non-directory or missing ancestor"));
                }
                parent = ancestor;
            }
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pending {
    previous: Manifest,
    next: Manifest,
    retained: BTreeMap<String, Record>,
    temps: Vec<String>,
}

fn client_id(config: &Path) -> Result<String> {
    let _guard = CLIENT_ID.lock();
    std::fs::create_dir_all(config)?;
    let path = config.join("workspace-client-id");
    if !path.exists() {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                file.write_all(uuid::Uuid::new_v4().to_string().as_bytes())?;
                file.sync_all()?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
    }
    let bytes = std::fs::read(&path)?;
    if bytes.len() != 36 {
        return Err(failure("invalid workspace-client-id"));
    }
    let id = std::str::from_utf8(&bytes).map_err(|_| failure("invalid client ID"))?;
    uuid::Uuid::parse_str(id).map_err(|_| failure("invalid client ID"))?;
    Ok(id.into())
}

async fn workspace_id(
    source: &WorkspaceRef,
    source_device: Option<&DeviceProfile>,
    config: &Path,
) -> Result<String> {
    // Resolve the ORIGINAL source, before cross-device staging rewrites it.
    let host = Host::open(source, source_device, config)
        .await
        .map_err(map)?;
    let source = host.endpoint(source);
    let config = config.to_path_buf();
    let client = tokio::task::spawn_blocking(move || client_id(&config))
        .await
        .map_err(|e| failure(e.to_string()))??;
    Ok(digest(
        &serde_json::to_vec(&(VERSION, client, source)).map_err(|e| failure(e.to_string()))?,
    ))
}

/// The original source folder supplies the visible name, never a staging path.
/// Reject unsupported names rather than sanitizing two distinct names into one.
fn directory_name(source: &WorkspaceRef) -> Result<String> {
    let name = match source {
        WorkspaceRef::Local { dir } => Path::new(dir).file_name().and_then(|name| name.to_str()),
        WorkspaceRef::Device { path, .. } => {
            crate::workspace_ref::validate_device_path(path).map_err(failure)?;
            path.trim_end_matches('/')
                .rsplit('/')
                .next()
                .filter(|name| !name.is_empty())
        }
    }
    .ok_or_else(|| {
        failure(
            "workspace must have a directory name; filesystem roots cannot be synchronized by name",
        )
    })?;
    if crate::file_transfer::relative(name).map_err(map)?.len() != 1 {
        return Err(failure(
            "workspace directory name must be one valid path component",
        ));
    }
    Ok(name.into())
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    version: u32,
    workspace_id: String,
}

fn verify_identity(bytes: &[u8], id: &str, location: &str) -> Result<()> {
    let identity: Identity = serde_json::from_slice(bytes).map_err(|_| {
        failure(format!(
            "invalid workspace identity at {location}; refusing to claim the directory"
        ))
    })?;
    if identity.version != VERSION || identity.workspace_id != id {
        return Err(failure(format!("workspace name conflict at {location}: this directory belongs to another source workspace; rename the source folder or choose a different workspace root")));
    }
    Ok(())
}

/// Claim a human-readable name exactly once. Both the immutable identity and
/// execution lease are published without replacing an existing owner.
async fn claim_directory(host: &mut Host, name: &str, id: &str, location: &str) -> Result<()> {
    let path = format!("{name}/.sync/identity.json");
    if let Some(bytes) = read_blob(host, &path, 4096).await? {
        return verify_identity(&bytes, id, location);
    }
    let occupied = host
        .list(name)
        .await
        .map_err(map)?
        .iter()
        .any(|entry| entry.name != ".sync")
        || host
            .list(&format!("{name}/.sync"))
            .await
            .map_err(map)?
            .iter()
            .any(|entry| {
                // A failed first claim can leave only its private publication temp.
                !entry
                    .name
                    .strip_prefix(".rr-transfer-")
                    .and_then(|n| n.strip_suffix(".part"))
                    .is_some_and(|n| {
                        uuid::Uuid::parse_str(n).is_ok()
                            && entry.attrs.kind == "file"
                            && entry.attrs.size <= 4096
                    })
            });
    // Another client may have finished claiming while we inspected the folder.
    if let Some(bytes) = read_blob(host, &path, 4096).await? {
        return verify_identity(&bytes, id, location);
    }
    if occupied {
        return Err(failure(format!("workspace name conflict at {location}: directory already contains data without a matching synchronization identity; choose another workspace root or rename the source folder")));
    }
    let bytes = serde_json::to_vec(&Identity {
        version: VERSION,
        workspace_id: id.into(),
    })
    .unwrap();
    match publish(host, &path, &bytes, 0o600, &None, None, None).await {
        Ok(()) => Ok(()),
        Err(error) => match read_blob(host, &path, 4096).await? {
            Some(bytes) => verify_identity(&bytes, id, location),
            None => Err(error),
        },
    }
}

fn queue_lock(key: String) -> Arc<Mutex<()>> {
    let mut locks = LOCKS.get_or_init(Default::default).lock();
    locks.retain(|_, value| value.strong_count() > 0);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    lock
}

pub struct Lease {
    host: Host,
    prefix: String,
    id: String,
    owner: Vec<u8>,
    pub destination: String,
    pub process_started: bool,
    pub process_finished: bool,
    _queue: OwnedMutexGuard<()>,
}
impl Lease {
    pub(crate) fn ssh_connection(&self) -> Option<crate::ssh::client::SshConnection> {
        self.host.ssh_connection()
    }
    pub async fn acquire(
        source: &WorkspaceRef,
        source_device: Option<&DeviceProfile>,
        device: &DeviceProfile,
        config: &Path,
        run_id: &str,
        cancel: &AtomicBool,
    ) -> Result<Self> {
        check_cancel(cancel)?;
        device.validate()?;
        if let WorkspaceRef::Device { device_id, .. } = source {
            if source_device.is_none_or(|device| device.id != *device_id) {
                return Err(failure("source device identity does not match workspace"));
            }
        }
        let id = workspace_id(source, source_device, config).await?;
        let prefix = directory_name(source)?;
        let target = match device.transport {
            TransportKind::Ssh => {
                format!("ssh:{}:{}:{}", device.host, device.port, device.username)
            }
            TransportKind::Wsl => {
                let wsl = device.wsl.as_ref().unwrap();
                format!("wsl:{}:{}", wsl.distribution, wsl.user)
            }
            _ => return Err(failure("unsupported transport")),
        };
        let key = serde_json::to_string(&(target, &device.workspace_root, &prefix)).unwrap();
        let lock = queue_lock(key);
        let guard = tokio::select! { biased; _=cancelled(cancel)=>return Err(crate::runtime::host::canceled_error()), guard=lock.lock_owned()=>guard };
        check_cancel(cancel)?;
        let endpoint = WorkspaceRef::device(&device.id, &device.workspace_root);
        let mut host = Host::open_create(&endpoint, device, config)
            .await
            .map_err(map)?;
        let root = host.endpoint(&endpoint).device_ref().unwrap().1.to_owned();
        if let (Some(source_device), WorkspaceRef::Device { .. }) = (source_device, source) {
            let same_account = match (source_device.transport, device.transport) {
                (TransportKind::Ssh, TransportKind::Ssh) => {
                    source_device.host.eq_ignore_ascii_case(&device.host)
                        && source_device.port == device.port
                        && source_device.username == device.username
                }
                (TransportKind::Wsl, TransportKind::Wsl) => source_device
                    .wsl
                    .as_ref()
                    .zip(device.wsl.as_ref())
                    .is_some_and(|(a, b)| a.distribution == b.distribution && a.user == b.user),
                _ => false,
            };
            if same_account {
                let source_host = Host::open(source, Some(source_device), config)
                    .await
                    .map_err(map)?;
                let source_root = source_host
                    .endpoint(source)
                    .device_ref()
                    .unwrap()
                    .1
                    .to_owned();
                let target = format!("{}/{prefix}/workspace", root.trim_end_matches('/'));
                let contains = |a: &str, b: &str| {
                    a == b
                        || b.strip_prefix(a.trim_end_matches('/'))
                            .is_some_and(|suffix| suffix.starts_with('/'))
                };
                if contains(&source_root, &target) || contains(&target, &source_root) {
                    return Err(failure("source and target device workspaces overlap"));
                }
            }
        }
        if let (WorkspaceRef::Local { dir }, Some(alias)) = (source, host.local_alias()) {
            let source = std::fs::canonicalize(dir)?;
            let target = alias.join(&prefix).join("workspace");
            if target.starts_with(&source) || source.starts_with(&target) {
                return Err(failure(
                    "source and target workspace overlap through a local/WSL path alias",
                ));
            }
        }
        host.mkdir(&prefix).await.map_err(map)?;
        host.mkdir(&format!("{prefix}/.sync")).await.map_err(map)?;
        // Both are needed to publish a lease without clobbering another owner,
        // and to replace existing content without deleting it first.
        if !host.safe_publish() || !host.overwrite() {
            return Err(failure(
                "SFTP server requires hardlink and atomic overwrite extensions",
            ));
        }
        claim_directory(
            &mut host,
            &prefix,
            &id,
            &format!("{}/{prefix}", root.trim_end_matches('/')),
        )
        .await?;
        let path = format!("{prefix}/.sync/lease.json");
        if host.stat(&path).await.map_err(map)?.is_some() {
            return Err(failure(format!("workspace is leased; verify the previous process has ended before recovering {root}/{path}; locks are never expired automatically")));
        }
        let owner = serde_json::to_vec(&serde_json::json!({"version":VERSION,"run_id":run_id,"owner":uuid::Uuid::new_v4().to_string(),"created_at":chrono::Utc::now().to_rfc3339()})).unwrap();
        publish(&mut host, &path, &owner, 0o600, &None, None, None).await?;
        Ok(Self {
            host,
            prefix: prefix.clone(),
            id,
            owner,
            destination: format!("{}/{prefix}/workspace", root.trim_end_matches('/')),
            process_started: false,
            process_finished: false,
            _queue: guard,
        })
    }
    pub async fn synchronize(
        &mut self,
        local: &Path,
        policy: Policy,
        cancel: Arc<AtomicBool>,
    ) -> Result<Report> {
        let mut report = synchronize(
            &mut self.host,
            &self.prefix,
            &self.id,
            local,
            policy,
            cancel,
        )
        .await?;
        report.destination = self.destination.clone();
        Ok(report)
    }
    pub async fn release(mut self) -> Result<()> {
        let path = format!("{}/.sync/lease.json", self.prefix);
        if read_blob(&mut self.host, &path, 4096).await?.as_deref() != Some(&self.owner) {
            return Err(failure("lease ownership changed; refusing to release it"));
        }
        let attrs = self
            .host
            .stat(&path)
            .await
            .map_err(map)?
            .ok_or_else(|| failure("lease disappeared"))?;
        self.host.unlink(&path, &attrs).await.map_err(map)
    }
}

async fn read_blob(host: &mut Host, path: &str, limit: usize) -> Result<Option<Vec<u8>>> {
    let Some(attrs) = host.stat(path).await.map_err(map)? else {
        return Ok(None);
    };
    if attrs.kind != "file" || attrs.size > limit as u64 {
        return Err(failure(format!("invalid or oversized metadata: {path}")));
    }
    let (mut handle, opened) = host.open_read(path).await.map_err(map)?;
    let result = async {
        if opened != attrs {
            return Err(failure("metadata changed while opening"));
        }
        let mut bytes = Vec::new();
        loop {
            let chunk = host
                .read(&mut handle, bytes.len() as u64)
                .await
                .map_err(map)?;
            if chunk.is_empty() {
                break;
            }
            if bytes.len() + chunk.len() > limit {
                return Err(failure("metadata grew beyond limit"));
            }
            bytes.extend_from_slice(&chunk);
        }
        if host.stat(path).await.map_err(map)? != Some(attrs) {
            return Err(failure("metadata changed while reading"));
        }
        Ok(Some(bytes))
    }
    .await;
    let close = host.close(handle, false, None).await.map_err(map);
    let bytes = result?;
    close?;
    Ok(bytes)
}

async fn publish(
    host: &mut Host,
    path: &str,
    bytes: &[u8],
    mode: u32,
    expected: &Option<Attributes>,
    planned_temp: Option<&str>,
    cancel: Option<&AtomicBool>,
) -> Result<()> {
    let temp = planned_temp
        .map(str::to_owned)
        .unwrap_or_else(|| temporary(path));
    let mut writer = host.create_temp(&temp).await.map_err(map)?;
    let result = async {
        for (index, chunk) in bytes.chunks(CHUNK).enumerate() {
            if let Some(cancel) = cancel {
                check_cancel(cancel)?;
            }
            host.write(&mut writer, (index * CHUNK) as u64, chunk.to_vec())
                .await
                .map_err(map)?;
        }
        Ok::<_, RunnerError>(())
    }
    .await;
    let close = host.close(writer, true, Some(mode)).await.map_err(map);
    let result = async {
        result?;
        close?;
        if let Some(cancel) = cancel {
            check_cancel(cancel)?;
        }
        host.commit(&temp, path, expected.is_some(), expected)
            .await
            .map_err(map)
    }
    .await;
    // WSL already unlinks a renamed temp; SSH hardlink publication leaves one.
    let cleanup = host.remove_temp(&temp).await;
    if result.is_ok() {
        if let Err(e) = cleanup {
            if e.code != "not_found" {
                return Err(map(e));
            }
        }
    }
    result
}

fn temporary(path: &str) -> String {
    let parent = path
        .rsplit_once('/')
        .map(|v| format!("{}/", v.0))
        .unwrap_or_default();
    format!("{parent}.rr-transfer-{}.part", uuid::Uuid::new_v4())
}

async fn fingerprint(
    host: &mut Host,
    path: &str,
    policy: Policy,
    cancel: &AtomicBool,
) -> Result<Option<(String, Attributes)>> {
    let result = host
        .inspect(&[path.to_owned()], policy.file_limit, cancel)
        .await
        .map_err(map)?
        .pop()
        .unwrap();
    result
        .map(|value| {
            let hash = value
                .sha256
                .ok_or_else(|| failure(format!("expected a regular file: {path}")))?;
            Ok((hash, value.attrs))
        })
        .transpose()
}

struct Snapshot {
    manifest: Manifest,
    sources: BTreeMap<String, Source>,
    cached_files: u64,
    hashed_files: u64,
}
fn snapshot(
    local: &Path,
    previous: &Manifest,
    policy: Policy,
    cancel: &AtomicBool,
) -> Result<Snapshot> {
    let mut result = Snapshot {
        manifest: Manifest::empty(&previous.workspace_id),
        sources: BTreeMap::new(),
        cached_files: 0,
        hashed_files: 0,
    };
    let mut total = 0;
    for source in workspace_upload::scan(local, policy)? {
        check_cancel(cancel)?;
        let stamp = (!source.directory)
            .then(|| SourceStamp::from_metadata(&source.metadata))
            .flatten();
        // Only a complete stamp from this version may bypass content reads.
        // Serial's UTF-8 validation must always read the content.
        let cached = previous.entries.get(&source.relative).filter(|old| {
            !policy.text_only
                && !old.directory
                && old
                    .source
                    .as_ref()
                    .zip(stamp.as_ref())
                    .is_some_and(|(old, current)| old.matches_cache(current))
        });
        let record = if source.directory {
            Record {
                directory: true,
                sha256: String::new(),
                size: 0,
                mode: source.mode,
                source: None,
            }
        } else if let Some(cached) = cached {
            result.cached_files += 1;
            total += source.metadata.len() as usize;
            Record {
                mode: source.mode,
                source: stamp,
                ..cached.clone()
            }
        } else {
            let entry = workspace_upload::read_source(source.clone(), policy)?;
            let after = workspace_upload::source_metadata(&source)?;
            if SourceStamp::from_metadata(&after) != stamp
                || entry.source_bytes as u64 != source.metadata.len()
            {
                return Err(failure(format!(
                    "source changed while hashing: {}",
                    source.relative
                )));
            }
            result.hashed_files += 1;
            total += entry.source_bytes;
            Record {
                directory: false,
                sha256: digest(entry.data.as_deref().unwrap()),
                size: entry.data.as_ref().unwrap().len() as u64,
                mode: entry.mode,
                source: stamp,
            }
        };
        if total > policy.total_limit {
            return Err(failure("workspace total size limit exceeded"));
        }
        result
            .manifest
            .entries
            .insert(source.relative.clone(), record);
        result.sources.insert(source.relative.clone(), source);
    }
    result.manifest.validate(&previous.workspace_id, policy)?;
    Ok(result)
}

async fn verify_sources(
    sources: Arc<BTreeMap<String, Source>>,
    cancel: Arc<AtomicBool>,
) -> Result<()> {
    tokio::task::spawn_blocking(move || {
        for source in sources.values() {
            check_cancel(&cancel)?;
            let current = workspace_upload::source_metadata(source)?;
            if !source.directory
                && (current.len() != source.metadata.len()
                    || SourceStamp::from_metadata(&current)
                        != SourceStamp::from_metadata(&source.metadata))
            {
                return Err(failure(format!(
                    "source changed during sync: {}",
                    source.relative
                )));
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| failure(e.to_string()))?
}

enum Action {
    Directory(String),
    Upload(String, Option<(String, Attributes)>, String),
    Chmod(String, String, Attributes),
    Delete(String, String, Attributes),
    RemoveDirectory(String),
}

async fn synchronize(
    host: &mut Host,
    prefix: &str,
    id: &str,
    local: &Path,
    policy: Policy,
    cancel: Arc<AtomicBool>,
) -> Result<Report> {
    check_cancel(&cancel)?;
    // This directory is exclusively application metadata, outside workload
    // data. A crash before publishing a journal can leave metadata write temps;
    // after acquiring the lease they can be safely removed by their exact type.
    for entry in host.list(&format!("{prefix}/.sync")).await.map_err(map)? {
        if let Some(nonce) = entry
            .name
            .strip_prefix(".rr-transfer-")
            .and_then(|n| n.strip_suffix(".part"))
        {
            if uuid::Uuid::parse_str(nonce).is_ok()
                && entry.attrs.kind == "file"
                && entry.attrs.size <= JOURNAL_LIMIT as u64
            {
                check_cancel(&cancel)?;
                host.remove_temp(&format!("{prefix}/.sync/{}", entry.name))
                    .await
                    .map_err(map)?;
            }
        }
    }
    let manifest_path = format!("{prefix}/.sync/manifest.json");
    let pending_path = format!("{prefix}/.sync/pending.json");
    let old_bytes = read_blob(host, &manifest_path, MANIFEST_LIMIT).await?;
    let had_manifest = old_bytes.is_some();
    let old = match old_bytes {
        Some(bytes) => serde_json::from_slice::<Manifest>(&bytes)
            .map_err(|e| failure(format!("invalid manifest (no deletion performed): {e}")))?,
        None => Manifest::empty(id),
    };
    old.validate(id, policy)?;
    let pending = read_blob(host, &pending_path, JOURNAL_LIMIT)
        .await?
        .map(|bytes| {
            serde_json::from_slice::<Pending>(&bytes)
                .map_err(|e| failure(format!("invalid recovery journal: {e}")))
        })
        .transpose()?;
    if let Some(pending) = &pending {
        pending.previous.validate(id, policy)?;
        pending.next.validate(id, policy)?;
        if old != pending.previous && old != pending.next {
            return Err(failure("manifest does not match recovery journal"));
        }
    }
    // Read/validate the last committed manifest BEFORE reading local content.
    // An interrupted transaction is never used as a source cache baseline.
    let (local, previous, flag) = (local.to_path_buf(), old.clone(), cancel.clone());
    let started = std::time::Instant::now();
    let snapshot = tokio::task::spawn_blocking(move || snapshot(&local, &previous, policy, &flag))
        .await
        .map_err(|e| failure(e.to_string()))??;
    tracing::info!(
        cached_files = snapshot.cached_files,
        hashed_files = snapshot.hashed_files,
        elapsed_ms = started.elapsed().as_millis(),
        "workspace source scan"
    );
    let next = snapshot.manifest;
    let sources = Arc::new(snapshot.sources);
    // Preserve ownership from an interrupted transaction until it is fully
    // reconciled, including newly published files absent from the old manifest.
    let mut owned = old.entries.clone();
    if let Some(pending) = &pending {
        for (path, record) in pending
            .previous
            .entries
            .iter()
            .chain(&pending.next.entries)
            .chain(&pending.retained)
        {
            owned.entry(path.clone()).or_insert_with(|| record.clone());
        }
    }
    Manifest {
        entries: owned.clone(),
        ..old.clone()
    }
    .validate(
        id,
        Policy {
            entry_limit: policy.entry_limit * 2,
            total_limit: policy.total_limit * 2,
            ..policy
        },
    )?;
    if let Some(pending) = &pending {
        if pending.temps.len() > policy.entry_limit {
            return Err(failure("too many recovery temporary files"));
        }
        for path in &pending.temps {
            let relative = path
                .strip_prefix(&format!("{prefix}/workspace/"))
                .ok_or_else(|| failure("invalid recovery temporary path"))?;
            crate::file_transfer::relative(relative).map_err(map)?;
            let leaf = relative.rsplit('/').next().unwrap();
            let nonce = leaf
                .strip_prefix(".rr-transfer-")
                .and_then(|p| p.strip_suffix(".part"))
                .ok_or_else(|| failure("invalid recovery temporary name"))?;
            uuid::Uuid::parse_str(nonce)
                .map_err(|_| failure("invalid recovery temporary nonce"))?;
        }
        // Only exact names durably recorded BEFORE upload are eligible. Never
        // glob the workspace, since unknown files belong to the workload.
        for path in &pending.temps {
            check_cancel(&cancel)?;
            if let Some(attrs) = host.stat(path).await.map_err(map)? {
                if attrs.kind != "file" || attrs.size > policy.file_limit {
                    return Err(failure("invalid recovery temporary file"));
                }
                host.remove_temp(path).await.map_err(map)?;
            }
        }
    }
    host.mkdir(&format!("{prefix}/workspace"))
        .await
        .map_err(map)?;
    // Trust the committed manifest for unchanged sources. Recovery must inspect
    // actual targets: an interrupted upload may have published a newer version.
    let unchanged: std::collections::BTreeSet<_> = next
        .entries
        .iter()
        .filter(|(path, desired)| {
            pending.is_none()
                && !policy.text_only
                && old.entries.get(*path).is_some_and(|previous| {
                    previous.directory == desired.directory
                        && previous.mode == desired.mode
                        && (desired.directory
                            || (previous.sha256 == desired.sha256
                                && previous.size == desired.size
                                && previous
                                    .source
                                    .as_ref()
                                    .zip(desired.source.as_ref())
                                    .is_some_and(|(old, current)| old.matches_cache(current))))
                })
        })
        .map(|(path, _)| path.clone())
        .collect();
    let remote_path = |path: &str| format!("{prefix}/workspace/{path}");
    let paths: Vec<_> = next
        .entries
        .keys()
        .chain(owned.keys())
        .filter(|path| !unchanged.contains(*path))
        .map(|path| remote_path(path))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let started = std::time::Instant::now();
    let inspected = host
        .inspect(&paths, policy.file_limit, &cancel)
        .await
        .map_err(map)?;
    let mut inspected: BTreeMap<_, _> = paths.into_iter().zip(inspected).collect();
    tracing::info!(
        paths = inspected.len(),
        manifest_skipped = unchanged.len(),
        elapsed_ms = started.elapsed().as_millis(),
        "workspace remote preflight"
    );
    let mut actions = Vec::new();
    let mut report = Report::default();
    // Preflight all remaining paths before changing workload data.
    for (path, desired) in &next.entries {
        check_cancel(&cancel)?;
        if unchanged.contains(path) {
            if !desired.directory {
                report.skipped += 1;
            }
            continue;
        }
        let target = remote_path(path);
        let current = inspected.remove(&target).unwrap();
        if desired.directory {
            match current.map(|value| value.attrs) {
                None => actions.push(Action::Directory(path.clone())),
                Some(attrs) if attrs.kind == "dir" => {}
                _ => return Err(failure(format!("file/directory conflict: {path}"))),
            }
            continue;
        }
        let current = current
            .map(|value| {
                let hash = value
                    .sha256
                    .ok_or_else(|| failure(format!("file/directory conflict: {path}")))?;
                Ok::<_, RunnerError>((hash, value.attrs))
            })
            .transpose()?;
        if let Some((hash, attrs)) = &current {
            let trusted = old.entries.get(path).is_some_and(|e| !e.directory)
                || owned
                    .get(path)
                    .is_some_and(|e| !e.directory && e.sha256 == *hash)
                || pending
                    .as_ref()
                    .and_then(|p| p.next.entries.get(path))
                    .is_some_and(|e| !e.directory && e.sha256 == *hash)
                || pending
                    .as_ref()
                    .and_then(|p| p.retained.get(path))
                    .is_some_and(|e| !e.directory && e.sha256 == *hash);
            if !trusted && *hash != desired.sha256 {
                return Err(failure(format!(
                    "unmanaged remote file conflicts with source: {path}"
                )));
            }
            if !old.entries.contains_key(path) && trusted {
                // Pin the version actually present, rather than forgetting an
                // earlier partially published version on a second recovery.
                owned.insert(
                    path.clone(),
                    Record {
                        directory: false,
                        sha256: hash.clone(),
                        size: attrs.size,
                        mode: attrs.mode.unwrap_or(desired.mode),
                        source: None,
                    },
                );
            }
            if *hash == desired.sha256 {
                if attrs.mode.is_some_and(|mode| mode != desired.mode) {
                    actions.push(Action::Chmod(path.clone(), hash.clone(), attrs.clone()));
                    report.permissions += 1;
                } else {
                    report.skipped += 1;
                }
                continue;
            }
            report.updated += 1;
        } else {
            report.added += 1;
        }
        actions.push(Action::Upload(path.clone(), current, temporary(&target)));
    }
    for (path, previous) in &owned {
        if next.entries.contains_key(path) {
            continue;
        }
        let target = remote_path(path);
        let Some(current) = inspected.remove(&target).unwrap() else {
            continue;
        };
        let attrs = current.attrs;
        if previous.directory {
            if attrs.kind != "dir" {
                return Err(failure(format!("managed directory changed type: {path}")));
            }
            actions.push(Action::RemoveDirectory(path.clone()));
        } else {
            let hash = current
                .sha256
                .ok_or_else(|| failure(format!("managed file changed type: {path}")))?;
            let pending_hash = pending
                .as_ref()
                .and_then(|p| p.next.entries.get(path))
                .map(|e| e.sha256.as_str());
            let retained_hash = pending
                .as_ref()
                .and_then(|p| p.retained.get(path))
                .map(|e| e.sha256.as_str());
            if hash != previous.sha256
                && pending_hash != Some(&hash)
                && retained_hash != Some(&hash)
            {
                return Err(failure(format!(
                    "deleted source has a remotely modified copy: {path}"
                )));
            }
            actions.push(Action::Delete(path.clone(), hash, attrs));
            report.deleted += 1;
        }
    }
    // Cache hits still need path/type and attribute checks after the remote
    // preflight, which may take much longer than the source scan itself.
    verify_sources(sources.clone(), cancel.clone()).await?;
    if had_manifest && actions.is_empty() && old == next && pending.is_none() {
        return Ok(report);
    }
    check_cancel(&cancel)?;
    // The recovery baseline includes the ownership union, so cancellation of a
    // second recovery attempt cannot forget files created by the first attempt.
    let journal = Pending {
        previous: old.clone(),
        next: next.clone(),
        retained: owned,
        temps: actions
            .iter()
            .filter_map(|a| {
                if let Action::Upload(_, _, temp) = a {
                    Some(temp.clone())
                } else {
                    None
                }
            })
            .collect(),
    };
    let bytes = serde_json::to_vec(&journal).map_err(|e| failure(e.to_string()))?;
    if bytes.len() > JOURNAL_LIMIT {
        return Err(failure("recovery journal too large"));
    }
    let expected = host.stat(&pending_path).await.map_err(map)?;
    publish(host, &pending_path, &bytes, 0o600, &expected, None, None).await?;
    // Directories are created in parent-first lexical order. Deletes only remove
    // individually verified files; no recursive cleanup is ever used here.
    let mut empty_dirs = Vec::new();
    for action in actions {
        check_cancel(&cancel)?;
        match action {
            Action::Directory(path) => host.mkdir(&remote_path(&path)).await.map_err(map)?,
            Action::Upload(path, current, temp) => {
                let source = sources.get(&path).unwrap().clone();
                let entry = tokio::task::spawn_blocking(move || {
                    workspace_upload::read_source(source, policy)
                })
                .await
                .map_err(|e| failure(e.to_string()))??;
                let bytes = entry.data.ok_or_else(|| failure("source changed type"))?;
                if digest(&bytes) != next.entries[&path].sha256 {
                    return Err(failure(format!("source changed during sync: {path}")));
                }
                if fingerprint(host, &remote_path(&path), policy, &cancel).await? != current {
                    return Err(failure(format!("target changed during sync: {path}")));
                }
                publish(
                    host,
                    &remote_path(&path),
                    &bytes,
                    entry.mode,
                    &current.map(|v| v.1),
                    Some(&temp),
                    Some(&cancel),
                )
                .await?;
                report.uploaded_bytes += bytes.len() as u64;
            }
            Action::Chmod(path, hash, attrs) => {
                if fingerprint(host, &remote_path(&path), policy, &cancel).await?
                    != Some((hash, attrs.clone()))
                {
                    return Err(failure("target changed before chmod"));
                }
                host.chmod(&remote_path(&path), next.entries[&path].mode, &attrs)
                    .await
                    .map_err(map)?;
            }
            Action::Delete(path, hash, attrs) => {
                if fingerprint(host, &remote_path(&path), policy, &cancel).await?
                    != Some((hash, attrs.clone()))
                {
                    return Err(failure("target changed before deletion"));
                }
                host.unlink(&remote_path(&path), &attrs)
                    .await
                    .map_err(map)?;
            }
            Action::RemoveDirectory(path) => empty_dirs.push(path),
        }
    }
    empty_dirs.sort_by_key(|p| std::cmp::Reverse(p.len()));
    for path in empty_dirs {
        check_cancel(&cancel)?;
        if host
            .list(&remote_path(&path))
            .await
            .map_err(map)?
            .is_empty()
        {
            host.rmdir(&remote_path(&path)).await.map_err(map)?;
        }
    }
    check_cancel(&cancel)?;
    verify_sources(sources, cancel.clone()).await?;
    let bytes = serde_json::to_vec(&next).map_err(|e| failure(e.to_string()))?;
    if bytes.len() > MANIFEST_LIMIT {
        return Err(failure("manifest too large"));
    }
    let expected = host.stat(&manifest_path).await.map_err(map)?;
    publish(host, &manifest_path, &bytes, 0o600, &expected, None, None).await?;
    let expected = host
        .stat(&pending_path)
        .await
        .map_err(map)?
        .ok_or_else(|| failure("recovery journal disappeared"))?;
    host.unlink(&pending_path, &expected).await.map_err(map)?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        root: std::path::PathBuf,
        source: std::path::PathBuf,
        target: std::path::PathBuf,
        host: Host,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("rr-sync-test-{}", uuid::Uuid::new_v4()));
            let source = root.join("source");
            let target = root.join("target");
            std::fs::create_dir_all(&source).unwrap();
            std::fs::create_dir_all(target.join("rr-test/.sync")).unwrap();
            Self {
                root,
                source,
                target: target.clone(),
                host: Host::Local(std::fs::canonicalize(target).unwrap()),
            }
        }
        async fn sync(&mut self) -> Result<Report> {
            synchronize(
                &mut self.host,
                "rr-test",
                "test",
                &self.source,
                workspace_upload::SSH,
                Arc::new(AtomicBool::new(false)),
            )
            .await
        }
        fn remote(&self, path: &str) -> std::path::PathBuf {
            self.target.join("rr-test/workspace").join(path)
        }
        fn write(&self, path: &str, bytes: impl AsRef<[u8]>) {
            std::fs::write(self.source.join(path), bytes).unwrap();
        }
        fn manifest(&self) -> Manifest {
            serde_json::from_slice(
                &std::fs::read(self.target.join("rr-test/.sync/manifest.json")).unwrap(),
            )
            .unwrap()
        }
        fn journal(&self, previous: Manifest, next: Manifest, retained: BTreeMap<String, Record>) {
            std::fs::write(
                self.target.join("rr-test/.sync/pending.json"),
                serde_json::to_vec(&Pending {
                    previous,
                    next,
                    retained,
                    temps: Vec::new(),
                })
                .unwrap(),
            )
            .unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn visible_name_comes_from_the_original_source_and_rejects_unsafe_names() {
        let local = std::env::temp_dir().join("work");
        assert_eq!(
            directory_name(&WorkspaceRef::local(local.to_string_lossy())).unwrap(),
            "work"
        );
        assert_eq!(
            directory_name(&WorkspaceRef::device("source", "/projects/工作 目录/")).unwrap(),
            "工作 目录"
        );
        for path in [
            "/",
            "/projects/..",
            "/projects/../work",
            "/projects/bad\\name",
            "/projects/nul",
            "/projects/bad\nname",
        ] {
            assert!(
                directory_name(&WorkspaceRef::device("source", path)).is_err(),
                "{path:?}"
            );
        }
    }

    #[tokio::test]
    async fn named_directory_claim_reopens_only_for_its_owner_and_preserves_existing_data() {
        let mut f = Fixture::new();
        f.host.mkdir("work").await.unwrap();
        f.host.mkdir("work/.sync").await.unwrap();
        claim_directory(&mut f.host, "work", "owner-a", "/home/xx/work")
            .await
            .unwrap();
        std::fs::write(f.target.join("work/artifact"), b"keep").unwrap();
        claim_directory(&mut f.host, "work", "owner-a", "/home/xx/work")
            .await
            .unwrap();
        assert!(
            claim_directory(&mut f.host, "work", "owner-b", "/home/xx/work")
                .await
                .unwrap_err()
                .to_string()
                .contains("name conflict")
        );
        assert_eq!(
            std::fs::read(f.target.join("work/artifact")).unwrap(),
            b"keep"
        );
        f.host.mkdir("existing").await.unwrap();
        f.host.mkdir("existing/.sync").await.unwrap();
        std::fs::write(f.target.join("existing/important"), b"user data").unwrap();
        assert!(
            claim_directory(&mut f.host, "existing", "owner-a", "/home/xx/existing")
                .await
                .is_err()
        );
        assert!(!f.target.join("existing/.sync/identity.json").exists());
        assert_eq!(
            std::fs::read(f.target.join("existing/important")).unwrap(),
            b"user data"
        );
    }

    #[tokio::test]
    async fn concurrent_clients_cannot_claim_the_same_name_for_different_sources() {
        let mut f = Fixture::new();
        f.host.mkdir("work").await.unwrap();
        f.host.mkdir("work/.sync").await.unwrap();
        let mut other = Host::Local(std::fs::canonicalize(&f.target).unwrap());
        let (a, b) = tokio::join!(
            claim_directory(&mut f.host, "work", "a", "/work"),
            claim_directory(&mut other, "work", "b", "/work")
        );
        assert_ne!(a.is_ok(), b.is_ok());
        let bytes = std::fs::read(f.target.join("work/.sync/identity.json")).unwrap();
        assert_eq!(verify_identity(&bytes, "a", "/work").is_ok(), a.is_ok());
    }

    #[tokio::test]
    async fn repeats_upload_zero_bytes_and_only_changed_normalized_files_are_sent() {
        let mut f = Fixture::new();
        f.write("main.py", b"print(1)\r\n");
        f.write("binary.bin", [0, 255, 13, 10]);
        std::fs::create_dir(f.source.join("empty")).unwrap();
        std::fs::create_dir(f.source.join(".runner")).unwrap();
        f.write(".runner/config.json", b"excluded");
        let r = f.sync().await.unwrap();
        assert_eq!(r.added, 2);
        assert_eq!(r.uploaded_bytes, 13);
        assert_eq!(std::fs::read(f.remote("main.py")).unwrap(), b"print(1)\n");
        assert!(f.remote("empty").is_dir());
        assert!(!f.remote(".runner").exists());
        let manifest = f.manifest();
        f.write("main.py", b"print(1)\n");
        let r = f.sync().await.unwrap();
        assert_eq!((r.uploaded_bytes, r.skipped), (0, 2));
        // Same normalized content, new source metadata: commit the new stamp
        // despite zero content uploads, so subsequent runs can use the cache.
        let refreshed = f.manifest();
        assert_ne!(
            refreshed.entries["main.py"].source,
            manifest.entries["main.py"].source
        );
        assert_eq!(
            refreshed.entries["main.py"].sha256,
            manifest.entries["main.py"].sha256
        );
        assert_eq!(f.sync().await.unwrap().uploaded_bytes, 0);
        assert_eq!(f.manifest(), refreshed);
        f.write("main.py", b"print(2)\n");
        let r = f.sync().await.unwrap();
        assert_eq!((r.updated, r.skipped, r.uploaded_bytes), (1, 1, 9));
        assert_eq!(
            std::fs::read(f.remote("binary.bin")).unwrap(),
            [0, 255, 13, 10]
        );
    }

    fn scan(f: &Fixture, previous: &Manifest) -> Snapshot {
        snapshot(
            &f.source,
            previous,
            workspace_upload::SSH,
            &AtomicBool::new(false),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn committed_source_attributes_skip_reads_and_invalidate_only_changed_files() {
        use std::fs::{File, FileTimes};
        use std::time::{Duration, UNIX_EPOCH};

        let mut f = Fixture::new();
        f.write("main.py", b"print(1)\r\n");
        f.write("data.bin", b"data");
        std::fs::create_dir(f.source.join("empty")).unwrap();
        f.sync().await.unwrap();
        let old = f.manifest();
        let record = &old.entries["main.py"];
        assert_eq!((record.source.as_ref().unwrap().size, record.size), (10, 9));
        let cached = scan(&f, &old);
        assert_eq!((cached.cached_files, cached.hashed_files), (2, 0));
        assert_eq!(cached.manifest, old);

        // Timestamp-only change must invalidate the cached source digest even
        // though the remote data is identical and should not be uploaded.
        File::options()
            .write(true)
            .open(f.source.join("main.py"))
            .unwrap()
            .set_times(
                FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(1_700_000_000)),
            )
            .unwrap();
        let touched = scan(&f, &old);
        assert_eq!((touched.cached_files, touched.hashed_files), (1, 1));
        assert_eq!(touched.manifest.entries["main.py"].sha256, record.sha256);
        assert_eq!(f.sync().await.unwrap().uploaded_bytes, 0);
        assert_eq!(scan(&f, &f.manifest()).hashed_files, 0);

        // A same-size edit invalidates by mtime; a different-size edit must
        // invalidate even if a tool restores the previous modification time.
        let saved_time = std::fs::metadata(f.source.join("main.py"))
            .unwrap()
            .modified()
            .unwrap();
        f.write("main.py", b"print(2)\r\n");
        let edited = scan(&f, &f.manifest());
        assert_eq!((edited.cached_files, edited.hashed_files), (1, 1));
        assert_ne!(edited.manifest.entries["main.py"].sha256, record.sha256);
        f.write("main.py", b"print(22)\r\n");
        File::options()
            .write(true)
            .open(f.source.join("main.py"))
            .unwrap()
            .set_times(FileTimes::new().set_modified(saved_time))
            .unwrap();
        assert_eq!(scan(&f, &f.manifest()).hashed_files, 1);
    }

    #[tokio::test]
    async fn legacy_and_obsolete_source_cache_rebuild_without_changing_workspace_identity() {
        let mut f = Fixture::new();
        f.write("main.py", b"print(1)\n");
        f.sync().await.unwrap();
        let mut legacy = f.manifest();
        for record in legacy.entries.values_mut() {
            record.source = None;
        }
        let bytes = serde_json::to_vec(&legacy).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("\"source\""));
        std::fs::write(f.target.join("rr-test/.sync/manifest.json"), bytes).unwrap();
        assert_eq!(scan(&f, &legacy).hashed_files, 1);
        assert_eq!(f.sync().await.unwrap().uploaded_bytes, 0);
        let current = f.manifest();
        assert_eq!(
            (current.version, current.workspace_id.as_str()),
            (VERSION, "test")
        );
        assert_eq!(scan(&f, &current).cached_files, 1);
        let mut obsolete = current.clone();
        obsolete
            .entries
            .get_mut("main.py")
            .unwrap()
            .source
            .as_mut()
            .unwrap()
            .version += 1;
        assert_eq!(scan(&f, &obsolete).hashed_files, 1);
        assert_eq!(scan(&f, &obsolete).manifest, current);
    }

    #[tokio::test]
    async fn failed_preflight_does_not_commit_source_cache_or_hide_changes_on_retry() {
        let mut f = Fixture::new();
        f.write("a.py", b"old");
        f.sync().await.unwrap();
        let old = f.manifest();
        f.write("a.py", b"new source");
        f.write("z.py", b"source");
        std::fs::write(f.remote("z.py"), b"artifact").unwrap();
        assert!(f.sync().await.is_err());
        assert_eq!(f.manifest(), old);
        assert_eq!(std::fs::read(f.remote("a.py")).unwrap(), b"old");
        assert_eq!(scan(&f, &old).hashed_files, 2);
        std::fs::remove_file(f.remote("z.py")).unwrap();
        assert_eq!(f.sync().await.unwrap().updated, 1);
        assert_eq!(std::fs::read(f.remote("a.py")).unwrap(), b"new source");
        assert_eq!(scan(&f, &f.manifest()).cached_files, 2);
    }

    #[tokio::test]
    async fn cached_sources_are_rechecked_after_remote_preflight() {
        let mut f = Fixture::new();
        f.write("a.py", b"old");
        f.sync().await.unwrap();
        let snapshot = scan(&f, &f.manifest());
        assert_eq!(snapshot.cached_files, 1);
        f.write("a.py", b"new source");
        assert!(
            verify_sources(Arc::new(snapshot.sources), Arc::new(AtomicBool::new(false)))
                .await
                .unwrap_err()
                .to_string()
                .contains("source changed during sync")
        );
        assert_eq!(std::fs::read(f.remote("a.py")).unwrap(), b"old");
    }

    #[tokio::test]
    async fn deletes_only_owned_files_and_empty_directories_while_preserving_artifacts() {
        let mut f = Fixture::new();
        std::fs::create_dir(f.source.join("out")).unwrap();
        f.write("out/old.py", b"old");
        f.write("rename.py", b"rename");
        f.sync().await.unwrap();
        std::fs::write(f.remote("out/results.log"), b"keep").unwrap();
        std::fs::remove_file(f.source.join("out/old.py")).unwrap();
        std::fs::remove_dir(f.source.join("out")).unwrap();
        std::fs::rename(f.source.join("rename.py"), f.source.join("new.py")).unwrap();
        let r = f.sync().await.unwrap();
        assert_eq!((r.added, r.deleted), (1, 2));
        assert!(!f.remote("out/old.py").exists());
        assert!(!f.remote("rename.py").exists());
        assert_eq!(std::fs::read(f.remote("out/results.log")).unwrap(), b"keep");
        std::fs::create_dir(f.source.join("empty")).unwrap();
        f.sync().await.unwrap();
        std::fs::remove_dir(f.source.join("empty")).unwrap();
        f.sync().await.unwrap();
        assert!(!f.remote("empty").exists());
    }

    #[tokio::test]
    async fn unchanged_sources_trust_manifest_until_source_attributes_change() {
        let mut f = Fixture::new();
        f.write("a.py", b"one");
        f.write("b.py", b"two");
        f.sync().await.unwrap();
        std::fs::write(f.remote("a.py"), b"bad").unwrap();
        std::fs::remove_file(f.remote("b.py")).unwrap();
        let r = f.sync().await.unwrap();
        assert_eq!(
            (r.skipped, r.updated, r.added, r.uploaded_bytes),
            (2, 0, 0, 0)
        );
        assert_eq!(std::fs::read(f.remote("a.py")).unwrap(), b"bad");
        assert!(!f.remote("b.py").exists());

        // Changed sources still inspect targets, repairing modified or missing
        // managed files instead of trusting their old manifest entries.
        f.write("a.py", b"one updated");
        f.write("b.py", b"two updated");
        let r = f.sync().await.unwrap();
        assert_eq!((r.updated, r.added, r.uploaded_bytes), (1, 1, 22));
        assert_eq!(std::fs::read(f.remote("a.py")).unwrap(), b"one updated");
        assert_eq!(std::fs::read(f.remote("b.py")).unwrap(), b"two updated");
    }

    #[tokio::test]
    async fn preserved_size_and_mtime_reuse_cache_even_if_identity_changes() {
        use std::fs::{File, FileTimes};
        let mut f = Fixture::new();
        f.write("a.py", b"one");
        f.sync().await.unwrap();
        let mut old = f.manifest();
        let stamp = old
            .entries
            .get_mut("a.py")
            .unwrap()
            .source
            .as_mut()
            .unwrap();
        stamp.identity = "previous-file-identity".into();
        let modified = std::fs::metadata(f.source.join("a.py"))
            .unwrap()
            .modified()
            .unwrap();
        f.write("a.py", b"two");
        File::options()
            .write(true)
            .open(f.source.join("a.py"))
            .unwrap()
            .set_times(FileTimes::new().set_modified(modified))
            .unwrap();
        std::fs::write(
            f.target.join("rr-test/.sync/manifest.json"),
            serde_json::to_vec(&old).unwrap(),
        )
        .unwrap();
        let snapshot = scan(&f, &old);
        assert_eq!((snapshot.cached_files, snapshot.hashed_files), (1, 0));
        let r = f.sync().await.unwrap();
        assert_eq!((r.skipped, r.uploaded_bytes), (1, 0));
        assert_eq!(std::fs::read(f.remote("a.py")).unwrap(), b"one");
        assert_ne!(
            f.manifest().entries["a.py"].source,
            old.entries["a.py"].source
        );
    }

    #[tokio::test]
    async fn recovery_inspects_unchanged_sources_even_when_manifest_matches() {
        let mut f = Fixture::new();
        f.write("a.py", b"old");
        f.sync().await.unwrap();
        let old = f.manifest();
        let mut interrupted = old.clone();
        interrupted.entries.get_mut("a.py").unwrap().sha256 = digest(b"new");
        std::fs::write(f.remote("a.py"), b"new").unwrap();
        f.journal(old.clone(), interrupted, old.entries.clone());
        let r = f.sync().await.unwrap();
        assert_eq!((r.updated, r.skipped, r.uploaded_bytes), (1, 0, 3));
        assert_eq!(std::fs::read(f.remote("a.py")).unwrap(), b"old");
        assert!(!f.target.join("rr-test/.sync/pending.json").exists());
    }

    #[tokio::test]
    async fn preflight_conflicts_cannot_partially_update_or_delete_remote_results() {
        let mut f = Fixture::new();
        f.write("a.py", b"old");
        f.write("z.py", b"old");
        f.sync().await.unwrap();
        f.write("a.py", b"new");
        std::fs::remove_file(f.source.join("z.py")).unwrap();
        std::fs::write(f.remote("z.py"), b"result").unwrap();
        assert!(f
            .sync()
            .await
            .unwrap_err()
            .to_string()
            .contains("remotely modified"));
        assert_eq!(std::fs::read(f.remote("a.py")).unwrap(), b"old");
        std::fs::write(f.remote("z.py"), b"old").unwrap();
        f.write("unmanaged.py", b"source");
        std::fs::write(f.remote("unmanaged.py"), b"artifact").unwrap();
        assert!(f
            .sync()
            .await
            .unwrap_err()
            .to_string()
            .contains("unmanaged"));
        assert!(f.remote("z.py").exists());
        std::fs::remove_file(f.remote("unmanaged.py")).unwrap();
        std::fs::create_dir(f.remote("unmanaged.py")).unwrap();
        assert!(f.sync().await.is_err());
        assert_eq!(std::fs::read(f.remote("a.py")).unwrap(), b"old");
    }

    #[tokio::test]
    async fn interrupted_sync_reconciles_new_files_and_committed_manifest() {
        let mut f = Fixture::new();
        f.write("a.py", b"a");
        f.sync().await.unwrap();
        let old = f.manifest();
        f.write("b.py", b"b");
        let next = snapshot(
            &f.source,
            &Manifest::empty("test"),
            workspace_upload::SSH,
            &AtomicBool::new(false),
        )
        .unwrap()
        .manifest;
        std::fs::write(f.remote("b.py"), b"b").unwrap();
        f.journal(old.clone(), next.clone(), old.entries.clone());
        // Source changes again before recovery; the partially uploaded b.py must
        // still be recognized as owned and removed instead of becoming garbage.
        std::fs::remove_file(f.source.join("b.py")).unwrap();
        let r = f.sync().await.unwrap();
        assert_eq!(r.deleted, 1);
        assert!(!f.remote("b.py").exists());
        let committed = f.manifest();
        f.journal(old, committed.clone(), committed.entries.clone());
        assert_eq!(f.sync().await.unwrap().uploaded_bytes, 0);
        assert!(!f.target.join("rr-test/.sync/pending.json").exists());
    }

    #[tokio::test]
    async fn repeated_recovery_preserves_the_version_actually_published() {
        let mut f = Fixture::new();
        f.sync().await.unwrap();
        let old = f.manifest();
        f.write("a.py", b"first");
        let first = snapshot(
            &f.source,
            &Manifest::empty("test"),
            workspace_upload::SSH,
            &AtomicBool::new(false),
        )
        .unwrap()
        .manifest;
        std::fs::write(f.remote("a.py"), b"first").unwrap();
        f.write("a.py", b"second");
        let second = snapshot(
            &f.source,
            &Manifest::empty("test"),
            workspace_upload::SSH,
            &AtomicBool::new(false),
        )
        .unwrap()
        .manifest;
        f.journal(old, second, first.entries);
        f.write("a.py", b"third");
        assert_eq!(f.sync().await.unwrap().updated, 1);
        assert_eq!(std::fs::read(f.remote("a.py")).unwrap(), b"third");
    }

    #[tokio::test]
    async fn recovery_cleans_only_journalled_upload_temps_and_private_metadata_temps() {
        let mut f = Fixture::new();
        f.write("a.py", b"keep");
        f.sync().await.unwrap();
        let old = f.manifest();
        let recorded = format!(
            "rr-test/workspace/.rr-transfer-{}.part",
            uuid::Uuid::new_v4()
        );
        let unknown = format!(".rr-transfer-{}.part", uuid::Uuid::new_v4());
        std::fs::write(f.target.join(&recorded), b"partial").unwrap();
        std::fs::write(f.remote(&unknown), b"artifact").unwrap();
        let metadata = format!("rr-test/.sync/.rr-transfer-{}.part", uuid::Uuid::new_v4());
        std::fs::write(f.target.join(&metadata), b"partial metadata").unwrap();
        let journal = Pending {
            previous: old.clone(),
            next: old,
            retained: BTreeMap::new(),
            temps: vec![recorded.clone()],
        };
        std::fs::write(
            f.target.join("rr-test/.sync/pending.json"),
            serde_json::to_vec(&journal).unwrap(),
        )
        .unwrap();
        assert_eq!(f.sync().await.unwrap().uploaded_bytes, 0);
        assert!(!f.target.join(recorded).exists());
        assert!(!f.target.join(metadata).exists());
        assert_eq!(std::fs::read(f.remote(&unknown)).unwrap(), b"artifact");
    }

    #[tokio::test]
    async fn invalid_metadata_and_cancellation_never_remove_files() {
        let mut f = Fixture::new();
        f.write("a.py", b"keep");
        f.sync().await.unwrap();
        let cancel = Arc::new(AtomicBool::new(true));
        std::fs::remove_file(f.source.join("a.py")).unwrap();
        assert!(synchronize(
            &mut f.host,
            "rr-test",
            "test",
            &f.source,
            workspace_upload::SSH,
            cancel
        )
        .await
        .is_err());
        let mut manifest = f.manifest();
        let record = manifest.entries.remove("a.py").unwrap();
        manifest.entries.insert("../escape".into(), record);
        std::fs::write(
            f.target.join("rr-test/.sync/manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert!(f.sync().await.is_err());
        assert_eq!(std::fs::read(f.remote("a.py")).unwrap(), b"keep");
        manifest.entries.clear();
        manifest.workspace_id = "foreign".into();
        std::fs::write(
            f.target.join("rr-test/.sync/manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert!(f.sync().await.is_err());
    }

    #[tokio::test]
    async fn persistent_client_and_original_source_determine_workspace_identity() {
        let f = Fixture::new();
        let source = WorkspaceRef::local(f.source.to_string_lossy());
        let a = workspace_id(&source, None, &f.root.join("client"))
            .await
            .unwrap();
        f.write("change.py", b"changed");
        assert_eq!(
            workspace_id(&source, None, &f.root.join("client"))
                .await
                .unwrap(),
            a
        );
        assert_ne!(
            workspace_id(
                &WorkspaceRef::local(f.target.to_string_lossy()),
                None,
                &f.root.join("client")
            )
            .await
            .unwrap(),
            a
        );
        assert_ne!(
            workspace_id(&source, None, &f.root.join("other-client"))
                .await
                .unwrap(),
            a
        );
    }

    #[tokio::test]
    async fn queue_guard_spans_the_run_and_waiting_can_be_cancelled() {
        let key = uuid::Uuid::new_v4().to_string();
        let first = queue_lock(key.clone()).lock_owned().await;
        let second = queue_lock(key);
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let waiting = tokio::spawn(async move {
            tokio::select! {_ = cancelled(&flag)=>false, _ = second.lock_owned()=>true}
        });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(!waiting.await.unwrap());
        drop(first);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mode_only_change_transfers_no_content_and_links_never_escape() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let mut f = Fixture::new();
        f.write("a.sh", b"echo ok");
        f.sync().await.unwrap();
        std::fs::set_permissions(
            f.source.join("a.sh"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let r = f.sync().await.unwrap();
        assert_eq!((r.permissions, r.uploaded_bytes), (1, 0));
        std::fs::remove_file(f.remote("a.sh")).unwrap();
        symlink(f.source.join("a.sh"), f.remote("a.sh")).unwrap();
        // Unchanged targets are trusted; a required update must still reject
        // links before writing anything through them.
        std::fs::set_permissions(
            f.source.join("a.sh"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        assert!(f.sync().await.is_err());
        assert_eq!(std::fs::read(f.source.join("a.sh")).unwrap(), b"echo ok");
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "opt in with REMOTE_RUNNER_TEST_WSL; creates only a uniquely named /tmp test directory"]
    async fn wsl_workspace_sync_runs_repeatedly_in_place_and_cancels_a_queued_run() {
        use crate::{
            process::RunState,
            runner::{RunManager, RunRequest, RunStatus},
        };
        let f = Fixture::new();
        let remote = format!("/tmp/rr-incremental-test-{}", uuid::Uuid::new_v4());
        let distribution =
            std::env::var("REMOTE_RUNNER_TEST_WSL").expect("choose a WSL distribution");
        let device:DeviceProfile=serde_json::from_value(serde_json::json!({"id":"wsl-sync","name":"WSL sync","transport":"wsl","wsl":{"distribution":distribution},"workspace_root":remote})).unwrap();
        let config = f.root.join("config");
        let (tx, _rx) = crate::events::channel();
        let manager = RunManager::new(&config, tx);
        let req = |command: &str| -> RunRequest {
            serde_json::from_value(serde_json::json!({"device_id":device.id,"kind":"command","command":command,"workspace":WorkspaceRef::local(f.source.to_string_lossy()),"console_mode":"pipe","timeout_secs":15})).unwrap()
        };
        async fn state(manager: &RunManager, id: &str, expected: RunState) -> RunStatus {
            tokio::time::timeout(std::time::Duration::from_secs(45), async {
                loop {
                    let status = manager.status(id).unwrap();
                    if status.state == expected {
                        return status;
                    }
                    assert!(
                        status.state.is_active(),
                        "unexpected final state: {status:?}"
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
            })
            .await
            .unwrap()
        }
        f.write("main.py",b"from pathlib import Path\np=Path('results.log')\np.write_text((p.read_text() if p.exists() else '')+'x')\nprint('first')\n");
        f.write("old.py", b"old");
        let id = manager
            .start(req("python3 main.py"), device.clone(), config.clone(), None)
            .unwrap();
        let first = state(&manager, &id, RunState::Exited)
            .await
            .workspace_sync
            .unwrap();
        assert_eq!(first.added, 2);
        let id = manager
            .start(req("python3 main.py"), device.clone(), config.clone(), None)
            .unwrap();
        let second = state(&manager, &id, RunState::Exited)
            .await
            .workspace_sync
            .unwrap();
        assert_eq!(first.destination, second.destination);
        assert_eq!((second.uploaded_bytes, second.skipped), (0, 2));
        let mut host = Host::open(
            &WorkspaceRef::device(&device.id, &second.destination),
            Some(&device),
            &config,
        )
        .await
        .unwrap();
        let attrs = host.stat("main.py").await.unwrap().unwrap();
        host.chmod("main.py", 0o644, &attrs).await.unwrap();
        drop(host);
        let id = manager
            .start(req("true"), device.clone(), config.clone(), None)
            .unwrap();
        let modes = state(&manager, &id, RunState::Exited)
            .await
            .workspace_sync
            .unwrap();
        assert_eq!(
            (modes.permissions, modes.skipped, modes.uploaded_bytes),
            (0, 2, 0)
        );
        // Touching the source enables target inspection and permission repair.
        std::fs::File::options()
            .write(true)
            .open(f.source.join("main.py"))
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(
                std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000),
            ))
            .unwrap();
        let id = manager
            .start(req("true"), device.clone(), config.clone(), None)
            .unwrap();
        let repaired = state(&manager, &id, RunState::Exited)
            .await
            .workspace_sync
            .unwrap();
        assert_eq!((repaired.permissions, repaired.uploaded_bytes), (1, 0));
        f.write("main.py", b"print('updated')\n");
        std::fs::remove_file(f.source.join("old.py")).unwrap();
        let id = manager
            .start(req("python3 main.py"), device.clone(), config.clone(), None)
            .unwrap();
        let third = state(&manager, &id, RunState::Exited)
            .await
            .workspace_sync
            .unwrap();
        assert_eq!((third.updated, third.deleted), (1, 1));
        let mut host = Host::open(
            &WorkspaceRef::device(&device.id, &third.destination),
            Some(&device),
            &config,
        )
        .await
        .unwrap();
        assert_eq!(
            read_blob(&mut host, "results.log", 1024)
                .await
                .unwrap()
                .unwrap(),
            b"xx"
        );
        assert!(host.stat("old.py").await.unwrap().is_none());
        drop(host);
        let mut change = crate::wsl::wsl_command().unwrap();
        change.args(["--distribution",&distribution,"--exec","python3","-I","-c","import os,sys; from pathlib import Path; assert all(p.startswith('/tmp/rr-incremental-test-') for p in sys.argv[1:]); Path(sys.argv[2]).write_text('outside'); os.unlink(sys.argv[1]); os.symlink(sys.argv[2],sys.argv[1])",&format!("{}/main.py",third.destination),&format!("{remote}/outside.py")]);
        assert!(change.status().await.unwrap().success());
        f.write("main.py", b"print('changed again')\n");
        let id = manager
            .start(req("python3 main.py"), device.clone(), config.clone(), None)
            .unwrap();
        state(&manager, &id, RunState::Failed).await;
        let mut repair = crate::wsl::wsl_command().unwrap();
        repair.args(["--distribution",&distribution,"--exec","python3","-I","-c","import os,sys; from pathlib import Path; assert all(p.startswith('/tmp/rr-incremental-test-') for p in sys.argv[1:]); assert Path(sys.argv[2]).read_text()=='outside'; assert os.path.islink(sys.argv[1]); os.unlink(sys.argv[1])",&format!("{}/main.py",third.destination),&format!("{remote}/outside.py")]);
        assert!(repair.status().await.unwrap().success());
        let running = manager
            .start(
                req("python3 -c 'import time; time.sleep(2)'"),
                device.clone(),
                config.clone(),
                None,
            )
            .unwrap();
        state(&manager, &running, RunState::Running).await;
        let queued = manager
            .start(req("python3 main.py"), device.clone(), config.clone(), None)
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while !manager.status(&queued).unwrap().waiting_workspace {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        manager.stop(&queued).unwrap();
        state(&manager, &queued, RunState::Canceled).await;
        state(&manager, &running, RunState::Exited).await;
        let mut cleanup = crate::wsl::wsl_command().unwrap();
        cleanup.args(["--distribution",&distribution,"--exec","python3","-I","-c","import shutil,sys; p=sys.argv[1]; assert p.startswith('/tmp/rr-incremental-test-'); shutil.rmtree(p)",&remote]);
        assert!(cleanup.status().await.unwrap().success());
    }
}
