use crate::device::{DeviceProfile, TransportKind};
use crate::error::{Result, RunnerError};
use crate::process::{
    Capabilities, ConsoleMode, Outcome, OutputStream, RunState, SessionControl, SessionEvent,
};
use crate::runtime::catalog::RuntimeCatalog;
use crate::runtime::host::RuntimeHost;
use crate::runtime::manager::LeaseSet;
use crate::runtime::prepare::{self, NetworkConfig, PrepareEvents};
use crate::runtime::project::{EntryMode, PythonProject};
use crate::runtime::{code, PreparedEnvironment, RuntimePhase, RuntimeReady};
use crate::ssh::client::SshConnection;
use crate::ssh::filesync;
use crate::ssh::session::{self, SpawnSpec};
use crate::workspace_ref::WorkspaceRef;
use chrono::Local;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, mpsc};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScriptKind {
    Python,
    Shell,
    Command,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRequest {
    pub device_id: String,
    /// 工作区来源（00029；Command 类型可为空）。
    /// 兼容旧字段名 workspace_dir（裸字符串 = 本机目录）。
    #[serde(default, alias = "workspace_dir")]
    pub workspace: Option<WorkspaceRef>,
    pub kind: ScriptKind,
    /// python/shell 的入口文件（相对 workspace），command 类型忽略
    pub entry: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// command 类型的原始命令
    pub command: Option<String>,
    /// Managed Python Runtime（00027）：uv-only 项目模型，禁止系统 Python
    #[serde(default)]
    pub managed_python: bool,
    /// 准备阶段回填：环境内解释器路径（直接启动，不用 `uv run`）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_env_python: Option<String>,
    /// 准备阶段回填：加入 PYTHONPATH 的工作区内相对目录
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub managed_pythonpath: Vec<String>,
    /// 准备阶段回填：module 模式启动（entry 为模块名）
    #[serde(default, skip_serializing_if = "is_false")]
    pub managed_module: bool,
    #[serde(default = "default_console_mode")]
    pub console_mode: ConsoleMode,
    #[serde(default = "default_cols")]
    pub cols: u32,
    #[serde(default = "default_rows")]
    pub rows: u32,
    /// 超时（秒），0 = 不限
    #[serde(default)]
    pub timeout_secs: u64,
}

fn is_false(v: &bool) -> bool {
    !*v
}

fn default_console_mode() -> ConsoleMode {
    ConsoleMode::Pty
}
fn default_cols() -> u32 {
    80
}
fn default_rows() -> u32 {
    24
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunStatus {
    pub run_id: String,
    pub device_name: String,
    pub label: String,
    pub state: RunState,
    pub exit_code: Option<u32>,
    pub error: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    /// 已持久化的输出字节数（run_logs/<run_id>.log），0 表示没有可导出的输出
    #[serde(default)]
    pub output_bytes: u64,
    /// 输出超过 RUN_LOG_LIMIT 被截断时为 true
    #[serde(default)]
    pub output_truncated: bool,
    /// Managed Runtime 准备阶段（00027 §14）；无准备时为 None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    /// 运行可追溯信息（00027 §11）：环境 / uv / Python / lock
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uv_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub python_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock_sha256: Option<String>,
}

impl RunStatus {
    fn new(run_id: String, device_name: String, label: String) -> Self {
        Self {
            run_id,
            device_name,
            label,
            state: RunState::Preparing,
            exit_code: None,
            error: None,
            started_at: Local::now().to_rfc3339(),
            ended_at: None,
            output_bytes: 0,
            output_truncated: false,
            phase: None,
            environment_id: None,
            uv_version: None,
            python_version: None,
            lock_sha256: None,
        }
    }
}

/// 后端向前端（或 CLI）推送的运行事件
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RunEvent {
    Output {
        run_id: String,
        stream: String,
        /// base64 编码的原始字节
        data: String,
    },
    Status {
        status: RunStatus,
    },
    Resync {
        statuses: Vec<RunStatus>,
    },
    /// Managed Runtime 准备进度（00027 §14）；落后时字节级进度可丢弃
    RuntimeProgress {
        run_id: String,
        phase: String,
        message: String,
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopKind {
    User,
    Timeout,
}

struct RunHandle {
    _serial_lease: Option<crate::serial::transport::PortLease>,
    capabilities: Capabilities,
    control: mpsc::UnboundedSender<SessionControl>,
    stop_tx: mpsc::UnboundedSender<StopKind>,
    /// Managed Runtime 准备取消标志：stop() 置位，prepare exec 循环周期检查
    runtime_cancel: Arc<AtomicBool>,
    status: RunStatus,
    /// 已写入 run_logs/<run_id>.log 的字节数
    log_bytes: u64,
    /// 输出超过 RUN_LOG_LIMIT，日志只保留开头部分
    log_truncated: bool,
    /// 日志写入失败，放弃该 run 的后续落盘
    log_failed: bool,
}

#[derive(Clone)]
pub struct RunManager {
    handles: Arc<Mutex<HashMap<String, RunHandle>>>,
    history: Arc<Mutex<VecDeque<RunStatus>>>,
    history_path: PathBuf,
    logs_dir: PathBuf,
    event_tx: broadcast::Sender<RunEvent>,
    /// 活跃 Run 持有的 Environment lease（00027 §16），与 AppState 共享
    leases: Arc<LeaseSet>,
}

/// Run 存续期间持有 Environment lease；drop 时释放（含失败/取消路径）
struct EnvLeaseGuard {
    leases: Arc<LeaseSet>,
    id: String,
}

impl EnvLeaseGuard {
    fn new(leases: Arc<LeaseSet>, id: &str) -> Self {
        leases.lease(id);
        Self {
            leases,
            id: id.to_string(),
        }
    }
}

impl Drop for EnvLeaseGuard {
    fn drop(&mut self) {
        self.leases.release(&self.id);
    }
}

const HISTORY_LIMIT: usize = 200;
/// 单个 run 持久化输出日志的大小上限
const RUN_LOG_LIMIT: u64 = 2 * 1024 * 1024;

/// run_id 用于拼日志文件名，只允许安全字符，防止路径穿越
fn valid_run_id(run_id: &str) -> bool {
    !run_id.is_empty()
        && run_id.len() <= 64
        && run_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn log_path(logs_dir: &std::path::Path, run_id: &str) -> Option<PathBuf> {
    valid_run_id(run_id).then(|| logs_dir.join(format!("{run_id}.log")))
}

fn remove_log(logs_dir: &std::path::Path, run_id: &str) {
    if let Some(path) = log_path(logs_dir, run_id) {
        let _ = std::fs::remove_file(path);
    }
}

/// 删除不在历史中的孤儿日志文件（如崩溃残留）；只认 `<run_id>.log`，不递归
fn prune_orphan_logs(logs_dir: &std::path::Path, history: &VecDeque<RunStatus>) {
    let Ok(entries) = std::fs::read_dir(logs_dir) else {
        return;
    };
    let keep: std::collections::HashSet<&str> = history.iter().map(|h| h.run_id.as_str()).collect();
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|n| n.strip_suffix(".log")) else {
            continue;
        };
        if !valid_run_id(id) || !keep.contains(id) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}
/// 输出流中携带远程 PID 的标记
const PID_MARKER_PREFIX: &str = "__DEVRUNNER_PID_";
const PID_MARKER_SUFFIX: &str = "__";

impl RunManager {
    pub fn new(config_dir: &std::path::Path, event_tx: broadcast::Sender<RunEvent>) -> Self {
        let history_path = config_dir.join("history.json");
        let logs_dir = config_dir.join("run_logs");
        std::fs::create_dir_all(&logs_dir).ok();
        let mut history = std::fs::read_to_string(&history_path)
            .ok()
            .and_then(|s| serde_json::from_str::<VecDeque<RunStatus>>(&s).ok())
            .unwrap_or_default();
        // 超出上限的条目连同输出日志一起淘汰
        if history.len() > HISTORY_LIMIT {
            for old in history.drain(HISTORY_LIMIT..) {
                remove_log(&logs_dir, &old.run_id);
            }
        }
        prune_orphan_logs(&logs_dir, &history);
        Self {
            handles: Arc::new(Mutex::new(HashMap::new())),
            history: Arc::new(Mutex::new(history)),
            history_path,
            logs_dir,
            event_tx,
            leases: Arc::new(LeaseSet::default()),
        }
    }

    /// 与 AppState 共享同一个 LeaseSet（管理命令的删除/GC 据此保护活跃环境）
    pub fn attach_leases(&mut self, leases: Arc<LeaseSet>) {
        self.leases = leases;
    }

    pub fn subscribe_events(&self) -> broadcast::Receiver<RunEvent> {
        self.event_tx.subscribe()
    }

    pub fn snapshot(&self) -> Vec<RunStatus> {
        let handles = self.handles.lock();
        let history = self.history.lock();
        let mut statuses: Vec<_> = history.iter().cloned().collect();
        for handle in handles.values() {
            statuses.retain(|s| s.run_id != handle.status.run_id);
            statuses.push(handle.status.clone());
        }
        statuses
    }

    fn emit_output(&self, run_id: &str, stream: OutputStream, data: &[u8]) {
        self.append_log(run_id, data);
        use base64::Engine;
        for chunk in data.chunks(crate::events::OUTPUT_CHUNK) {
            let _ = self.event_tx.send(RunEvent::Output {
                run_id: run_id.into(),
                stream: match stream {
                    OutputStream::Stdout => "stdout",
                    OutputStream::Stderr => "stderr",
                }
                .into(),
                data: base64::engine::general_purpose::STANDARD.encode(chunk),
            });
        }
    }

    /// 把原始输出追加到 run_logs/<run_id>.log；超限截断、写失败放弃，均不影响运行
    fn append_log(&self, run_id: &str, data: &[u8]) {
        let mut handles = self.handles.lock();
        let Some(h) = handles.get_mut(run_id) else {
            return;
        };
        if h.log_failed || h.log_truncated {
            return;
        }
        let Some(path) = log_path(&self.logs_dir, run_id) else {
            return;
        };
        let remaining = (RUN_LOG_LIMIT - h.log_bytes) as usize;
        let slice = &data[..data.len().min(remaining)];
        let result = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .and_then(|mut f| std::io::Write::write_all(&mut f, slice));
        match result {
            Ok(()) => {
                h.log_bytes += slice.len() as u64;
                h.log_truncated = slice.len() < data.len();
            }
            Err(_) => h.log_failed = true,
        }
    }

    pub fn status(&self, run_id: &str) -> Option<RunStatus> {
        self.handles
            .lock()
            .get(run_id)
            .map(|h| h.status.clone())
            .or_else(|| {
                self.history
                    .lock()
                    .iter()
                    .find(|h| h.run_id == run_id)
                    .cloned()
            })
    }

    pub fn list_running(&self) -> Vec<RunStatus> {
        self.handles
            .lock()
            .values()
            .filter(|h| h.status.state.is_active())
            .map(|h| h.status.clone())
            .collect()
    }

    pub fn history(&self) -> Vec<RunStatus> {
        self.history.lock().iter().cloned().collect()
    }

    /// 清空历史：删除全部历史条目的输出日志并持久化空历史；运行中的任务不受影响
    pub fn clear_history(&self) -> Result<()> {
        {
            let mut hist = self.history.lock();
            for old in hist.iter() {
                remove_log(&self.logs_dir, &old.run_id);
            }
            hist.clear();
        }
        if let Some(parent) = self.history_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&self.history_path, "[]")?;
        Ok(())
    }

    /// 把某次运行持久化的输出日志原样复制到用户选择的路径
    pub fn export_output(&self, run_id: &str, path: &str) -> Result<()> {
        if path.trim().is_empty() {
            return Err(RunnerError::InvalidInput(
                "export path must not be empty".into(),
            ));
        }
        let src = log_path(&self.logs_dir, run_id)
            .ok_or_else(|| RunnerError::InvalidInput(format!("invalid run id: {run_id}")))?;
        if !src.is_file() {
            return Err(RunnerError::RunNotFound(format!(
                "no saved output for run {run_id}"
            )));
        }
        std::fs::copy(&src, path)?;
        Ok(())
    }

    pub fn send_input(&self, run_id: &str, data: Vec<u8>) -> Result<()> {
        if data.len() > 64 * 1024 {
            return Err(RunnerError::InvalidInput(
                "input must not exceed 64 KiB per request".into(),
            ));
        }
        if data == [3] {
            return self.stop(run_id);
        }
        self.control(run_id)?
            .send(SessionControl::Input(data))
            .map_err(|_| RunnerError::RunNotFound(run_id.to_string()))
    }

    pub fn resize(&self, run_id: &str, cols: u32, rows: u32) -> Result<()> {
        if cols == 0 || rows == 0 || cols > 4096 || rows > 4096 {
            return Err(RunnerError::InvalidInput(
                "console dimensions must be between 1 and 4096".into(),
            ));
        }
        if self
            .handles
            .lock()
            .get(run_id)
            .is_some_and(|h| !h.capabilities.resize)
        {
            return Err(RunnerError::InvalidInput(
                "serial shell cannot resize a running process; dimensions are set at launch".into(),
            ));
        }
        self.control(run_id)?
            .send(SessionControl::Resize { cols, rows })
            .map_err(|_| RunnerError::RunNotFound(run_id.to_string()))
    }

    /// 停止：置状态为 stopping 并通知执行循环做分级 kill（INT → TERM → KILL → 本地关闭）
    pub fn stop(&self, run_id: &str) -> Result<()> {
        let mut handles = self.handles.lock();
        let h = handles
            .get_mut(run_id)
            .ok_or_else(|| RunnerError::RunNotFound(run_id.to_string()))?;
        if h.status.state == RunState::Stopping {
            return Ok(());
        }
        h.stop_tx
            .send(StopKind::User)
            .map_err(|_| RunnerError::RunNotFound(run_id.to_string()))?;
        h.runtime_cancel.store(true, Ordering::Relaxed);
        h.status.state = RunState::Stopping;
        let _ = self.event_tx.send(RunEvent::Status {
            status: h.status.clone(),
        });
        Ok(())
    }

    fn control(&self, run_id: &str) -> Result<mpsc::UnboundedSender<SessionControl>> {
        self.handles
            .lock()
            .get(run_id)
            .map(|h| h.control.clone())
            .ok_or_else(|| RunnerError::RunNotFound(run_id.to_string()))
    }

    fn set_state(&self, run_id: &str, state: RunState) {
        let mut map = self.handles.lock();
        if let Some(h) = map.get_mut(run_id) {
            if h.status.state == RunState::Stopping {
                return;
            }
            h.status.state = state;
            let _ = self.event_tx.send(RunEvent::Status {
                status: h.status.clone(),
            });
        }
    }

    // ---------- Managed Runtime 准备（00027 §13/§14） ----------

    fn runtime_cancel(&self, run_id: &str) -> Arc<AtomicBool> {
        self.handles
            .lock()
            .get(run_id)
            .map(|h| h.runtime_cancel.clone())
            .unwrap_or_default()
    }

    fn set_phase(&self, run_id: &str, phase: RuntimePhase) {
        let mut map = self.handles.lock();
        if let Some(h) = map.get_mut(run_id) {
            h.status.phase = Some(phase.as_str().to_string());
            let _ = self.event_tx.send(RunEvent::Status {
                status: h.status.clone(),
            });
        }
    }

    /// 运行可追溯信息：环境 / uv / Python / lock（00027 §11）
    fn set_managed_info(&self, run_id: &str, env: &PreparedEnvironment) {
        let mut map = self.handles.lock();
        if let Some(h) = map.get_mut(run_id) {
            h.status.environment_id = Some(env.environment_id.clone());
            h.status.uv_version = Some(env.uv_version.clone());
            h.status.python_version = Some(env.python_version.clone());
            h.status.lock_sha256 = Some(env.lock_sha256.clone());
            let _ = self.event_tx.send(RunEvent::Status {
                status: h.status.clone(),
            });
        }
    }

    /// phase 进 RunStatus；进度进 runtime_progress 事件；过程输出进同一 Run 日志
    fn prepare_events(&self, run_id: &str) -> PrepareEvents {
        let this = self.clone();
        let rid = run_id.to_string();
        let on_phase = move |phase: RuntimePhase| this.set_phase(&rid, phase);
        let this = self.clone();
        let rid = run_id.to_string();
        let on_progress = move |message: &str, done: u64, total: Option<u64>| {
            let _ = this.event_tx.send(RunEvent::RuntimeProgress {
                run_id: rid.clone(),
                phase: String::new(),
                message: message.to_string(),
                downloaded_bytes: done,
                total_bytes: total,
            });
        };
        let this = self.clone();
        let rid = run_id.to_string();
        let on_output =
            move |stream: OutputStream, data: &[u8]| this.emit_output(&rid, stream, data);
        PrepareEvents {
            on_phase: Box::new(on_phase),
            on_progress: Box::new(on_progress),
            on_output: Box::new(on_output),
        }
    }

    /// 阶段 1：probe + 部署/验证 uv + 安装/验证 Managed Python（项目无关部分）
    async fn managed_prepare_runtime(
        &self,
        run_id: &str,
        host: Arc<dyn RuntimeHost + Send + Sync>,
        python_version: &str,
        config_dir: &std::path::Path,
    ) -> Result<RuntimeReady> {
        let cancel = self.runtime_cancel(run_id);
        let catalog = RuntimeCatalog::embedded()?;
        let network = NetworkConfig::default();
        let mut events = self.prepare_events(run_id);
        prepare::prepare_runtime(
            host,
            catalog,
            python_version,
            config_dir,
            &network,
            &cancel,
            &mut events,
        )
        .await
    }

    /// 阶段 2：环境锁 + uv sync --locked + 验证；成功后记录追溯字段
    async fn managed_prepare_environment(
        &self,
        run_id: &str,
        host: Arc<dyn RuntimeHost + Send + Sync>,
        ready: &RuntimeReady,
        project: &PythonProject,
        workspace_dir: &str,
    ) -> Result<PreparedEnvironment> {
        let cancel = self.runtime_cancel(run_id);
        let catalog = RuntimeCatalog::embedded()?;
        let network = NetworkConfig::default();
        let mut events = self.prepare_events(run_id);
        let env = prepare::prepare_environment(
            host,
            ready,
            project,
            workspace_dir,
            catalog,
            &network,
            run_id,
            &cancel,
            &mut events,
        )
        .await?;
        self.set_managed_info(run_id, &env);
        Ok(env)
    }

    fn finish(&self, run_id: &str, state: RunState, exit_code: Option<u32>, error: Option<String>) {
        let status = {
            let mut map = self.handles.lock();
            match map.get_mut(run_id) {
                Some(h) => {
                    h.status.state = state;
                    h.status.exit_code = exit_code;
                    h.status.error = error;
                    h.status.ended_at = Some(Local::now().to_rfc3339());
                    h.status.output_bytes = h.log_bytes;
                    h.status.output_truncated = h.log_truncated;
                    h.status.clone()
                }
                None => return,
            }
        };
        {
            let mut hist = self.history.lock();
            hist.push_front(status.clone());
            // 淘汰最旧的条目，连同其输出日志一起删除
            while hist.len() > HISTORY_LIMIT {
                if let Some(old) = hist.pop_back() {
                    remove_log(&self.logs_dir, &old.run_id);
                }
            }
            if let Ok(data) = serde_json::to_string_pretty(&*hist) {
                if let Some(parent) = self.history_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&self.history_path, data);
            }
        }
        // 终态后移除句柄
        self.handles.lock().remove(run_id);
        let _ = self.event_tx.send(RunEvent::Status { status });
    }

    pub fn start(
        &self,
        mut req: RunRequest,
        device: DeviceProfile,
        config_dir: PathBuf,
        workspace_source: Option<DeviceProfile>,
    ) -> Result<String> {
        device.validate()?;
        // Serial Shell V1 无法部署二进制 Runtime：在任何端口操作前明确拒绝（00027 §4）
        if req.managed_python && device.transport == TransportKind::Serial {
            return Err(RunnerError::managed(
                code::NOT_SUPPORTED,
                "Serial Shell V1 cannot deploy a binary managed runtime",
            ));
        }
        validate_request(&mut req)?;
        let capabilities = device.transport.capabilities();
        if req.console_mode == ConsoleMode::Pipe && !capabilities.pipe {
            return Err(RunnerError::InvalidInput(
                "serial shell has one combined console stream; pipe mode is not supported".into(),
            ));
        }
        let serial_lease = if device.transport == TransportKind::Serial {
            Some(crate::serial::transport::PortLease::acquire(
                &device.serial.as_ref().unwrap().port,
            )?)
        } else {
            None
        };
        let run_id = uuid::Uuid::new_v4().to_string();
        let label = describe_request(&req);
        let status = RunStatus::new(run_id.clone(), device.name.clone(), label);

        // 预占位：control 待 spawn 成功后替换；stop 通道立即生效
        let (placeholder, rx) = mpsc::unbounded_channel::<SessionControl>();
        drop(rx);
        let (stop_tx, stop_rx) = mpsc::unbounded_channel::<StopKind>();
        let mut handles = self.handles.lock();
        if handles.len() >= 32 {
            return Err(RunnerError::InvalidInput(
                "at most 32 runs may be active".into(),
            ));
        }
        handles.insert(
            run_id.clone(),
            RunHandle {
                _serial_lease: serial_lease,
                capabilities,
                control: placeholder,
                stop_tx,
                runtime_cancel: Arc::new(AtomicBool::new(false)),
                status: status.clone(),
                log_bytes: 0,
                log_truncated: false,
                log_failed: false,
            },
        );
        drop(handles);
        let _ = self.event_tx.send(RunEvent::Status {
            status: status.clone(),
        });

        let this = self.clone();
        let rid = run_id.clone();
        tauri::async_runtime::spawn(async move {
            this.execute(rid, req, device, config_dir, workspace_source, stop_rx)
                .await;
        });
        Ok(run_id)
    }

    async fn execute(
        &self,
        run_id: String,
        req: RunRequest,
        device: DeviceProfile,
        config_dir: PathBuf,
        workspace_source: Option<DeviceProfile>,
        stop_rx: mpsc::UnboundedReceiver<StopKind>,
    ) {
        match self
            .execute_inner(
                &run_id,
                req,
                &device,
                &config_dir,
                workspace_source,
                stop_rx,
            )
            .await
        {
            Ok(outcome) => match outcome {
                RunOutcome::Exited { code } => self.finish(&run_id, RunState::Exited, code, None),
                RunOutcome::Canceled { code } => {
                    self.finish(&run_id, RunState::Canceled, code, None)
                }
                RunOutcome::TimedOut { secs } => self.finish(
                    &run_id,
                    RunState::Failed,
                    None,
                    Some(format!("timeout after {secs}s")),
                ),
            },
            Err(e) => {
                // Managed Runtime 准备被取消（stop 置位 runtime_cancel）映射为 Canceled 终态
                if matches!(&e, RunnerError::ManagedRuntime { code: c, .. } if *c == code::CANCELED)
                {
                    self.finish(&run_id, RunState::Canceled, None, None);
                } else {
                    self.finish(&run_id, RunState::Failed, None, Some(e.to_string()));
                }
            }
        }
    }

    async fn execute_inner(
        &self,
        run_id: &str,
        mut req: RunRequest,
        device: &DeviceProfile,
        config_dir: &std::path::Path,
        workspace_source: Option<DeviceProfile>,
        mut stop_rx: mpsc::UnboundedReceiver<StopKind>,
    ) -> Result<RunOutcome> {
        // 0. 跨设备工作区（00029）：先暂存到本机临时目录，再走既有本机工作区管线；
        //    同设备工作区（SSH/WSL）由各自 transport 分支原地运行。
        let mut in_place_workspace: Option<String> = None;
        let _staging = match req.workspace.as_ref().and_then(|w| w.device_ref()) {
            Some((source_id, path)) if source_id == device.id => {
                in_place_workspace = Some(path.to_string());
                None
            }
            Some((_, path)) => {
                let source = workspace_source.as_ref().ok_or_else(|| {
                    RunnerError::InvalidInput("workspace source device is unavailable".into())
                })?;
                self.set_state(run_id, RunState::Syncing);
                let staged = tokio::select! {
                    biased;
                    _ = stop_rx.recv() => return Ok(RunOutcome::Canceled { code: None }),
                    result = crate::remote_workspace::stage::download(source, config_dir, path, run_id) => result?,
                };
                req.workspace = Some(WorkspaceRef::local(staged.path().to_string_lossy()));
                Some(staged)
            }
            None => None,
        };
        if device.transport == TransportKind::Wsl {
            return self
                .execute_wsl(run_id, req, device, config_dir, in_place_workspace, stop_rx)
                .await;
        }
        if device.transport == TransportKind::Serial {
            return self.execute_serial(run_id, &req, device, stop_rx).await;
        }
        if device.transport == TransportKind::Local {
            return self
                .execute_local(run_id, req, device, config_dir, stop_rx)
                .await;
        }
        // 1. 建立 SSH 连接
        let conn = tokio::select! {
            biased;
            _ = stop_rx.recv() => return Ok(RunOutcome::Canceled { code: None }),
            conn = SshConnection::connect(device, config_dir) => conn?,
        };

        // 2. Managed Runtime（项目无关部分）：probe + 部署/验证 uv + 安装/验证 Python
        let mut managed: Option<(
            PythonProject,
            Arc<dyn RuntimeHost + Send + Sync>,
            RuntimeReady,
        )> = None;
        if req.managed_python {
            let workspace = req
                .workspace
                .as_ref()
                .and_then(|w| w.local_dir().map(str::to_owned))
                .ok_or_else(|| {
                    RunnerError::InvalidInput("managed python requires a workspace".into())
                })?;
            let project = crate::runtime::project::inspect(std::path::Path::new(&workspace))?;
            let host: Arc<dyn RuntimeHost + Send + Sync> =
                Arc::new(crate::runtime::hosts::ssh::SshHost::from_arc(
                    conn.handle.clone(),
                    crate::runtime::manage::remote_root(),
                ));
            let ready = self
                .managed_prepare_runtime(run_id, host.clone(), &project.python_version, config_dir)
                .await?;
            managed = Some((project, host, ready));
        }
        if stop_rx.try_recv().is_ok() {
            return Ok(RunOutcome::Canceled { code: None });
        }

        // 3. 同步 workspace（如有）；同设备原地运行改为校验入口与目录（00029）
        let remote_dir = match &in_place_workspace {
            Some(path) => {
                self.set_state(run_id, RunState::Syncing);
                let check = async {
                    let workspace = crate::remote_workspace::ssh::SshWorkspace::from_connection(
                        conn.clone(),
                        path,
                    )
                    .await
                    .map_err(|e| RunnerError::TaskFailed(e.message))?;
                    if req.kind != ScriptKind::Command {
                        let entry = req.entry.as_deref().unwrap_or_default();
                        workspace
                            .check_script_entry(entry)
                            .await
                            .map_err(|e| RunnerError::InvalidInput(e.message))?;
                    }
                    Ok::<_, RunnerError>(workspace.root().to_string())
                };
                tokio::select! {
                    biased;
                    _ = stop_rx.recv() => return Ok(RunOutcome::Canceled { code: None }),
                    result = check => result?,
                }
            }
            None => format!("{}/{}", device.workspace_root.trim_end_matches('/'), run_id),
        };
        if in_place_workspace.is_none() {
            if let Some(local_dir) = req.workspace.as_ref().and_then(|w| w.local_dir()) {
                self.set_state(run_id, RunState::Syncing);
                let sync = async {
                    let sftp = filesync::open_sftp(&conn).await?;
                    filesync::upload_dir(&sftp, std::path::Path::new(local_dir), &remote_dir).await
                };
                let n = tokio::select! {
                    biased;
                    _ = stop_rx.recv() => return Ok(RunOutcome::Canceled { code: None }),
                    result = sync => result?,
                };
                tracing::info!("run {run_id}: uploaded {n} files to {remote_dir}");
            }
        }
        if stop_rx.try_recv().is_ok() {
            return Ok(RunOutcome::Canceled { code: None });
        }

        // 4. Managed Runtime：workspace 可见后执行 locked environment sync，回填启动参数
        let mut _env_lease = None;
        if let Some((project, host, ready)) = managed {
            let env = self
                .managed_prepare_environment(run_id, host, &ready, &project, &remote_dir)
                .await?;
            req.managed_env_python = Some(env.python_path.clone());
            req.managed_pythonpath = project.python_path.clone();
            req.managed_module = project.mode == EntryMode::Module;
            req.entry = Some(project.entry.clone());
            _env_lease = Some(EnvLeaseGuard::new(self.leases.clone(), &env.environment_id));
        }
        if stop_rx.try_recv().is_ok() {
            return Ok(RunOutcome::Canceled { code: None });
        }

        // 5. 构造启动命令（含远程 PID 捕获包装）
        let marker_prefix = format!("{PID_MARKER_PREFIX}{run_id}_");
        let command = build_command(&req, &remote_dir, &marker_prefix);

        // pipe 模式下包装层使用 setsid，远程 PID 即独立进程组 ID，可整组 kill
        let group_kill = req.console_mode == ConsoleMode::Pipe;

        // 4. 启动进程
        self.set_state(run_id, RunState::Starting);
        let (session_tx, mut session_rx) = mpsc::channel::<SessionEvent>(64);
        let proc = session::spawn(
            &conn,
            SpawnSpec {
                command,
                mode: req.console_mode,
                cols: req.cols,
                rows: req.rows,
            },
            session_tx,
        )
        .await?;

        // 替换占位 control sender
        if let Some(h) = self.handles.lock().get_mut(run_id) {
            h.control = proc.control.clone();
        }
        self.set_state(run_id, RunState::Running);

        // 5. 事件循环：转发输出 / 捕获 PID / 处理停止与超时
        let timeout_secs = req.timeout_secs;
        let timeout_deadline = if timeout_secs > 0 {
            Some(tokio::time::Instant::now() + Duration::from_secs(timeout_secs))
        } else {
            None
        };

        let mut exit_code: Option<u32> = None;
        let mut remote_pid: Option<u32> = None;
        let mut pid_scanner = PidScanner::new(marker_prefix);
        let mut received_exit = false;
        let mut stop_kind: Option<StopKind> = None;
        // 停止升级阶段：1=已发 Ctrl+C/SIGINT，2=已发 kill TERM，3=已发 kill KILL，4=已本地关闭
        let mut stop_stage: u8 = 0;
        let mut interrupt_sent = false;
        let mut stop_deadline: Option<tokio::time::Instant> = None;

        loop {
            // Pipe runs live in their own session. Signal the actual PID marker's
            // group, not the SSH/setsid supervisor, including Stop before the marker.
            if stop_kind.is_some() && !interrupt_sent {
                if group_kill {
                    if let Some(pid) = remote_pid {
                        kill_remote_tree(&conn, pid, "INT", true).await;
                        interrupt_sent = true;
                    }
                } else {
                    let _ = proc.control.send(SessionControl::Interrupt);
                    interrupt_sent = true;
                }
            }
            let sleep_until_timeout = async {
                match timeout_deadline {
                    Some(d) => tokio::time::sleep_until(d).await,
                    None => std::future::pending().await,
                }
            };
            let sleep_until_stop_step = async {
                match stop_deadline {
                    Some(d) => tokio::time::sleep_until(d).await,
                    None => std::future::pending().await,
                }
            };

            tokio::select! {
                ev = session_rx.recv() => {
                    let Some(ev) = ev else { break };
                    match ev {
                        SessionEvent::Output { stream, mut data } => {
                            // 从 stdout 中捕获远程 PID 标记并剥离
                            if remote_pid.is_none() && stream == OutputStream::Stdout {
                                data = pid_scanner.push(&data);
                                remote_pid = pid_scanner.pid;
                            }
                            if data.is_empty() {
                                continue;
                            }
                            self.emit_output(run_id, stream, &data);
                        }
                        SessionEvent::Exit { code } => {
                            received_exit = true;
                            exit_code = code;
                        }
                        SessionEvent::Failed { error } => return Err(RunnerError::TaskFailed(error)),
                        SessionEvent::Closed => break,
                    }
                }
                stop = stop_rx.recv() => {
                    if stop.is_none() || stop_kind.is_some() {
                        continue;
                    }
                    let kind = stop.unwrap();
                    stop_kind = Some(kind);
                    if kind == StopKind::User {
                        self.set_state(run_id, RunState::Stopping);
                    }
                    // 第一步：Ctrl+C / SIGINT 尽力而为
                    stop_stage = 1;
                    stop_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(3));
                }
                _ = sleep_until_timeout, if stop_kind.is_none() => {
                    if stop_kind.is_none() {
                        stop_kind = Some(StopKind::Timeout);
                        self.set_state(run_id, RunState::Stopping);
                        stop_stage = 1;
                        stop_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(3));
                    }
                }
                _ = sleep_until_stop_step => {
                    match stop_stage {
                        1 => {
                            // TERM：按 PID 杀进程树/进程组
                            if let Some(pid) = remote_pid {
                                kill_remote_tree(&conn, pid, "TERM", group_kill).await;
                            }
                            stop_stage = 2;
                            stop_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(2));
                        }
                        2 => {
                            // KILL
                            if let Some(pid) = remote_pid {
                                kill_remote_tree(&conn, pid, "KILL", group_kill).await;
                            }
                            // 同时本地关闭 channel（服务端可能不回 close，双保险）
                            let _ = proc.control.send(SessionControl::Kill);
                            stop_stage = 3;
                            stop_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(3));
                        }
                        _ => {
                            // 服务端始终未回 close：本地强制结束
                            tracing::warn!("run {run_id}: channel not closed by server, force finish");
                            break;
                        }
                    }
                }
            }
        }

        let remaining = std::mem::take(&mut pid_scanner.buffer);
        if !remaining.is_empty() {
            self.emit_output(run_id, OutputStream::Stdout, &remaining);
        }
        if stop_kind.is_none() && !received_exit {
            return Err(RunnerError::TaskFailed(
                "SSH channel closed without an exit status".into(),
            ));
        }

        Ok(match stop_kind {
            None => RunOutcome::Exited { code: exit_code },
            Some(StopKind::User) => RunOutcome::Canceled { code: exit_code },
            Some(StopKind::Timeout) => RunOutcome::TimedOut { secs: timeout_secs },
        })
    }

    async fn execute_wsl(
        &self,
        run_id: &str,
        mut req: RunRequest,
        device: &DeviceProfile,
        config_dir: &std::path::Path,
        in_place_workspace: Option<String>,
        mut stop_rx: mpsc::UnboundedReceiver<StopKind>,
    ) -> Result<RunOutcome> {
        use crate::wsl::{self, Event};
        if stop_rx.try_recv().is_ok() {
            return Ok(RunOutcome::Canceled { code: None });
        }
        // 同设备原地运行（00029）：remote 即工作区本身，零文件上传
        let remote = in_place_workspace.clone().unwrap_or_else(|| {
            format!("{}/{}", device.workspace_root.trim_end_matches('/'), run_id)
        });
        let mut _env_lease = None;
        let files = if in_place_workspace.is_some() {
            Vec::new()
        } else if req.managed_python {
            // Managed Runtime：独立 helper 会话上传 workspace 并完成准备（00027 §13）；
            // 运行会话（bridge A）随后零文件上传、直接 cd 到已就绪目录
            let workspace = req
                .workspace
                .as_ref()
                .and_then(|w| w.local_dir().map(str::to_owned))
                .ok_or_else(|| {
                    RunnerError::InvalidInput("managed python requires a workspace".into())
                })?;
            let project = crate::runtime::project::inspect(std::path::Path::new(&workspace))?;
            let host: Arc<dyn RuntimeHost + Send + Sync> = Arc::new(
                crate::runtime::hosts::wsl::WslHost::open(
                    device.wsl.clone().unwrap(),
                    &crate::runtime::manage::remote_root(),
                )
                .await?,
            );
            self.set_state(run_id, RunState::Syncing);
            crate::runtime::manage::upload_wsl_workspace(&host, &workspace, &remote).await?;
            if stop_rx.try_recv().is_ok() {
                return Ok(RunOutcome::Canceled { code: None });
            }
            let ready = self
                .managed_prepare_runtime(run_id, host.clone(), &project.python_version, config_dir)
                .await?;
            let env = self
                .managed_prepare_environment(run_id, host, &ready, &project, &remote)
                .await?;
            req.managed_env_python = Some(env.python_path.clone());
            req.managed_pythonpath = project.python_path.clone();
            req.managed_module = project.mode == EntryMode::Module;
            req.entry = Some(project.entry.clone());
            _env_lease = Some(EnvLeaseGuard::new(self.leases.clone(), &env.environment_id));
            Vec::new()
        } else if let Some(dir) = req
            .workspace
            .as_ref()
            .and_then(|w| w.local_dir().map(str::to_owned))
        {
            tokio::task::spawn_blocking(move || wsl::filesync::collect(std::path::Path::new(&dir)))
                .await
                .map_err(|e| RunnerError::TaskFailed(e.to_string()))??
        } else {
            Vec::new()
        };
        if stop_rx.try_recv().is_ok() {
            return Ok(RunOutcome::Canceled { code: None });
        }
        let (control, mut controls) = mpsc::unbounded_channel();
        if let Some(handle) = self.handles.lock().get_mut(run_id) {
            handle.control = control.clone();
        }
        let execution = wsl::execute(
            device.wsl.as_ref().unwrap(),
            &req,
            &remote,
            in_place_workspace.is_some(),
            files,
            &mut controls,
            |event| match event {
                Event::State(state) => self.set_state(run_id, state),
                Event::Output { stream, data } => {
                    self.emit_output(run_id, stream, &data);
                }
            },
        );
        await_transport(execution, control, stop_rx, req.timeout_secs).await
    }

    async fn execute_serial(
        &self,
        run_id: &str,
        req: &RunRequest,
        device: &DeviceProfile,
        mut stop_rx: mpsc::UnboundedReceiver<StopKind>,
    ) -> Result<RunOutcome> {
        use crate::serial::{self, Event};
        if stop_rx.try_recv().is_ok() {
            return Ok(RunOutcome::Canceled { code: None });
        }
        let files = if let Some(dir) = req
            .workspace
            .as_ref()
            .and_then(|w| w.local_dir().map(str::to_owned))
        {
            tokio::task::spawn_blocking(move || {
                serial::filesync::collect(std::path::Path::new(&dir))
            })
            .await
            .map_err(|e| RunnerError::TaskFailed(e.to_string()))??
        } else {
            Vec::new()
        };
        if stop_rx.try_recv().is_ok() {
            return Ok(RunOutcome::Canceled { code: None });
        }
        let config = device.serial.as_ref().unwrap();
        let remote = format!("{}/{}", device.workspace_root.trim_end_matches('/'), run_id);
        serial::preflight(req, &remote, &files)?;
        let port = serial::transport::open(config)?;
        let (control, mut controls) = mpsc::unbounded_channel();
        if let Some(handle) = self.handles.lock().get_mut(run_id) {
            handle.control = control.clone();
        }
        let execution = serial::execute(
            port,
            config.baud_rate,
            req,
            &remote,
            files,
            &mut controls,
            |event| match event {
                Event::State(state) => self.set_state(run_id, state),
                Event::Output { stream, data } => {
                    self.emit_output(run_id, stream, &data);
                }
            },
        );
        await_transport(execution, control, stop_rx, req.timeout_secs).await
    }

    /// 本机 shell：原地运行，无工作区上传；停止/超时升级由 local 执行循环实现
    async fn execute_local(
        &self,
        run_id: &str,
        mut req: RunRequest,
        device: &DeviceProfile,
        config_dir: &std::path::Path,
        mut stop_rx: mpsc::UnboundedReceiver<StopKind>,
    ) -> Result<RunOutcome> {
        use crate::local::{self, Event};
        if stop_rx.try_recv().is_ok() {
            return Ok(RunOutcome::Canceled { code: None });
        }
        // Managed Runtime：本机应用数据目录管理 Runtime/Environment，原工作区直接 sync
        let mut _env_lease = None;
        if req.managed_python {
            let workspace = req
                .workspace
                .as_ref()
                .and_then(|w| w.local_dir().map(str::to_owned))
                .ok_or_else(|| {
                    RunnerError::InvalidInput("managed python requires a workspace".into())
                })?;
            let project = crate::runtime::project::inspect(std::path::Path::new(&workspace))?;
            let host: Arc<dyn RuntimeHost + Send + Sync> =
                Arc::new(crate::runtime::hosts::local::LocalHost::new(
                    crate::runtime::manage::local_root(config_dir),
                )?);
            let ready = self
                .managed_prepare_runtime(run_id, host.clone(), &project.python_version, config_dir)
                .await?;
            let env = self
                .managed_prepare_environment(run_id, host, &ready, &project, &workspace)
                .await?;
            req.managed_env_python = Some(env.python_path.clone());
            req.managed_pythonpath = project.python_path.clone();
            req.managed_module = project.mode == EntryMode::Module;
            req.entry = Some(project.entry.clone());
            _env_lease = Some(EnvLeaseGuard::new(self.leases.clone(), &env.environment_id));
        }
        if stop_rx.try_recv().is_ok() {
            return Ok(RunOutcome::Canceled { code: None });
        }
        let (control, mut controls) = mpsc::unbounded_channel();
        if let Some(handle) = self.handles.lock().get_mut(run_id) {
            handle.control = control.clone();
        }
        let execution = local::execute(
            device.local.as_ref().unwrap(),
            &req,
            &mut controls,
            |event| match event {
                Event::State(state) => self.set_state(run_id, state),
                Event::Output { stream, data } => {
                    self.emit_output(run_id, stream, &data);
                }
            },
        );
        await_transport(execution, control, stop_rx, req.timeout_secs).await
    }
}

async fn await_transport(
    execution: impl std::future::Future<Output = Result<Outcome>>,
    control: mpsc::UnboundedSender<SessionControl>,
    mut stops: mpsc::UnboundedReceiver<StopKind>,
    timeout_secs: u64,
) -> Result<RunOutcome> {
    tokio::pin!(execution);
    let mut stop_sent = false;
    let result = loop {
        tokio::select! {
            biased;
            _ = stops.recv(), if !stop_sent => { stop_sent = true; let _ = control.send(SessionControl::Interrupt); }
            result = &mut execution => break result?,
        }
    };
    Ok(match result.stopped {
        Some(crate::process::StopReason::User) => RunOutcome::Canceled { code: result.code },
        Some(crate::process::StopReason::Timeout) => RunOutcome::TimedOut { secs: timeout_secs },
        None => RunOutcome::Exited { code: result.code },
    })
}

enum RunOutcome {
    Exited { code: Option<u32> },
    Canceled { code: Option<u32> },
    TimedOut { secs: u64 },
}

/// 从输出缓冲中提取 `__DEVRUNNER_PID_<digits>__` 标记，返回 (pid, 剩余字节)
struct PidScanner {
    prefix: Vec<u8>,
    buffer: Vec<u8>,
    pid: Option<u32>,
}

impl PidScanner {
    fn new(prefix: String) -> Self {
        Self {
            prefix: prefix.into_bytes(),
            buffer: Vec::new(),
            pid: None,
        }
    }

    fn push(&mut self, data: &[u8]) -> Vec<u8> {
        self.buffer.extend_from_slice(data);
        let mut output = Vec::new();
        while !self.buffer.is_empty() {
            if self.pid.is_some() {
                output.append(&mut self.buffer);
                break;
            }
            if self.buffer.starts_with(&self.prefix) {
                if let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
                    let line = &self.buffer[self.prefix.len()..end];
                    let line = line.strip_suffix(b"\r").unwrap_or(line);
                    self.pid = line
                        .strip_suffix(PID_MARKER_SUFFIX.as_bytes())
                        .and_then(|digits| std::str::from_utf8(digits).ok())
                        .and_then(|digits| digits.parse::<u32>().ok())
                        .filter(|pid| *pid > 1);
                    if self.pid.is_some() {
                        self.buffer.drain(..=end);
                        continue;
                    }
                } else if self.buffer.len() <= self.prefix.len() + 14 {
                    break;
                }
            } else if self.prefix.starts_with(&self.buffer) {
                break;
            }
            // Forward whole spans instead of repeatedly shifting a large output packet.
            let next = (1..self.buffer.len())
                .find(|&i| self.buffer[i] == self.prefix[0])
                .unwrap_or(self.buffer.len());
            output.extend(self.buffer.drain(..next));
        }
        output
    }
}

/// 通过独立的 exec channel 杀远程进程。
/// group_kill=true（pipe 模式，包装层用了 setsid）：按进程组原子 kill；
/// group_kill=false（pty 模式）：先杀子进程再杀主进程。
async fn kill_remote_tree(conn: &SshConnection, pid: u32, sig: &str, group_kill: bool) {
    let cmd = if group_kill {
        // 负 PID = 进程组；失败时退化为树 kill
        format!(
            "kill -{sig} -- -{pid} 2>/dev/null || {{ pkill -{sig} -P {pid} 2>/dev/null; kill -{sig} {pid} 2>/dev/null; }}; true"
        )
    } else {
        format!("pkill -{sig} -P {pid} 2>/dev/null; kill -{sig} {pid} 2>/dev/null; true")
    };
    tracing::info!("kill remote tree: {cmd}");
    let run = async {
        let mut channel = conn.handle.channel_open_session().await?;
        channel.exec(false, cmd.as_str()).await?;
        // 等待 channel 关闭（忽略内容）
        while channel.wait().await.is_some() {}
        Ok::<(), russh::Error>(())
    };
    match tokio::time::timeout(Duration::from_secs(5), run).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => tracing::warn!("kill_remote_tree SSH error: {e}"),
        Err(e) => tracing::warn!("kill_remote_tree timeout: {e}"),
    }
}

fn describe_request(req: &RunRequest) -> String {
    match req.kind {
        ScriptKind::Command => req.command.clone().unwrap_or_else(|| "command".to_string()),
        _ => req.entry.clone().unwrap_or_else(|| "script".to_string()),
    }
}

/// shell 单引号包裹并转义
pub(crate) fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn validate_request(req: &mut RunRequest) -> Result<()> {
    let invalid = |message: &str| RunnerError::InvalidInput(message.into());
    if serde_json::to_vec(req)
        .map_err(|e| invalid(&e.to_string()))?
        .len()
        > 64 * 1024
    {
        return Err(invalid("run request must not exceed 64 KiB"));
    }
    if req.cols == 0 || req.rows == 0 || req.cols > 4096 || req.rows > 4096 {
        return Err(invalid("console dimensions must be between 1 and 4096"));
    }
    if req.timeout_secs > 31_536_000 {
        return Err(invalid("timeout must not exceed one year"));
    }
    for (key, value) in &req.env {
        let mut chars = key.chars();
        if !chars
            .next()
            .is_some_and(|c| c == '_' || c.is_ascii_alphabetic())
            || !chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
            || value.contains('\0')
        {
            return Err(invalid("invalid environment variable"));
        }
    }
    if req.args.iter().any(|a| a.contains('\0')) {
        return Err(invalid("arguments cannot contain NUL"));
    }
    // 解析工作区来源（00029）：本机目录 canonicalize；设备目录在此校验路径形态，
    // 存在性由暂存下载或原地校验阶段在设备上确认
    let mut local_workspace: Option<PathBuf> = None;
    match &req.workspace {
        Some(WorkspaceRef::Local { dir }) => {
            let root = std::fs::canonicalize(dir)?;
            if !root.is_dir() {
                return Err(invalid("workspace must be a directory"));
            }
            local_workspace = Some(root);
        }
        Some(WorkspaceRef::Device { device_id, path }) => {
            crate::workspace_ref::validate_device_path(path).map_err(|m| invalid(&m))?;
            if req.managed_python && device_id == &req.device_id {
                return Err(invalid(
                    "同设备原地运行暂不支持 Managed Python；请选择其他运行设备或关闭 Managed Python",
                ));
            }
        }
        None => {}
    }
    if req.managed_python && req.kind != ScriptKind::Python {
        return Err(invalid("managed python requires a python script workload"));
    }
    match req.kind {
        ScriptKind::Command => {
            if !req
                .command
                .as_ref()
                .is_some_and(|c| !c.trim().is_empty() && !c.contains('\0'))
            {
                return Err(invalid("command must not be empty or contain NUL"));
            }
        }
        _ if req.managed_python => {
            // Managed 项目入口由项目契约（[tool.remote-runner]）决定，可以是模块名；
            // entry/python-path 的文件级校验由 ProjectInspector 在准备阶段完成
            if req.workspace.is_none() {
                return Err(invalid("script requires a workspace"));
            }
        }
        _ => {
            if req.workspace.is_none() {
                return Err(invalid("script requires a workspace"));
            }
            let entry = req
                .entry
                .as_ref()
                .ok_or_else(|| invalid("script requires an entry"))?;
            let entry = entry.replace('\\', "/");
            if entry.is_empty()
                || entry.contains(['\0', ':'])
                || entry
                    .split('/')
                    .any(|p| p.is_empty() || p == "." || p == "..")
            {
                return Err(invalid(
                    "entry must be a relative path inside the workspace",
                ));
            }
            match &local_workspace {
                Some(root) => {
                    let mut path = root.clone();
                    for part in entry.split('/') {
                        path.push(part);
                        if std::fs::symlink_metadata(&path)?.file_type().is_symlink() {
                            return Err(invalid(
                                "symbolic links are not supported for script entries",
                            ));
                        }
                    }
                    let resolved = std::fs::canonicalize(&path)?;
                    if !resolved.starts_with(root) || !resolved.is_file() {
                        return Err(invalid("entry must be a file inside the workspace"));
                    }
                }
                // 设备工作区：入口存在性在设备上确认（00029）
                None => {}
            }
            req.entry = Some(entry);
        }
    }
    if let Some(root) = local_workspace {
        // 校验用 canonical 形式，回写的工作区则用常规形式：它会成为 shell 的 cwd、
        // msys2/gitbash 的入口路径以及界面展示的路径（00030）。
        req.workspace = Some(WorkspaceRef::local(
            crate::verbatim::simplify(&root).to_string_lossy(),
        ));
    }
    Ok(())
}

/// 构造最终在设备上执行的命令行。
///
/// 形式：
///   mktemp → decode script → background process with channel stdin → PID → wait
///
/// 脚本体的 base64 编码避免一切嵌套引号问题；包装层捕获远程 PID 用于可靠的 stop/timeout kill；
/// `wait` 将进程退出码原样传递为 channel 的 exit-status。
pub(crate) fn build_script(req: &RunRequest, remote_dir: &str) -> String {
    let env_prefix = req
        .env
        .iter()
        .map(|(k, v)| format!("export {}={};", k, sh_quote(v)))
        .collect::<Vec<_>>()
        .join(" ");

    // Managed Runtime：python-path 由后端验证（项目契约），展开为 workspace 内绝对路径
    let pythonpath_prefix = if req.managed_pythonpath.is_empty() {
        String::new()
    } else {
        let joined = req
            .managed_pythonpath
            .iter()
            .map(|p| format!("{}/{p}", remote_dir.trim_end_matches('/')))
            .collect::<Vec<_>>()
            .join(":");
        format!("export PYTHONPATH={};", sh_quote(&joined))
    };

    let body = match req.kind {
        ScriptKind::Python => {
            let entry = req.entry.as_deref().unwrap_or("main.py");
            let args = req
                .args
                .iter()
                .map(|a| sh_quote(a))
                .collect::<Vec<_>>()
                .join(" ");
            if let Some(env_python) = &req.managed_env_python {
                // Managed Runtime：直接启动环境内 Python，不使用 uv run / 系统 Python
                if req.managed_module {
                    format!(
                        "exec {} -u -m {} {}",
                        sh_quote(env_python),
                        sh_quote(entry),
                        args
                    )
                } else {
                    format!(
                        "exec {} -u {} {}",
                        sh_quote(env_python),
                        sh_quote(&format!("./{entry}")),
                        args
                    )
                }
            } else {
                // exec 使 sh 直接替换为目标进程，PID 即 python 进程
                format!(
                    "exec python3 -u {} {}",
                    sh_quote(&format!("./{entry}")),
                    args
                )
            }
        }
        ScriptKind::Shell => {
            let entry = req.entry.as_deref().unwrap_or("main.sh");
            let args = req
                .args
                .iter()
                .map(|a| sh_quote(a))
                .collect::<Vec<_>>()
                .join(" ");
            format!("exec bash {} {}", sh_quote(&format!("./{entry}")), args)
        }
        ScriptKind::Command => req.command.clone().unwrap_or_default(),
    };

    if req.workspace.is_some() {
        format!(
            "cd {} || exit $?; {env_prefix} {pythonpath_prefix} {body}",
            sh_quote(remote_dir)
        )
    } else {
        format!("{env_prefix} {pythonpath_prefix} {body}")
    }
}

fn build_command(req: &RunRequest, remote_dir: &str, marker_prefix: &str) -> String {
    // Emit the PID from the workload's foreground shell. Non-interactive shell
    // background jobs inherit SIGINT/SIGQUIT ignored, which `trap -` cannot undo.
    // Removing the already-open script before exec also avoids orphan temp files.
    let script = format!(
        "rm -f -- \"$0\"; printf '{marker_prefix}%s{PID_MARKER_SUFFIX}\\n' \"$$\"; {}",
        build_script(req, remote_dir)
    );
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(script.as_bytes());
    // -w preserves the exit status even when setsid must fork a session leader.
    // PTY workloads stay in the SSH foreground group and retain their terminal.
    let setsid = match req.console_mode {
        ConsoleMode::Pipe => "setsid -w ",
        ConsoleMode::Pty => "",
    };
    format!(
        "umask 077; __f=$(mktemp /tmp/.devrunner-wrap-XXXXXXXXXX) || exit 1; trap 'rm -f -- \"$__f\"' EXIT; echo {b64} | base64 -d > \"$__f\" || exit 1; exec {setsid}sh \"$__f\""
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn local_wrapper(
        command: &str,
        input: &[u8],
        mode: ConsoleMode,
    ) -> Option<(i32, Vec<u8>, u32)> {
        use std::io::Write;
        use std::process::{Command, Stdio};
        #[cfg(windows)]
        let shell = std::path::Path::new("C:/Program Files/Git/bin/bash.exe");
        #[cfg(not(windows))]
        let shell = std::path::Path::new("/bin/sh");
        if !shell.exists() {
            eprintln!("SKIP: local POSIX shell unavailable");
            return None;
        }
        let mut req = request();
        req.command = Some(command.into());
        req.console_mode = mode;
        let wrapper = build_command(&req, "/tmp/unused", "__REVIEW_PID_");
        // Let a POSIX parent translate signaled termination to 128+signal;
        // MSYS native Windows process status is otherwise not a POSIX exit code.
        let supervised = format!(
            "sh -c {}; __test_rc=$?; exit \"$__test_rc\"",
            sh_quote(&wrapper)
        );
        let mut child = Command::new(shell)
            .arg("-c")
            .arg(supervised)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        let result = child.wait_with_output().unwrap();
        let mut scanner = PidScanner::new("__REVIEW_PID_".into());
        let mut output = scanner.push(&result.stdout);
        output.extend_from_slice(&scanner.buffer);
        let code = result.status.code().unwrap_or(130);
        Some((
            code,
            output,
            scanner.pid.expect("actual workload PID marker"),
        ))
    }

    #[test]
    fn foreground_wrapper_preserves_sigint_and_user_cleanup() {
        if let Some((code, output, _)) =
            local_wrapper("kill -INT $$; echo SHOULD_NOT_PRINT", b"", ConsoleMode::Pty)
        {
            assert_eq!(code, 130);
            assert!(output.is_empty());
        }
        if let Some((code, output, _)) = local_wrapper(
            "trap 'printf cleanup; exit 23' INT; kill -INT $$; echo SHOULD_NOT_PRINT",
            b"",
            ConsoleMode::Pty,
        ) {
            assert_eq!(code, 23);
            assert_eq!(output, b"cleanup");
        }
    }

    #[test]
    fn foreground_wrapper_preserves_stdin_pid_exit_code_and_removes_temp_script() {
        let command = "test ! -e \"$0\" || exit 99; printf '%s:' \"$$\"; read value; printf '%s' \"$value\"; exit 7";
        if let Some((code, output, pid)) =
            local_wrapper(command, b"literal input\n", ConsoleMode::Pty)
        {
            assert_eq!(code, 7);
            assert_eq!(output, format!("{pid}:literal input").as_bytes());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn pipe_wrapper_waits_for_session_and_reports_its_actual_group_pid() {
        let (code, output, pid) = local_wrapper(
            "ps -o pgid= -p $$; read value; printf '%s' \"$value\"; exit 7",
            b"INPUT\n",
            ConsoleMode::Pipe,
        )
        .unwrap();
        assert_eq!(code, 7);
        assert_eq!(
            String::from_utf8(output).unwrap().trim(),
            format!("{pid}\nINPUT")
        );
    }

    #[test]
    fn output_overload_is_bounded_and_recovers_a_lost_terminal_status() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let (tx, mut rx) = crate::events::channel();
        let manager = RunManager::new(&root, tx);
        let (control, _) = mpsc::unbounded_channel();
        let (stop_tx, _) = mpsc::unbounded_channel();
        manager.handles.lock().insert(
            "run".into(),
            RunHandle {
                _serial_lease: None,
                capabilities: TransportKind::Ssh.capabilities(),
                control,
                stop_tx,
                runtime_cancel: Arc::new(AtomicBool::new(false)),
                status: RunStatus::new("run".into(), "test".into(), "bounded".into()),
                log_bytes: 0,
                log_truncated: false,
                log_failed: false,
            },
        );
        manager.finish("run", RunState::Exited, Some(7), None);
        // Force the terminal event out of the bounded retention window.
        for _ in 0..crate::events::EVENT_CAPACITY * 2 {
            manager.emit_output(
                "run",
                OutputStream::Stdout,
                &[0xff; crate::events::OUTPUT_CHUNK],
            );
        }
        let events = crate::events::drain(&mut rx, &manager);
        let RunEvent::Resync { statuses } = &events[0] else {
            panic!("expected explicit lag recovery")
        };
        assert_eq!(statuses[0].state, RunState::Exited);
        assert_eq!(statuses[0].exit_code, Some(7));
        assert!(events.len() <= crate::events::BATCH_SIZE);
        let mut retained = events.len() - 1;
        for _ in 0..5 {
            retained += crate::events::drain(&mut rx, &manager).len();
        }
        assert_eq!(retained, crate::events::EVENT_CAPACITY);
        assert!(crate::events::drain(&mut rx, &manager).is_empty());
        manager.emit_output("next", OutputStream::Stderr, &[0xff, 0, 0xfe]);
        let events = crate::events::drain(&mut rx, &manager);
        let RunEvent::Output { data, stream, .. } = &events[0] else {
            panic!("expected raw output")
        };
        assert_eq!(stream, "stderr");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(data)
                .unwrap(),
            [0xff, 0, 0xfe]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    fn request() -> RunRequest {
        serde_json::from_value(serde_json::json!({
            "device_id": "test", "kind": "command", "command": "true"
        }))
        .unwrap()
    }

    #[test]
    fn pid_marker_preserves_binary_output_at_every_packet_boundary() {
        let prefix = "__DEVRUNNER_PID_test_";
        let input = b"\xffbefore\n__DEVRUNNER_PID_test_123__\r\nafter\xe4\xb8\xad";
        for split in 0..=input.len() {
            let mut scanner = PidScanner::new(prefix.into());
            let mut output = scanner.push(&input[..split]);
            output.extend(scanner.push(&input[split..]));
            output.extend_from_slice(&scanner.buffer);
            assert_eq!(scanner.pid, Some(123), "split {split}");
            assert_eq!(output, b"\xffbefore\nafter\xe4\xb8\xad", "split {split}");
        }
    }

    #[test]
    fn pid_scanner_does_not_swallow_short_or_invalid_output() {
        for input in [
            b"hello".as_slice(),
            b"__DEVRUNNER_PID_test_0__\n",
            b"__DEVRUNNER_PID_test_12",
        ] {
            let mut scanner = PidScanner::new("__DEVRUNNER_PID_test_".into());
            let mut output = Vec::new();
            for byte in input {
                output.extend(scanner.push(&[*byte]));
            }
            output.extend_from_slice(&scanner.buffer);
            assert_eq!(output, input);
            assert_eq!(scanner.pid, None);
        }
    }

    #[test]
    fn validates_commands_and_environment_before_start() {
        let mut req = request();
        req.command = Some(" ".into());
        assert!(validate_request(&mut req).is_err());
        req.command = Some("true".into());
        req.env.insert("X; touch /tmp/injected".into(), "1".into());
        assert!(validate_request(&mut req).is_err());
        req.env.clear();
        req.env.insert("VALID_1".into(), "quotes ' and $()".into());
        assert!(validate_request(&mut req).is_ok());
    }

    #[test]
    fn validates_script_entry_and_normalizes_windows_paths() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/test.py"), "print(1)").unwrap();
        let mut req = request();
        req.kind = ScriptKind::Python;
        req.workspace = Some(crate::workspace_ref::WorkspaceRef::local(
            root.to_string_lossy().into_owned(),
        ));
        for entry in ["../test.py", "/test.py", "C:/test.py", "sub", "missing.py"] {
            req.entry = Some(entry.into());
            assert!(validate_request(&mut req).is_err(), "{entry}");
        }
        req.entry = Some("sub\\test.py".into());
        validate_request(&mut req).unwrap();
        assert_eq!(req.entry.as_deref(), Some("sub/test.py"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn command_environment_is_exported_and_script_names_are_not_options() {
        let mut req = request();
        req.env.insert("VALUE".into(), "a'b".into());
        req.command = Some("printf '%s' \"$VALUE\"; true".into());
        let decode = |req: &RunRequest| {
            let command = build_command(req, "/tmp/ws", "marker_");
            let encoded = command
                .split("echo ")
                .nth(1)
                .unwrap()
                .split_whitespace()
                .next()
                .unwrap();
            String::from_utf8(
                base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .unwrap(),
            )
            .unwrap()
        };
        let script = decode(&req);
        assert!(script.contains("export VALUE='a'\\''b';"));
        assert!(script.contains("printf '%s' \"$VALUE\"; true"));
        req.kind = ScriptKind::Python;
        req.entry = Some("-test.py".into());
        assert!(decode(&req).contains("python3 -u './-test.py'"));
    }

    #[test]
    fn terminal_event_is_published_after_history_and_remains_queryable() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let (events, mut rx) = crate::events::channel();
        let manager = RunManager::new(&root, events);
        let (control, _) = mpsc::unbounded_channel();
        let (stop_tx, _stop_rx) = mpsc::unbounded_channel();
        manager.handles.lock().insert(
            "run".into(),
            RunHandle {
                _serial_lease: None,
                capabilities: TransportKind::Ssh.capabilities(),
                control,
                stop_tx,
                runtime_cancel: Arc::new(AtomicBool::new(false)),
                status: RunStatus::new("run".into(), "device".into(), "test".into()),
                log_bytes: 0,
                log_truncated: false,
                log_failed: false,
            },
        );
        manager.stop("run").unwrap();
        manager.set_state("run", RunState::Running);
        assert_eq!(manager.status("run").unwrap().state, RunState::Stopping);
        manager.finish("run", RunState::Canceled, Some(143), None);
        while let Ok(event) = rx.try_recv() {
            if let RunEvent::Status { status } = event {
                if status.state == RunState::Canceled {
                    assert_eq!(manager.history()[0].run_id, "run");
                    assert_eq!(manager.status("run").unwrap().exit_code, Some(143));
                    assert!(manager.list_running().is_empty());
                }
            }
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    fn test_handle(run_id: &str) -> RunHandle {
        let (control, _) = mpsc::unbounded_channel();
        let (stop_tx, _) = mpsc::unbounded_channel();
        RunHandle {
            _serial_lease: None,
            capabilities: TransportKind::Ssh.capabilities(),
            control,
            stop_tx,
            runtime_cancel: Arc::new(AtomicBool::new(false)),
            status: RunStatus::new(run_id.into(), "device".into(), "test".into()),
            log_bytes: 0,
            log_truncated: false,
            log_failed: false,
        }
    }

    #[test]
    fn output_is_persisted_to_log_and_capped_at_run_log_limit() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let (tx, _rx) = crate::events::channel();
        let manager = RunManager::new(&root, tx);
        manager
            .handles
            .lock()
            .insert("run".into(), test_handle("run"));
        manager.emit_output("run", OutputStream::Stdout, b"hello ");
        manager.emit_output("run", OutputStream::Stderr, b"world");
        // 超过上限的部分被截断，只保留开头 RUN_LOG_LIMIT 字节
        manager.emit_output("run", OutputStream::Stdout, &vec![b'x'; 3 * 1024 * 1024]);
        manager.emit_output("run", OutputStream::Stdout, b"dropped");
        manager.finish("run", RunState::Exited, Some(0), None);

        let log = std::fs::read(root.join("run_logs/run.log")).unwrap();
        assert_eq!(log.len() as u64, RUN_LOG_LIMIT);
        assert!(log.starts_with(b"hello world"));
        let status = &manager.history()[0];
        assert_eq!(status.output_bytes, RUN_LOG_LIMIT);
        assert!(status.output_truncated);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn log_write_failure_does_not_affect_the_run() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let (tx, mut rx) = crate::events::channel();
        let manager = RunManager::new(&root, tx);
        // 在日志路径上放一个同名目录，使文件创建必然失败
        std::fs::create_dir_all(root.join("run_logs/run.log")).unwrap();
        manager
            .handles
            .lock()
            .insert("run".into(), test_handle("run"));
        manager.emit_output("run", OutputStream::Stdout, b"data");
        manager.finish("run", RunState::Exited, Some(0), None);
        // 事件仍推送，历史仍记录，只是没有输出字节
        assert!(matches!(rx.try_recv(), Ok(RunEvent::Output { .. })));
        assert_eq!(manager.history()[0].output_bytes, 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn evicted_history_entries_lose_their_logs() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let (tx, _rx) = crate::events::channel();
        let manager = RunManager::new(&root, tx);
        // 先填满 HISTORY_LIMIT 条带日志的历史
        for i in 0..HISTORY_LIMIT {
            let id = format!("run{i}");
            manager.handles.lock().insert(id.clone(), test_handle(&id));
            manager.emit_output(&id, OutputStream::Stdout, b"x");
            manager.finish(&id, RunState::Exited, Some(0), None);
        }
        assert!(root.join("run_logs/run0.log").is_file());
        // 第 201 条淘汰最旧的 run0，其日志一并删除
        manager
            .handles
            .lock()
            .insert("new".into(), test_handle("new"));
        manager.emit_output("new", OutputStream::Stdout, b"x");
        manager.finish("new", RunState::Exited, Some(0), None);
        assert_eq!(manager.history().len(), HISTORY_LIMIT);
        assert!(!root.join("run_logs/run0.log").exists());
        assert!(root.join("run_logs/new.log").is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn startup_truncates_history_and_prunes_orphan_logs() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let logs = root.join("run_logs");
        std::fs::create_dir_all(&logs).unwrap();
        // 超出上限的历史：run0 应被截掉并删除日志
        let history: VecDeque<RunStatus> = (0..HISTORY_LIMIT + 1)
            .map(|i| RunStatus::new(format!("run{i}"), "d".into(), "l".into()))
            .collect();
        std::fs::write(
            root.join("history.json"),
            serde_json::to_string(&history).unwrap(),
        )
        .unwrap();
        std::fs::write(logs.join("run200.log"), b"evicted").unwrap();
        std::fs::write(logs.join("run1.log"), b"kept").unwrap();
        std::fs::write(logs.join("orphan.log"), b"stale").unwrap();
        std::fs::write(logs.join("not-a-log.txt"), b"untouched").unwrap();

        let (tx, _rx) = crate::events::channel();
        let manager = RunManager::new(&root, tx);
        assert_eq!(manager.history().len(), HISTORY_LIMIT);
        // 队尾超出上限的 run200 被截掉，日志一并删除
        assert!(!logs.join("run200.log").exists());
        assert!(logs.join("run1.log").is_file());
        assert!(!logs.join("orphan.log").exists());
        // 不符合命名约定的文件不受影响
        assert!(logs.join("not-a-log.txt").is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn old_history_without_output_fields_still_loads() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("history.json"),
            r#"[{"run_id":"r1","device_name":"d","label":"l","state":"exited",
                "exit_code":0,"error":null,"started_at":"2026-09-12T00:00:00+08:00",
                "ended_at":null}]"#,
        )
        .unwrap();
        let (tx, _rx) = crate::events::channel();
        let manager = RunManager::new(&root, tx);
        let status = &manager.history()[0];
        assert_eq!(status.run_id, "r1");
        assert_eq!(status.output_bytes, 0);
        assert!(!status.output_truncated);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn export_output_validates_input_and_copies_raw_bytes() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let (tx, _rx) = crate::events::channel();
        let manager = RunManager::new(&root, tx);
        manager
            .handles
            .lock()
            .insert("run".into(), test_handle("run"));
        manager.emit_output("run", OutputStream::Stdout, b"\xffraw\nbytes");
        let target = root.join("export.log");

        assert!(manager
            .export_output("../escape", target.to_str().unwrap())
            .is_err());
        assert!(manager
            .export_output("missing", target.to_str().unwrap())
            .is_err());
        assert!(manager.export_output("run", "").is_err());
        manager
            .export_output("run", target.to_str().unwrap())
            .unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"\xffraw\nbytes");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn clear_history_removes_logs_and_keeps_active_runs() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let (tx, _rx) = crate::events::channel();
        let manager = RunManager::new(&root, tx);
        for id in ["done1", "done2"] {
            manager.handles.lock().insert(id.into(), test_handle(id));
            manager.emit_output(id, OutputStream::Stdout, b"x");
            manager.finish(id, RunState::Exited, Some(0), None);
        }
        // 运行中的任务带日志，清空历史不应触碰
        manager
            .handles
            .lock()
            .insert("live".into(), test_handle("live"));
        manager.emit_output("live", OutputStream::Stdout, b"x");

        manager.clear_history().unwrap();
        assert!(manager.history().is_empty());
        assert_eq!(
            std::fs::read_to_string(root.join("history.json")).unwrap(),
            "[]"
        );
        assert!(!root.join("run_logs/done1.log").exists());
        assert!(!root.join("run_logs/done2.log").exists());
        assert!(root.join("run_logs/live.log").is_file());

        // 重启后历史仍为空（清空结果已持久化）
        let (tx2, _rx2) = crate::events::channel();
        let manager2 = RunManager::new(&root, tx2);
        assert!(manager2.history().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    // ---------- Managed Runtime（00027） ----------

    fn managed_request() -> RunRequest {
        let mut req = request();
        req.kind = ScriptKind::Python;
        req.workspace = Some(crate::workspace_ref::WorkspaceRef::local("/tmp/ws"));
        req.entry = Some("main.py".into());
        req.managed_python = true;
        req
    }

    #[test]
    fn build_script_managed_script_mode_uses_env_python_and_pythonpath() {
        let mut req = managed_request();
        req.managed_env_python =
            Some("/home/u/.remote-runner/runtime-v1/envs/abc/bin/python".into());
        req.managed_pythonpath = vec!["src".into(), "lib/util".into()];
        req.args = vec!["--flag".into(), "a b".into()];
        let script = build_script(&req, "/tmp/devrunner/workspaces/run1");
        assert!(
            script.contains(
                "exec '/home/u/.remote-runner/runtime-v1/envs/abc/bin/python' -u './main.py'"
            ),
            "{script}"
        );
        assert!(!script.contains("python3"), "{script}");
        assert!(
            script.contains("export PYTHONPATH='/tmp/devrunner/workspaces/run1/src:/tmp/devrunner/workspaces/run1/lib/util';"),
            "{script}"
        );
        assert!(script.contains("'--flag' 'a b'"), "{script}");
    }

    #[test]
    fn build_script_managed_module_mode_uses_dash_m() {
        let mut req = managed_request();
        req.managed_env_python = Some("/env/bin/python".into());
        req.managed_module = true;
        req.entry = Some("pkg.main".into());
        let script = build_script(&req, "/tmp/ws-remote");
        assert!(
            script.contains("exec '/env/bin/python' -u -m 'pkg.main'"),
            "{script}"
        );
        assert!(!script.contains("PYTHONPATH"), "{script}");
    }

    #[test]
    fn managed_python_requires_python_kind() {
        let mut req = request(); // kind = command
        req.managed_python = true;
        let err = validate_request(&mut req).unwrap_err();
        assert!(err.to_string().contains("python script workload"), "{err}");
    }

    #[test]
    fn serial_managed_python_is_rejected_before_port_access() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let (tx, _rx) = crate::events::channel();
        let manager = RunManager::new(&root, tx);
        let device: DeviceProfile = serde_json::from_value(serde_json::json!({
            "id": "s1", "name": "uart", "transport": "serial",
            "serial": { "port": "COM99", "baud_rate": 115200 }
        }))
        .unwrap();
        let mut req = request();
        req.managed_python = true;
        let err = manager.start(req, device, root.clone(), None).unwrap_err();
        assert!(err.to_string().contains(code::NOT_SUPPORTED), "{err}");
        assert!(manager.list_running().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stop_sets_runtime_cancel_flag() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let (tx, _rx) = crate::events::channel();
        let manager = RunManager::new(&root, tx);
        // stop() 需要 stop_tx 接收端存活才能送达
        let (control, _cr) = mpsc::unbounded_channel();
        let (stop_tx, _sr) = mpsc::unbounded_channel();
        manager.handles.lock().insert(
            "run".into(),
            RunHandle {
                _serial_lease: None,
                capabilities: TransportKind::Ssh.capabilities(),
                control,
                stop_tx,
                runtime_cancel: Arc::new(AtomicBool::new(false)),
                status: RunStatus::new("run".into(), "device".into(), "test".into()),
                log_bytes: 0,
                log_truncated: false,
                log_failed: false,
            },
        );
        let flag = manager.runtime_cancel("run");
        assert!(!flag.load(Ordering::Relaxed));
        manager.stop("run").unwrap();
        assert!(flag.load(Ordering::Relaxed));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn env_lease_guard_releases_on_drop() {
        let leases = Arc::new(LeaseSet::default());
        {
            let _guard = EnvLeaseGuard::new(leases.clone(), "env-1");
            assert!(leases.is_leased("env-1"));
        }
        assert!(!leases.is_leased("env-1"));
    }
}
