//! Workspace launch intents and bounded, source-owned .runner metadata.
use crate::device::{DeviceProfile, DeviceStore};
use crate::file_transfer::host::Host;
use crate::workspace::{redirected, FileError};
use crate::workspace_ref::WorkspaceRef;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub type Result<T> = std::result::Result<T, FileError>;
pub const COMMAND_LIMIT: usize = 1024 * 1024;
const CONFIG_LIMIT: usize = 256 * 1024;
static WRITES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const LOCK: &str = ".runner/write.lock";

pub fn error(code: &'static str, message: impl Into<String>) -> FileError {
    FileError::new(code, message)
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn relative(path: &str, root: bool) -> Result<String> {
    if root && path == "." {
        return Ok(path.into());
    }
    let path = path.replace('\\', "/");
    if path.is_empty()
        || path.len() > 1024
        || path.starts_with('/')
        || path.contains(':')
        || path.chars().any(char::is_control)
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return Err(error(
            "path",
            "Expected a relative path inside the workspace",
        ));
    }
    Ok(path)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Entry {
    BashScript { path: String },
    PythonScript { path: String },
    PythonModule { name: String },
}
impl Entry {
    pub fn value(&self) -> &str {
        match self {
            Self::BashScript { path } | Self::PythonScript { path } => path,
            Self::PythonModule { name } => name,
        }
    }
    pub fn python(&self) -> bool {
        !matches!(self, Self::BashScript { .. })
    }
    pub fn module(&self) -> bool {
        matches!(self, Self::PythonModule { .. })
    }
    fn kind(&self) -> &str {
        match self {
            Self::BashScript { .. } => "bash_script",
            Self::PythonScript { .. } => "python_script",
            Self::PythonModule { .. } => "python_module",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub entry: Entry,
    #[serde(default)]
    pub args: Vec<String>,
}
impl Command {
    pub fn validate(&mut self) -> Result<()> {
        match &mut self.entry {
            Entry::BashScript { path } | Entry::PythonScript { path } => {
                *path = relative(path, false)?
            }
            Entry::PythonModule { name } => {
                if name.is_empty()
                    || name.len() > 1024
                    || !name.split('.').all(|p| {
                        let mut chars = p.chars();
                        chars
                            .next()
                            .is_some_and(|c| c == '_' || c.is_ascii_alphabetic())
                            && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
                    })
                {
                    return Err(error("invalid", "Invalid Python module name"));
                }
            }
        }
        if self.args.iter().any(|a| a.contains('\0'))
            || serde_json::to_vec(self).map_err(json_error)?.len() > 60 * 1024
        {
            return Err(error(
                "too_large",
                "Arguments contain NUL or the command exceeds 60 KiB",
            ));
        }
        Ok(())
    }
    pub fn id(&self) -> String {
        digest(
            &serde_json::to_vec(&(
                "runner-command-v1",
                self.entry.kind(),
                self.entry.value(),
                &self.args,
            ))
            .expect("string tuple"),
        )
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub r#type: String,
    pub path: String,
}
impl Source {
    pub(crate) fn validate(&mut self) -> Result<()> {
        if !matches!(self.r#type.as_str(), "file" | "dir") {
            return Err(error("invalid", "Invalid command source"));
        }
        self.path = relative(&self.path, false)?;
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize)]
pub struct Record {
    pub id: String,
    #[serde(flatten)]
    pub command: Command,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sources: Vec<Source>,
    pub last_used_at: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub needs_edit: bool,
}
fn is_false(value: &bool) -> bool {
    !*value
}
impl<'de> Deserialize<'de> for Record {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Fields {
            id: String,
            entry: Entry,
            #[serde(default)]
            args: Vec<String>,
            #[serde(default)]
            sources: Vec<Source>,
            last_used_at: String,
            #[serde(default)]
            needs_edit: bool,
        }
        let f = Fields::deserialize(deserializer)?;
        Ok(Self {
            id: f.id,
            command: Command {
                entry: f.entry,
                args: f.args,
            },
            sources: f.sources,
            last_used_at: f.last_used_at,
            needs_edit: f.needs_edit,
        })
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct History {
    schema: u32,
    entries: Vec<Record>,
}
impl History {
    fn empty() -> Self {
        Self {
            schema: 1,
            entries: vec![],
        }
    }
    fn normalize(&mut self) -> Result<()> {
        if self.schema != 1 {
            return Err(error("schema", "Unsupported command history schema"));
        }
        let mut unique: BTreeMap<String, Record> = BTreeMap::new();
        for mut record in self.entries.drain(..) {
            record.command.validate()?;
            chrono::DateTime::parse_from_rfc3339(&record.last_used_at)
                .map_err(|_| error("invalid", "Invalid command timestamp"))?;
            record.id = record.command.id();
            for source in &mut record.sources {
                source.validate()?;
            }
            record
                .sources
                .sort_by(|a, b| (&a.r#type, &a.path).cmp(&(&b.r#type, &b.path)));
            record.sources.dedup();
            if let Some(old) = unique.get_mut(&record.id) {
                merge(old, record);
            } else {
                unique.insert(record.id.clone(), record);
            }
        }
        self.entries = unique.into_values().collect();
        self.sort();
        Ok(())
    }
    fn sort(&mut self) {
        self.entries.sort_by(|a, b| {
            time(&b.last_used_at)
                .cmp(&time(&a.last_used_at))
                .then(a.id.cmp(&b.id))
        });
    }
    fn bounded(&mut self, keep: Option<&str>) -> Result<Vec<u8>> {
        self.sort();
        loop {
            let bytes = serde_json::to_vec_pretty(self).map_err(json_error)?;
            if bytes.len() <= COMMAND_LIMIT && self.entries.len() <= 200 {
                return Ok(bytes);
            }
            match self
                .entries
                .iter()
                .rposition(|r| Some(r.id.as_str()) != keep)
            {
                Some(index) => {
                    self.entries.remove(index);
                }
                None => {
                    return Err(error(
                        "too_large",
                        "Command record exceeds 1 MiB; history was not saved",
                    ))
                }
            }
        }
    }
}
fn time(s: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|t| t.timestamp_millis())
        .unwrap_or(0)
}
fn merge(old: &mut Record, new: Record) {
    old.needs_edit |= new.needs_edit;
    if time(&new.last_used_at) > time(&old.last_used_at) {
        old.last_used_at = new.last_used_at;
    }
    for source in new.sources {
        if !old.sources.contains(&source) {
            old.sources.push(source);
        }
    }
    old.sources
        .sort_by(|a, b| (&a.r#type, &a.path).cmp(&(&b.r#type, &b.path)));
}
fn json_error(e: serde_json::Error) -> FileError {
    error("invalid", format!("Invalid runner state: {e}"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Defaults {
    pub cwd: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub schema: u32,
    pub run_defaults: Defaults,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            schema: 1,
            run_defaults: Defaults { cwd: ".".into() },
        }
    }
}
impl Config {
    fn validate(&mut self) -> Result<()> {
        if self.schema != 1 {
            return Err(error("schema", "Unsupported runner config schema"));
        }
        self.run_defaults.cwd = relative(&self.run_defaults.cwd, true)?;
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize)]
pub struct ConfigState {
    pub config: Config,
    pub revision: String,
}
#[derive(Debug, Clone, Serialize)]
pub struct Commands {
    pub entries: Vec<Record>,
    pub revision: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Python {
    DeviceDefault,
    Project,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    #[default]
    Run,
    Prepare,
    Rebuild,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub cwd: String,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub console_mode: crate::process::ConsoleMode,
    pub timeout_secs: u64,
    #[serde(default = "cols")]
    pub cols: u32,
    #[serde(default = "rows")]
    pub rows: u32,
    #[serde(default)]
    pub bash: Option<String>,
}
fn cols() -> u32 {
    80
}
fn rows() -> u32 {
    24
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    #[serde(default)]
    pub config_revision: Option<String>,
    #[serde(default)]
    pub operation: Operation,
    pub workspace: WorkspaceRef,
    pub device_id: String,
    pub device_revision: String,
    pub command: Command,
    pub python: Python,
    pub settings: Settings,
    #[serde(default)]
    pub source: Option<Source>,
}
#[derive(Debug, Clone)]
pub struct Context {
    pub request: Request,
    pub source_device: Option<DeviceProfile>,
    pub config_dir: PathBuf,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Launch {
    pub program: String,
    pub version: Option<String>,
    pub cwd: String,
    pub python_path: Vec<String>,
    pub environment: String,
}

pub fn device_revision(device: &DeviceProfile) -> String {
    digest(&serde_json::to_vec(device).expect("device serializable"))
}
pub fn source_device(
    workspace: &WorkspaceRef,
    store: &DeviceStore,
) -> Result<Option<DeviceProfile>> {
    match workspace.device_ref() {
        Some((id, path)) => {
            crate::workspace_ref::validate_device_path(path).map_err(|m| error("path", m))?;
            let device = store.get(id).map_err(|e| error("device", e.to_string()))?;
            if !crate::workspace_ref::host_supported(device.transport) {
                return Err(error("unsupported", "Workspace host requires SSH or WSL"));
            }
            Ok(Some(device))
        }
        None => Ok(None),
    }
}

pub struct Store {
    pub(crate) host: Host,
}
impl Store {
    pub async fn open(
        workspace: &WorkspaceRef,
        source: Option<&DeviceProfile>,
        config: &Path,
    ) -> Result<Self> {
        Self::open_with_ssh(workspace, source, config, None).await
    }

    pub(crate) async fn open_with_ssh(
        workspace: &WorkspaceRef,
        source: Option<&DeviceProfile>,
        config: &Path,
        connection: Option<crate::ssh::client::SshConnection>,
    ) -> Result<Self> {
        if let Some((_, path)) = workspace.device_ref() {
            crate::workspace_ref::validate_device_path(path).map_err(|m| error("path", m))?;
        }
        Ok(Self {
            host: match connection {
                Some(connection) => {
                    Host::from_ssh(
                        connection,
                        workspace
                            .device_ref()
                            .ok_or_else(|| error("path", "Expected SSH workspace"))?
                            .1,
                    )
                    .await?
                }
                None => Host::open(workspace, source, config).await?,
            },
        })
    }
    pub async fn read(&mut self, path: &str, limit: usize) -> Result<Option<Vec<u8>>> {
        let Some(attrs) = self.host.stat(path).await? else {
            return Ok(None);
        };
        if attrs.kind != "file" || attrs.size > limit as u64 {
            return Err(error(
                "too_large",
                format!("{path}: expected a regular file at most {limit} bytes"),
            ));
        }
        let (mut handle, opened) = self.host.open_read(path).await?;
        let result = async {
            if opened != attrs {
                return Err(error("conflict", "File changed while opening"));
            }
            let mut bytes = Vec::new();
            loop {
                let chunk = self.host.read(&mut handle, bytes.len() as u64).await?;
                if chunk.is_empty() {
                    break;
                }
                if bytes.len() + chunk.len() > limit {
                    return Err(error("too_large", format!("{path} exceeds {limit} bytes")));
                }
                bytes.extend(chunk);
            }
            if self.host.stat(path).await? != Some(attrs) {
                return Err(error("conflict", "File changed while reading"));
            }
            Ok(Some(bytes))
        }
        .await;
        let close = self.host.close(handle, false, None).await;
        let bytes = result?;
        close?;
        Ok(bytes)
    }
    async fn blob(&mut self, name: &str, limit: usize) -> Result<(Option<Vec<u8>>, String)> {
        let data = self.read(name, limit).await?;
        let revision = data
            .as_ref()
            .map(|b| digest(b))
            .unwrap_or_else(|| "missing".into());
        Ok((data, revision))
    }
    pub async fn config(&mut self) -> Result<ConfigState> {
        let (bytes, revision) = self.blob(".runner/config.json", CONFIG_LIMIT).await?;
        let mut config = match bytes {
            Some(b) => serde_json::from_slice(&b).map_err(json_error)?,
            None => Config::default(),
        };
        config.validate()?;
        Ok(ConfigState { config, revision })
    }
    pub async fn commands(&mut self) -> Result<Commands> {
        let (bytes, revision) = self.blob(".runner/commands.json", COMMAND_LIMIT).await?;
        let mut history = match bytes {
            Some(b) => serde_json::from_slice(&b).map_err(json_error)?,
            None => History::empty(),
        };
        history.normalize()?;
        Ok(Commands {
            entries: history.entries,
            revision,
        })
    }
    async fn publish(&mut self, path: &str, bytes: Vec<u8>, revision: &str) -> Result<()> {
        let expected = self.host.stat(path).await?;
        let limit = if path.ends_with("config.json") {
            CONFIG_LIMIT
        } else {
            COMMAND_LIMIT
        };
        if self.blob(path, limit).await?.1 != revision || self.host.stat(path).await? != expected {
            return Err(error("conflict", "Runner state changed before publication"));
        }
        if expected.is_some() && !self.host.overwrite() {
            return Err(error(
                "unsupported",
                "SFTP server does not support atomic replacement",
            ));
        }
        let temp = format!(".runner/state-{}.tmp", uuid::Uuid::new_v4());
        let result = async {
            let mut handle = self.host.create_temp(&temp).await?;
            let mut offset = 0;
            for chunk in bytes.chunks(crate::file_transfer::CHUNK) {
                if let Err(e) = self.host.write(&mut handle, offset, chunk.to_vec()).await {
                    let _ = self.host.close(handle, false, None).await;
                    return Err(e);
                }
                offset += chunk.len() as u64;
            }
            self.host.close(handle, true, Some(0o600)).await?;
            self.host
                .commit(&temp, path, expected.is_some(), &expected)
                .await
        }
        .await;
        if result.is_err() {
            let _ = self.host.remove_temp(&temp).await;
        }
        result
    }
    async fn lock(&mut self) -> Result<Vec<u8>> {
        self.host.mkdir(".runner").await?;
        let owner = serde_json::to_vec(&serde_json::json!({"owner":uuid::Uuid::new_v4().to_string(),"created_at":chrono::Utc::now().to_rfc3339()})).map_err(json_error)?;
        for round in 0..3 {
            match self.host.create_temp(LOCK).await {
                Ok(mut handle) => {
                    let written = self.host.write(&mut handle, 0, owner.clone()).await;
                    let closed = self.host.close(handle, true, Some(0o600)).await;
                    if let Err(e) = written.and(closed) {
                        let _ = self.host.remove_temp(LOCK).await;
                        return Err(e);
                    }
                    return Ok(owner);
                }
                Err(e) if matches!(e.code, "exists" | "conflict") && round < 2 => {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await
                }
                Err(e) => {
                    return Err(error(
                        e.code,
                        format!(
                            "Runner state write lock unavailable; inspect/recover {LOCK}: {}",
                            e.message
                        ),
                    ))
                }
            }
        }
        Err(error("busy", "Runner state is busy"))
    }
    async fn unlock(&mut self, owner: &[u8]) {
        if self.read(LOCK, 4096).await.ok().flatten().as_deref() == Some(owner) {
            let _ = self.host.remove_temp(LOCK).await;
        }
    }
    pub async fn recover_lock(&mut self, expected: &str) -> Result<()> {
        let _guard = WRITES.lock().await;
        let bytes = self
            .read(LOCK, 4096)
            .await?
            .ok_or_else(|| error("not_found", "No runner write lock"))?;
        if digest(&bytes) != expected {
            return Err(error("conflict", "Runner write lock changed"));
        }
        self.host.remove_temp(LOCK).await
    }
    pub async fn lock_info(&mut self) -> Result<Option<serde_json::Value>> {
        Ok(self.read(LOCK, 4096).await?.map(|bytes| serde_json::json!({"content":String::from_utf8_lossy(&bytes),"revision":digest(&bytes)})))
    }
    pub async fn save_config(&mut self, mut config: Config, expected: &str) -> Result<ConfigState> {
        config.validate()?;
        let bytes = serde_json::to_vec_pretty(&config).map_err(json_error)?;
        if bytes.len() > CONFIG_LIMIT {
            return Err(error("too_large", "Runner config exceeds 256 KiB"));
        }
        let _guard = WRITES.lock().await;
        let owner = self.lock().await?;
        let result = async {
            if self.config().await?.revision != expected {
                return Err(error(
                    "conflict",
                    "Runner config changed; refresh before saving",
                ));
            }
            self.publish(".runner/config.json", bytes, expected).await?;
            self.config().await
        }
        .await;
        self.unlock(&owner).await;
        result
    }
    pub async fn remember(
        &mut self,
        mut command: Command,
        mut source: Option<Source>,
    ) -> Result<Commands> {
        command.validate()?;
        if let Some(s) = source.as_mut() {
            s.validate()?;
        }
        let id = command.id();
        let _guard = WRITES.lock().await;
        let owner = self.lock().await?;
        let result = async {
            let commands = self.commands().await?;
            let mut history = History {
                schema: 1,
                entries: commands.entries,
            };
            let record = Record {
                id: id.clone(),
                command,
                sources: source.into_iter().collect(),
                last_used_at: chrono::Utc::now().to_rfc3339(),
                needs_edit: false,
            };
            match history.entries.iter_mut().find(|r| r.id == id) {
                Some(old) => merge(old, record),
                None => history.entries.push(record),
            }
            let bytes = history.bounded(Some(&id))?;
            self.publish(".runner/commands.json", bytes, &commands.revision)
                .await?;
            self.commands().await
        }
        .await;
        self.unlock(&owner).await;
        result
    }
    pub async fn delete(&mut self, id: &str, expected: &str) -> Result<Commands> {
        let _guard = WRITES.lock().await;
        let owner = self.lock().await?;
        let result = async {
            let commands = self.commands().await?;
            if commands.revision != expected {
                return Err(error(
                    "conflict",
                    "Command history changed; refresh before deleting",
                ));
            }
            let mut history = History {
                schema: 1,
                entries: commands.entries,
            };
            history.entries.retain(|r| r.id != id);
            let bytes = history.bounded(None)?;
            self.publish(".runner/commands.json", bytes, &commands.revision)
                .await?;
            self.commands().await
        }
        .await;
        self.unlock(&owner).await;
        result
    }
    pub async fn edit_entry(
        &mut self,
        id: &str,
        mut entry: Entry,
        expected: &str,
    ) -> Result<Commands> {
        let mut test = Command {
            entry: entry.clone(),
            args: vec![],
        };
        test.validate()?;
        entry = test.entry;
        let _guard = WRITES.lock().await;
        let owner = self.lock().await?;
        let result = async {
            let current = self.commands().await?;
            if current.revision != expected {
                return Err(error(
                    "conflict",
                    "Command history changed; refresh before editing",
                ));
            }
            let mut history = History {
                schema: 1,
                entries: current.entries,
            };
            let record = history
                .entries
                .iter_mut()
                .find(|r| r.id == id)
                .ok_or_else(|| error("not_found", "Command no longer exists"))?;
            record.command.entry = entry;
            record.command.validate()?;
            let keep = record.command.id();
            history.normalize()?;
            if let Some(record) = history.entries.iter_mut().find(|r| r.id == keep) {
                record.needs_edit = false;
            }
            let bytes = history.bounded(Some(&keep))?;
            self.publish(".runner/commands.json", bytes, &current.revision)
                .await?;
            self.commands().await
        }
        .await;
        self.unlock(&owner).await;
        result
    }
    pub async fn rename_commands(&mut self, old: &str, new: &str) -> Result<Commands> {
        let old = relative(old, false)?;
        let new = relative(new, false)?;
        let original = self.commands().await?;
        if original.revision == "missing" {
            return Ok(original);
        }
        let mut roots = vec![self.config().await?.config.run_defaults.cwd];
        if let Some(bytes) = self.read("pyproject.toml", 1024 * 1024).await? {
            let value: toml::Value = String::from_utf8_lossy(&bytes)
                .parse()
                .map_err(|e| error("invalid", format!("Invalid pyproject.toml: {e}")))?;
            if let Some(paths) = value
                .get("tool")
                .and_then(|v| v.get("remote-runner"))
                .and_then(|v| v.get("python-path"))
                .and_then(|v| v.as_array())
            {
                for path in paths {
                    roots.push(relative(
                        path.as_str()
                            .ok_or_else(|| error("invalid", "Invalid python-path"))?,
                        false,
                    )?);
                }
            }
        }
        let replace = |path: &str| {
            if path == old {
                new.clone()
            } else if let Some(suffix) = path.strip_prefix(&format!("{old}/")) {
                format!("{new}/{suffix}")
            } else {
                path.into()
            }
        };
        let _guard = WRITES.lock().await;
        let owner = self.lock().await?;
        let result = async {
            let current = self.commands().await?;
            let mut history = History {
                schema: 1,
                entries: current.entries,
            };
            for record in &mut history.entries {
                match &mut record.command.entry {
                    Entry::BashScript { path } | Entry::PythonScript { path } => {
                        *path = replace(path)
                    }
                    Entry::PythonModule { name } => {
                        let mut replacements = std::collections::BTreeSet::new();
                        let affected = record.sources.iter().any(|s| replace(&s.path) != s.path);
                        let mut uncertain = false;
                        for source in &record.sources {
                            let changed = replace(&source.path);
                            let before = roots
                                .iter()
                                .filter_map(|root| infer_module(&source.path, &source.r#type, root))
                                .collect::<std::collections::BTreeSet<_>>();
                            let after = roots
                                .iter()
                                .filter_map(|root| infer_module(&changed, &source.r#type, root))
                                .collect::<std::collections::BTreeSet<_>>();
                            if before.len() != 1
                                || !before.contains(name.as_str())
                                || after.len() != 1
                            {
                                uncertain = true;
                            }
                            replacements.extend(after);
                        }
                        if affected && !uncertain && replacements.len() == 1 {
                            *name = replacements.into_iter().next().unwrap();
                            record.needs_edit = false;
                        } else if affected {
                            record.needs_edit = true;
                        }
                    }
                }
                for source in &mut record.sources {
                    source.path = replace(&source.path);
                }
            }
            history.normalize()?;
            let bytes = history.bounded(None)?;
            self.publish(".runner/commands.json", bytes, &current.revision)
                .await?;
            self.commands().await
        }
        .await;
        self.unlock(&owner).await;
        result
    }
}

fn infer_module(path: &str, kind: &str, root: &str) -> Option<String> {
    let path = if root == "." {
        path
    } else {
        path.strip_prefix(&format!("{root}/"))?
    };
    let path = if kind == "file" {
        path.strip_suffix(".py")?
    } else {
        path
    };
    let path = path
        .strip_suffix("/__main__")
        .or_else(|| path.strip_suffix("/__init__"))
        .unwrap_or(path);
    let name = path.replace('/', ".");
    let mut command = Command {
        entry: Entry::PythonModule { name: name.clone() },
        args: vec![],
    };
    command.validate().ok()?;
    Some(name)
}

#[derive(Debug, Clone)]
pub struct Inputs {
    pub project: Option<crate::runtime::project::PythonProject>,
    pub python_path: Vec<String>,
    pub hashes: Vec<(String, String)>,
    /// Serial uploads normalize text to LF. Keep the planned upload digest
    /// separate from the raw source digest used by other transports.
    pub serial_hashes: Vec<(String, String)>,
}

pub fn input_verifier(
    device: &DeviceProfile,
    config: &Path,
    root: &str,
    hashes: Vec<(String, String)>,
) -> Box<crate::runtime::prepare::InputVerifier> {
    input_verifier_with_ssh(device, config, root, hashes, None)
}

pub(crate) fn input_verifier_with_ssh(
    device: &DeviceProfile,
    config: &Path,
    root: &str,
    hashes: Vec<(String, String)>,
    connection: Option<crate::ssh::client::SshConnection>,
) -> Box<crate::runtime::prepare::InputVerifier> {
    let endpoint = if device.transport == crate::device::TransportKind::Local {
        WorkspaceRef::local(root)
    } else {
        WorkspaceRef::device(&device.id, root)
    };
    let device = device.clone();
    let config = config.to_path_buf();
    Box::new(move || {
        let connection = connection.clone();
        let (endpoint, device, config, hashes) = (
            endpoint.clone(),
            device.clone(),
            config.clone(),
            hashes.clone(),
        );
        Box::pin(async move {
            let mut store = Store::open_with_ssh(&endpoint, Some(&device), &config, connection)
                .await
                .map_err(|e| crate::error::RunnerError::InvalidInput(e.to_string()))?;
            store
                .verify(&Inputs {
                    project: None,
                    python_path: vec![],
                    hashes,
                    serial_hashes: vec![],
                })
                .await
                .map_err(|e| {
                    crate::error::RunnerError::InvalidInput(format!(
                        "{e}; verification target={} ({:?}), workspace={root:?}",
                        device.name,
                        device.transport,
                        root = endpoint
                            .local_dir()
                            .or_else(|| endpoint.device_ref().map(|(_, path)| path))
                            .unwrap_or_default(),
                    ))
                })
        })
    })
}
#[derive(Debug, Clone, Serialize)]
pub struct ProjectInfo {
    pub python_version: Option<String>,
    pub python_path: Vec<String>,
    pub project: Option<crate::runtime::project::PythonProject>,
    pub legacy_entry: Option<String>,
    pub legacy_module: bool,
}
impl Store {
    pub async fn check_entry(&mut self, path: &str, directory: bool) -> Result<()> {
        let path = relative(path, directory)?;
        let attrs = self
            .host
            .stat(if path == "." { "" } else { &path })
            .await?
            .ok_or_else(|| error("not_found", format!("Missing workspace entry: {path}")))?;
        if attrs.kind != if directory { "dir" } else { "file" } {
            return Err(error("path", format!("Unexpected entry type: {path}")));
        }
        Ok(())
    }
    pub async fn inputs(&mut self, entry: &Entry, managed: bool, cwd: &str) -> Result<Inputs> {
        self.check_entry(cwd, true).await?;
        if !entry.module() {
            self.check_entry(entry.value(), false).await?;
        }
        if !entry.python() {
            return Ok(Inputs {
                project: None,
                python_path: vec![],
                hashes: vec![],
                serial_hashes: vec![],
            });
        }
        let pyproject = self.read("pyproject.toml", 1024 * 1024).await?;
        let text = pyproject
            .as_deref()
            .map(|b| {
                std::str::from_utf8(b).map_err(|_| error("invalid", "pyproject.toml must be UTF-8"))
            })
            .transpose()?;
        let mut python_path = Vec::new();
        if let Some(text) = text {
            let toml: toml::Value = text
                .parse()
                .map_err(|e| error("invalid", format!("Invalid pyproject.toml: {e}")))?;
            if let Some(value) = toml
                .get("tool")
                .and_then(|v| v.get("remote-runner"))
                .and_then(|v| v.get("python-path"))
            {
                for path in value
                    .as_array()
                    .ok_or_else(|| error("invalid", "python-path must be an array"))?
                {
                    let path = relative(
                        path.as_str()
                            .ok_or_else(|| error("invalid", "python-path must contain strings"))?,
                        false,
                    )?;
                    self.check_entry(&path, true).await?;
                    python_path.push(path);
                }
            }
        }
        let serial_hashes = vec![(
            "pyproject.toml".into(),
            pyproject
                .as_ref()
                .map(|bytes| digest(&crate::workspace_upload::normalize_lf(bytes.clone())))
                .unwrap_or_else(|| "missing".into()),
        )];
        let mut hashes = vec![(
            "pyproject.toml".into(),
            pyproject
                .as_deref()
                .map(digest)
                .unwrap_or_else(|| "missing".into()),
        )];
        let project = if managed {
            let text = text.ok_or_else(|| error("not_found", "pyproject.toml is required"))?;
            let version = self
                .read(".python-version", 4096)
                .await?
                .ok_or_else(|| error("not_found", ".python-version is required"))?;
            let lock = self
                .read("uv.lock", crate::runtime::LOCK_LIMIT)
                .await?
                .ok_or_else(|| error("not_found", "uv.lock is required"))?;
            let project = crate::runtime::project::parse_inputs(
                PathBuf::new(),
                text,
                std::str::from_utf8(&version)
                    .map_err(|_| error("invalid", "Invalid .python-version"))?,
                &lock,
                Some((entry.value(), entry.module())),
            )
            .map_err(|e| error("invalid", e.to_string()))?;
            hashes.extend([
                (".python-version".into(), digest(&version)),
                ("uv.lock".into(), digest(&lock)),
            ]);
            Some(project)
        } else {
            None
        };
        Ok(Inputs {
            project,
            python_path,
            hashes,
            serial_hashes,
        })
    }
    pub async fn project_info(&mut self, managed: bool) -> Result<ProjectInfo> {
        let bytes = self.read("pyproject.toml", 1024 * 1024).await?;
        let value = bytes
            .as_deref()
            .map(|b| {
                std::str::from_utf8(b)
                    .map_err(|_| error("invalid", "Invalid pyproject.toml"))?
                    .parse::<toml::Value>()
                    .map_err(|e| error("invalid", e.to_string()))
            })
            .transpose()?;
        let rr = value
            .as_ref()
            .and_then(|v| v.get("tool"))
            .and_then(|v| v.get("remote-runner"));
        let legacy_entry = rr
            .and_then(|v| v.get("entry"))
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let legacy_module =
            rr.and_then(|v| v.get("mode")).and_then(|v| v.as_str()) == Some("module");
        // A module placeholder lets project inspection avoid choosing a script.
        let inputs = self
            .inputs(
                &Entry::PythonModule {
                    name: "__runner_inspect__".into(),
                },
                managed,
                ".",
            )
            .await?;
        let version = self
            .read(".python-version", 4096)
            .await?
            .map(|b| String::from_utf8_lossy(&b).trim().to_string());
        Ok(ProjectInfo {
            python_version: version,
            python_path: inputs.python_path,
            project: inputs.project,
            legacy_entry,
            legacy_module,
        })
    }
    pub async fn verify(&mut self, inputs: &Inputs) -> Result<()> {
        for (path, expected) in &inputs.hashes {
            let limit = if path == "uv.lock" {
                crate::runtime::LOCK_LIMIT
            } else {
                1024 * 1024
            };
            let bytes = self.read(path, limit).await?;
            let actual = bytes
                .as_deref()
                .map(digest)
                .unwrap_or_else(|| "missing".into());
            if &actual != expected {
                return Err(error(
                    "conflict",
                    format!("Project input changed: {path}; run again (expected SHA-256={expected}, actual SHA-256={actual}, actual bytes={})", bytes.as_ref().map_or(0, Vec::len)),
                ));
            }
        }
        Ok(())
    }
}

/// Validate local descendants separately from canonicalizing a root. Never follow
/// interpreter symlinks through this source-file API.
pub fn checked_local(root: &Path, path: &str, directory: bool) -> Result<PathBuf> {
    let rel = relative(path, directory)?;
    let mut target = root.to_path_buf();
    if rel != "." {
        for part in rel.split('/') {
            target.push(part);
            if redirected(&std::fs::symlink_metadata(&target)?) {
                return Err(error("path", "Workspace links are not allowed"));
            }
        }
    }
    let meta = std::fs::symlink_metadata(&target)?;
    if redirected(&meta)
        || (if directory {
            !meta.is_dir()
        } else {
            !meta.is_file()
        })
    {
        return Err(error("path", "Unexpected workspace entry type"));
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn command(args: &[&str]) -> Command {
        Command {
            entry: Entry::PythonScript {
                path: "tools/train.py".into(),
            },
            args: args.iter().map(|s| s.to_string()).collect(),
        }
    }
    #[test]
    fn stable_ids_preserve_argument_boundaries() {
        assert_eq!(
            command(&["--epochs", "10", "--name", "trial one"]).id(),
            "46b30296bf66927a082124c9f71b76c2f05ab988fdb66c24efb4b3c422ca3902"
        );
        assert_ne!(command(&["a b"]).id(), command(&["a", "b"]).id());
        assert_ne!(command(&[]).id(), command(&[""]).id());
        assert!(relative("../x", false).is_err());
        assert_eq!(
            Command {
                entry: Entry::PythonModule {
                    name: "app.cli".into()
                },
                args: vec!["--help".into()]
            }
            .id(),
            "b3b64fedf23966a44e7b011efcd20e5b595ef7789945b4671f96edb2095a2ebe"
        );
    }
    #[test]
    fn history_merges_legacy_ids_and_evicts_by_serialized_bytes() {
        let record = |args: Vec<String>, date: &str| Record {
            id: "uuid".into(),
            command: Command {
                entry: Entry::PythonModule {
                    name: "app.cli".into(),
                },
                args,
            },
            sources: vec![],
            last_used_at: date.into(),
            needs_edit: false,
        };
        let mut history = History {
            schema: 1,
            entries: vec![
                record(vec![], "2026-10-17T01:00:00Z"),
                record(vec![], "2026-10-17T02:00:00Z"),
            ],
        };
        history.normalize().unwrap();
        assert_eq!(history.entries.len(), 1);
        for n in 0..30 {
            history.entries.push(record(
                vec![n.to_string(), "汉\"".repeat(9000)],
                "2026-10-17T01:00:00Z",
            ));
        }
        history.normalize().unwrap();
        let keep = history.entries[0].id.clone();
        let bytes = history.bounded(Some(&keep)).unwrap();
        assert!(bytes.len() <= COMMAND_LIMIT);
        assert!(history.entries.len() < 30);
        assert!(history.entries.iter().any(|r| r.id == keep));
    }
    #[tokio::test]
    async fn local_store_keeps_commands_unique_and_rejects_stale_deletes() {
        let dir = std::env::temp_dir().join(format!("rr-state-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let workspace = WorkspaceRef::local(dir.to_string_lossy());
        let mut store = Store::open(&workspace, None, &dir).await.unwrap();
        assert!(!dir.join(".runner").exists());
        store.remember(command(&["a b"]), None).await.unwrap();
        let old = store.commands().await.unwrap();
        store.remember(command(&["a b"]), None).await.unwrap();
        assert_eq!(store.commands().await.unwrap().entries.len(), 1);
        assert!(store.delete(&old.entries[0].id, "stale").await.is_err());
        let state = store.commands().await.unwrap();
        store
            .delete(&state.entries[0].id, &state.revision)
            .await
            .unwrap();
        assert!(store.commands().await.unwrap().entries.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn binary_transports_preserve_planned_crlf_inputs_and_reject_actual_changes() {
        let dir = std::env::temp_dir().join(format!("rr-crlf-inputs-{}", uuid::Uuid::new_v4()));
        let source = dir.join("source");
        let target = dir.join("target");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir(&target).unwrap();
        for (path, text) in [
            ("pyproject.toml", "[project]\r\nname='demo'\r\nrequires-python='>=3.12'\r\n[tool.remote-runner]\r\nentry='main.py'\r\n"),
            (".python-version", "3.12\r\n"), ("uv.lock", "version=1\r\n"), ("main.py", "pass\r\n"),
        ] {
            std::fs::write(source.join(path), text).unwrap();
        }
        let project = crate::runtime::project::inspect(&source).unwrap();
        let planned = Inputs {
            project: None,
            python_path: vec![],
            hashes: project.input_hashes,
            serial_hashes: vec![],
        };
        let workspace = WorkspaceRef::local(target.to_string_lossy());
        let mut store = Store::open(&workspace, None, &dir).await.unwrap();
        for policy in [crate::workspace_upload::SSH, crate::workspace_upload::WSL] {
            for file in crate::workspace_upload::collect(&source, policy).unwrap() {
                std::fs::write(target.join(file.path), file.data.unwrap()).unwrap();
            }
            store.verify(&planned).await.unwrap();
            assert_eq!(std::fs::read(target.join("main.py")).unwrap(), b"pass\n");
        }
        std::fs::write(source.join("pyproject.toml"), "# real edit\r\n").unwrap();
        for policy in [crate::workspace_upload::SSH, crate::workspace_upload::WSL] {
            for file in crate::workspace_upload::collect(&source, policy).unwrap() {
                std::fs::write(target.join(file.path), file.data.unwrap()).unwrap();
            }
            let error = store.verify(&planned).await.unwrap_err().to_string();
            assert!(error.contains("pyproject.toml"), "{error}");
            assert!(error.contains("expected SHA-256="), "{error}");
            assert!(error.contains("actual SHA-256="), "{error}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn project_verifier_reopens_and_checks_every_exact_input() {
        let dir = std::env::temp_dir().join(format!("rr-verify-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let files = [("pyproject.toml", "[project]\nname='demo'\nrequires-python='>=3.12'\n[tool.remote-runner]\nentry='main.py'\n"),
            (".python-version", "3.12.9\n"), ("uv.lock", "version=1\n")];
        for (path, contents) in files {
            std::fs::write(dir.join(path), contents).unwrap();
        }
        std::fs::write(dir.join("main.py"), "pass\n").unwrap();
        let project = crate::runtime::project::inspect(&dir).unwrap();
        let device: DeviceProfile = serde_json::from_value(serde_json::json!({"id":"test", "name":"local", "transport":"local", "local":{"shell":"bash"}})).unwrap();
        let verify = input_verifier(&device, &dir, dir.to_str().unwrap(), project.input_hashes);
        verify().await.unwrap();
        for (path, contents) in files {
            std::fs::write(dir.join(path), format!("{contents}# external change\n")).unwrap();
            let error = verify().await.unwrap_err().to_string();
            assert!(
                error.contains(path)
                    && error.contains("verification target=local (Local)")
                    && error.contains("workspace="),
                "{error}"
            );
            std::fs::write(dir.join(path), contents).unwrap();
            verify().await.unwrap();
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn concurrent_updates_merge_sources_and_entry_edits_coalesce_globally() {
        let dir = std::env::temp_dir().join(format!("rr-state-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let w = WorkspaceRef::local(dir.to_string_lossy());
        let mut a = Store::open(&w, None, &dir).await.unwrap();
        let mut b = Store::open(&w, None, &dir).await.unwrap();
        let module = Command {
            entry: Entry::PythonModule {
                name: "app.cli".into(),
            },
            args: vec!["--help".into()],
        };
        let (x, y) = tokio::join!(
            a.remember(
                module.clone(),
                Some(Source {
                    r#type: "file".into(),
                    path: "app/cli.py".into()
                })
            ),
            b.remember(
                module.clone(),
                Some(Source {
                    r#type: "dir".into(),
                    path: "app".into()
                })
            )
        );
        x.unwrap();
        y.unwrap();
        let h = a.commands().await.unwrap();
        assert_eq!(h.entries.len(), 1);
        assert_eq!(h.entries[0].sources.len(), 2);
        let other = Command {
            entry: Entry::PythonModule {
                name: "app.main".into(),
            },
            args: module.args.clone(),
        };
        a.remember(other.clone(), None).await.unwrap();
        let h = a.commands().await.unwrap();
        let h = a
            .edit_entry(&module.id(), other.entry, &h.revision)
            .await
            .unwrap();
        assert_eq!(h.entries.len(), 1);
        assert_eq!(h.entries[0].sources.len(), 2);
        assert_eq!(h.entries[0].command.entry.value(), "app.main");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn serial_input_hashes_match_uploaded_crlf_text_but_reject_changed_metadata() {
        let dir = std::env::temp_dir().join(format!("rr-serial-inputs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("main.py"), "print('ok')\r\n").unwrap();
        let metadata = "[tool.remote-runner]\r\npython-path=['src']\r\n";
        std::fs::write(dir.join("pyproject.toml"), metadata).unwrap();
        let w = WorkspaceRef::local(dir.to_string_lossy());
        let mut store = Store::open(&w, None, &dir).await.unwrap();
        let inputs = store
            .inputs(
                &Entry::PythonScript {
                    path: "main.py".into(),
                },
                false,
                ".",
            )
            .await
            .unwrap();
        store.verify(&inputs).await.unwrap();
        let upload_hash = || {
            crate::serial::filesync::collect(&dir)
                .unwrap()
                .into_iter()
                .find_map(|entry| match entry {
                    crate::serial::filesync::UploadEntry::File(file)
                        if file.relative == "pyproject.toml" =>
                    {
                        Some(digest(&file.data))
                    }
                    _ => None,
                })
                .unwrap()
        };
        assert_ne!(inputs.hashes[0].1, upload_hash());
        assert_eq!(inputs.serial_hashes[0].1, upload_hash());
        std::fs::write(
            dir.join("pyproject.toml"),
            metadata.replace("['src']", "['.']"),
        )
        .unwrap();
        assert_ne!(inputs.serial_hashes[0].1, upload_hash());
        assert!(store.verify(&inputs).await.is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn corrupt_oversized_and_unknown_state_is_preserved_and_locks_require_matching_owner() {
        let dir = std::env::temp_dir().join(format!("rr-state-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".runner")).unwrap();
        let w = WorkspaceRef::local(dir.to_string_lossy());
        let mut store = Store::open(&w, None, &dir).await.unwrap();
        for bytes in [
            b"{broken".to_vec(),
            vec![b' '; COMMAND_LIMIT + 1],
            br#"{"schema":99,"entries":[]}"#.to_vec(),
        ] {
            std::fs::write(dir.join(".runner/commands.json"), &bytes).unwrap();
            assert!(store.remember(command(&[]), None).await.is_err());
            assert_eq!(
                std::fs::read(dir.join(".runner/commands.json")).unwrap(),
                bytes
            );
        }
        std::fs::write(dir.join(".runner/write.lock"), b"owner").unwrap();
        assert!(store.recover_lock("wrong").await.is_err());
        assert!(store
            .save_config(Config::default(), "missing")
            .await
            .is_err());
        store.recover_lock(&digest(b"owner")).await.unwrap();
        let state = store
            .save_config(Config::default(), "missing")
            .await
            .unwrap();
        assert_ne!(state.revision, "missing");
        assert!(store
            .save_config(Config::default(), "missing")
            .await
            .is_err());
        std::fs::write(dir.join(".runner/unknown.txt"), b"keep").unwrap();
        store
            .save_config(Config::default(), &state.revision)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(dir.join(".runner/unknown.txt")).unwrap(),
            b"keep"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
