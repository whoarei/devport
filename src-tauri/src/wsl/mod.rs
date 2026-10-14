//! Direct local WSL transport. No network socket, SSH server, or credentials.
pub mod filesync;
pub mod terminal;

use crate::device::WslConfig;
use crate::error::{Result, RunnerError};
use crate::process::{OutputStream, SessionControl};
use crate::runner::{build_script, RunRequest};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::mpsc,
};

const HELPER: &str = concat!(
    include_str!("../file_transfer/helper.py"),
    "\n",
    include_str!("helper.py")
);
const FRAME_LIMIT: usize = 128 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(30);

/// helper 源码经 stdin 首行传入，而不是作为 `-c` 参数：Windows 命令行上限
/// 32767 字符，脚本一旦变大 CreateProcess 就会失败（os error 206）。
/// 首行必须是 base64 载荷 + `\n`，且握手完成前不得再写入任何字节。
const BOOTSTRAP: &str = r#"import base64,os
payload=b""
while not payload.endswith(b"\n"):
    payload+=os.read(0,65536)
exec(compile(base64.b64decode(payload),"helper.py","exec"))"#;

/// 启动 helper 的命令行；helper 源码随 stdin 首行下发（见 `BOOTSTRAP`）
pub(crate) struct HelperCommand {
    command: Command,
    payload: Option<Vec<u8>>,
}

impl From<Command> for HelperCommand {
    /// 不带载荷：命令行本身已经指明了要运行的程序（测试用的假 helper）
    fn from(command: Command) -> Self {
        Self {
            command,
            payload: None,
        }
    }
}

#[cfg(test)]
impl HelperCommand {
    /// 把一段 Python 源码作为载荷挂在给定命令上：用于在宿主 python 上
    /// 直接验证「载荷先于握手」的契约，不需要 WSL 发行版
    pub(crate) fn with_payload(command: Command, source: &str) -> Self {
        Self {
            command,
            payload: Some(STANDARD.encode(source).into_bytes()),
        }
    }
}

use crate::process::RunState;
pub use crate::process::{ExecutionEvent as Event, Outcome, StopReason};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum Message {
    Ready {
        version: u32,
        info: String,
    },
    Ack,
    Started,
    Output {
        stream: String,
        data: String,
    },
    /// Managed Runtime 结构化 exec 完成（00027）
    #[serde(rename = "exec_exit")]
    ExecExit {
        code: Option<u32>,
    },
    Exit {
        code: Option<u32>,
        stopped: Option<StopReason>,
    },
    Error {
        message: String,
    },
    // ---- fs_* 文件服务消息（00029 远端工作区）----
    #[serde(rename = "fs_entry")]
    FsEntry {
        name: String,
        dir: bool,
        link: bool,
    },
    #[serde(rename = "fs_file")]
    FsFile {
        size: u64,
        revision: String,
    },
    #[serde(rename = "fs_chunk")]
    FsChunk {
        data: String,
    },
    #[serde(rename = "fs_done")]
    FsDone,
    #[serde(rename = "fs_saved")]
    FsSaved {
        revision: String,
    },
    #[serde(rename = "fs_error")]
    FsError {
        code: String,
        message: String,
    },
    #[serde(rename = "tf_reply")]
    TransferReply {
        result: Value,
    },
}

fn failure(message: impl Into<String>) -> RunnerError {
    RunnerError::Wsl(message.into())
}

pub(crate) fn wsl_command() -> Result<Command> {
    #[cfg(windows)]
    {
        // Use the system binary, never an executable found in the workspace.
        let root =
            std::env::var_os("SystemRoot").ok_or_else(|| failure("SystemRoot is unavailable"))?;
        let mut command = Command::new(std::path::PathBuf::from(root).join("System32/wsl.exe"));
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        command.kill_on_drop(true);
        Ok(command)
    }
    #[cfg(not(windows))]
    {
        Err(failure("direct WSL targets are supported on Windows only"))
    }
}

pub(crate) fn helper_command(config: &WslConfig) -> Result<HelperCommand> {
    config.validate()?;
    let mut command = wsl_command()?;
    command.arg("--distribution").arg(&config.distribution);
    if !config.user.is_empty() {
        command.arg("--user").arg(&config.user);
    }
    command
        .args(["--cd", "~", "--exec", "python3", "-I", "-u", "-c"])
        .arg(BOOTSTRAP);
    Ok(HelperCommand {
        command,
        payload: Some(STANDARD.encode(HELPER).into_bytes()),
    })
}

pub(crate) fn decode_wsl_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.iter().any(|&b| b == 0) {
        let bytes = bytes.strip_prefix(&[0xff, 0xfe]).unwrap_or(bytes);
        String::from_utf16_lossy(
            &bytes
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect::<Vec<_>>(),
        )
    } else {
        String::from_utf8_lossy(bytes)
            .trim_start_matches('\u{feff}')
            .to_string()
    }
}

pub async fn list_distributions() -> Result<Vec<String>> {
    let mut command = wsl_command()?;
    command.args(["--list", "--quiet"]).stdin(Stdio::null());
    let output = tokio::time::timeout(IO_TIMEOUT, command.output())
        .await
        .map_err(|_| failure("listing WSL distributions timed out"))??;
    if !output.status.success() {
        return Err(failure(format!(
            "cannot list WSL distributions: {} {}",
            decode_wsl_text(&output.stdout),
            decode_wsl_text(&output.stderr)
        )));
    }
    Ok(decode_wsl_text(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect())
}

pub(crate) struct Bridge {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    buffer: Vec<u8>,
    diagnostics: Arc<parking_lot::Mutex<Vec<u8>>>,
    stderr_task: tokio::task::JoinHandle<()>,
    info: String,
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.stderr_task.abort();
    }
}

impl Bridge {
    pub(crate) async fn launch(helper: impl Into<HelperCommand>) -> Result<Self> {
        let HelperCommand {
            mut command,
            payload,
        } = helper.into();
        let mut child = command
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                failure(format!(
                    "cannot start WSL (requires an installed distribution and python3): {e}"
                ))
            })?;
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        // helper 源码必须在任何协议消息之前、并在等待握手之前写入：
        // 引导程序按「首行即载荷」读取，握手前不会再写入其它字节
        if let Some(mut payload) = payload {
            payload.push(b'\n');
            tokio::time::timeout(IO_TIMEOUT, stdin.write_all(&payload))
                .await
                .map_err(|_| failure("WSL helper upload timed out"))?
                .map_err(|e| failure(format!("cannot send the WSL helper: {e}")))?;
        }
        let diagnostics = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let captured = diagnostics.clone();
        let stderr_task = tokio::spawn(async move {
            let mut chunk = [0; 4096];
            while let Ok(n) = stderr.read(&mut chunk).await {
                if n == 0 {
                    break;
                }
                let mut data = captured.lock();
                let keep = n.min(16384_usize.saturating_sub(data.len()));
                data.extend_from_slice(&chunk[..keep]);
            }
        });
        let mut bridge = Self {
            child,
            stdin,
            stdout,
            buffer: Vec::new(),
            diagnostics,
            stderr_task,
            info: String::new(),
        };
        match tokio::time::timeout(IO_TIMEOUT, bridge.next())
            .await
            .map_err(|_| failure("WSL startup timed out"))??
        {
            Message::Ready { version: 1, info } => bridge.info = info,
            _ => return Err(failure("unsupported WSL helper handshake")),
        }
        Ok(bridge)
    }

    pub(crate) async fn send(&mut self, value: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&value).map_err(|e| failure(e.to_string()))?;
        if bytes.len() > FRAME_LIMIT {
            return Err(failure("WSL request exceeds 128 KiB"));
        }
        bytes.push(b'\n');
        tokio::time::timeout(IO_TIMEOUT, self.stdin.write_all(&bytes))
            .await
            .map_err(|_| failure("WSL control write timed out"))??;
        Ok(())
    }

    pub(crate) async fn next(&mut self) -> Result<Message> {
        loop {
            if let Some(end) = self.buffer.iter().position(|&b| b == b'\n') {
                let line: Vec<_> = self.buffer.drain(..=end).collect();
                let message: Message = serde_json::from_slice(&line).map_err(|_| {
                    failure(format!(
                        "invalid WSL helper response (check python3): {}",
                        decode_wsl_text(&line)
                    ))
                })?;
                return match message {
                    Message::Error { message } => Err(failure(message)),
                    other => Ok(other),
                };
            }
            let mut chunk = [0; 8192];
            let n = self.stdout.read(&mut chunk).await?;
            if n == 0 {
                // Give the stderr drain a chance to collect the startup diagnostic.
                tokio::task::yield_now().await;
                return Err(failure(format!(
                    "WSL helper closed without a completion message: {} {}",
                    decode_wsl_text(&self.buffer),
                    decode_wsl_text(&self.diagnostics.lock())
                )));
            }
            self.buffer.extend_from_slice(&chunk[..n]);
            if self.buffer.len() > FRAME_LIMIT {
                return Err(failure("WSL response exceeds 128 KiB"));
            }
        }
    }

    pub(crate) async fn request(&mut self, value: Value) -> Result<()> {
        self.send(value).await?;
        match tokio::time::timeout(IO_TIMEOUT, self.next())
            .await
            .map_err(|_| failure("WSL upload acknowledgement timed out"))??
        {
            Message::Ack => Ok(()),
            _ => Err(failure("unexpected WSL upload response")),
        }
    }

    async fn wait(&mut self) -> Result<()> {
        let status = tokio::time::timeout(Duration::from_secs(5), self.child.wait())
            .await
            .map_err(|_| failure("WSL helper did not shut down"))??;
        if !status.success() {
            return Err(failure(format!(
                "WSL helper failed: {}",
                decode_wsl_text(&self.diagnostics.lock())
            )));
        }
        Ok(())
    }
}

pub async fn test_device(config: &WslConfig) -> Result<String> {
    let mut bridge = Bridge::launch(helper_command(config)?).await?;
    let info = format!("WSL {}: {}", config.distribution, bridge.info);
    bridge.send(json!({"type":"shutdown"})).await?;
    bridge.wait().await?;
    Ok(info)
}

/// Managed Runtime 结构化 exec（00027）：argv + env + cwd + 分块 stdin，
/// 输出以 Output 消息流回，结束于 exec_exit。cancel 由调用方关闭 bridge 实现
/// （helper EOF → finally 杀整个 exec 进程组）。
pub(crate) async fn exec_managed(
    bridge: &mut Bridge,
    argv: &[String],
    env: &[(String, String)],
    cwd: Option<&str>,
    input: &[u8],
) -> Result<crate::runtime::host::ExecResult> {
    use base64::Engine;
    let env_json: serde_json::Map<String, Value> = env
        .iter()
        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
        .collect();
    bridge
        .request(json!({"type":"exec_begin","argv":argv,"env":env_json,"cwd":cwd}))
        .await?;
    for chunk in input.chunks(48 * 1024) {
        bridge
            .request(json!({"type":"exec_input","data":STANDARD.encode(chunk)}))
            .await?;
    }
    bridge.request(json!({"type":"exec_run"})).await?;
    let mut result = crate::runtime::host::ExecResult::default();
    loop {
        match tokio::time::timeout(IO_TIMEOUT, bridge.next())
            .await
            .map_err(|_| failure("WSL exec timed out"))??
        {
            Message::Output { stream, data } => {
                let data = STANDARD
                    .decode(data)
                    .map_err(|_| failure("invalid output bytes"))?;
                match stream.as_str() {
                    "stdout" => result.stdout.extend_from_slice(&data),
                    "stderr" => result.stderr.extend_from_slice(&data),
                    _ => return Err(failure("invalid output stream")),
                }
            }
            Message::ExecExit { code } => {
                result.code = code.map(|c| c as i32);
                return Ok(result);
            }
            _ => return Err(failure("unexpected WSL exec response")),
        }
    }
}

pub async fn execute(
    config: &WslConfig,
    req: &RunRequest,
    remote: &str,
    in_place: bool,
    files: Vec<filesync::Entry>,
    controls: &mut mpsc::UnboundedReceiver<SessionControl>,
    emit: impl FnMut(Event),
) -> Result<Outcome> {
    execute_with_command(
        helper_command(config)?,
        req,
        remote,
        in_place,
        files,
        controls,
        emit,
        None,
    )
    .await
}

/// workspace 上传完成后、启动进程前的 Managed Runtime 准备钩子（00027 §13）
pub type PrepareHook = Box<dyn FnOnce(&str) -> std::result::Result<(), RunnerError> + Send>;

pub(crate) async fn execute_with_command(
    command: impl Into<HelperCommand>,
    req: &RunRequest,
    remote: &str,
    in_place: bool,
    files: Vec<filesync::Entry>,
    controls: &mut mpsc::UnboundedReceiver<SessionControl>,
    mut emit: impl FnMut(Event),
    prepare_hook: Option<PrepareHook>,
) -> Result<Outcome> {
    let canceled = || Outcome {
        code: None,
        stopped: Some(StopReason::User),
    };
    let launch = Bridge::launch(command);
    tokio::pin!(launch);
    let mut bridge = loop {
        tokio::select! {
            biased;
            Some(control) = controls.recv() => if matches!(control, SessionControl::Interrupt | SessionControl::Terminate | SessionControl::Kill) { return Ok(canceled()); },
            result = &mut launch => break result?,
        }
    };
    if req.workspace.is_some() {
        emit(Event::State(RunState::Syncing));
    }
    let prepare = async {
        // The helper already changes directory using its verified directory fd.
        // Avoid resolving the workspace path again from shell code.
        let mut script_req = req.clone();
        script_req.workspace = None;
        bridge
            .request(
                json!({"type":"init", "remote":req.workspace.as_ref().map(|_| remote),
            "in_place":in_place, "command":build_script(&script_req, remote), "mode":req.console_mode,
            "cols":req.cols, "rows":req.rows, "timeout":req.timeout_secs}),
            )
            .await?;
        for entry in files {
            if let Some(data) = entry.data {
                bridge
                    .request(json!({"type":"file", "path":entry.path, "mode":entry.mode}))
                    .await?;
                for chunk in data.chunks(48 * 1024) {
                    bridge
                        .request(json!({"type":"chunk", "data":STANDARD.encode(chunk)}))
                        .await?;
                }
                bridge.request(json!({"type":"end"})).await?;
            } else {
                bridge
                    .request(json!({"type":"directory", "path":entry.path}))
                    .await?;
            }
        }
        Ok::<_, RunnerError>(())
    };
    {
        tokio::pin!(prepare);
        loop {
            tokio::select! {
                biased;
                Some(control) = controls.recv() => if matches!(control, SessionControl::Interrupt | SessionControl::Terminate | SessionControl::Kill) { return Ok(canceled()); },
                result = &mut prepare => { result?; break; },
            }
        }
    }
    emit(Event::State(RunState::Starting));
    // Managed Runtime：workspace 已在目标可见，执行 locked environment sync 等准备
    if let Some(hook) = prepare_hook {
        hook(remote)?;
    }
    bridge.send(json!({"type":"start"})).await?;
    let mut deadline = Some(tokio::time::Instant::now() + IO_TIMEOUT);
    let mut stopping = false;
    let mut started = false;
    loop {
        let watchdog = async {
            match deadline {
                Some(d) => tokio::time::sleep_until(d).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            biased;
            Some(control) = controls.recv() => match control {
                SessionControl::Input(data) if !stopping => {
                    for chunk in data.chunks(16 * 1024) { bridge.send(json!({"type":"input", "data":STANDARD.encode(chunk)})).await?; }
                }
                SessionControl::Resize { cols, rows } => {
                    if cols == 0 || rows == 0 || cols > 4096 || rows > 4096 { return Err(failure("invalid terminal dimensions")); }
                    bridge.send(json!({"type":"resize", "cols":cols, "rows":rows})).await?;
                }
                SessionControl::Interrupt | SessionControl::Terminate | SessionControl::Kill if !stopping => {
                    stopping = true;
                    deadline = Some(tokio::time::Instant::now() + Duration::from_secs(15));
                    emit(Event::State(RunState::Stopping));
                    bridge.send(json!({"type":"stop"})).await?;
                }
                _ => {}
            },
            _ = watchdog => return Err(failure("WSL did not confirm startup or termination")),
            message = bridge.next() => match message? {
                Message::Started if !started => {
                    started = true;
                    if !stopping {
                        // Also bound a broken helper when a run has a timeout.
                        deadline = if req.timeout_secs > 0 { Some(tokio::time::Instant::now() + Duration::from_secs(req.timeout_secs + 15)) } else { None };
                        emit(Event::State(RunState::Running));
                    }
                }
                Message::Output { stream, data } => {
                    let stream = match stream.as_str() { "stdout" => OutputStream::Stdout, "stderr" => OutputStream::Stderr, _ => return Err(failure("invalid output stream")) };
                    let data = STANDARD.decode(data).map_err(|_| failure("invalid output bytes"))?;
                    emit(Event::Output { stream, data });
                }
                Message::Exit { code, stopped } if started && code.is_some() => {
                    bridge.wait().await?;
                    return Ok(Outcome { code, stopped });
                }
                _ => return Err(failure("unexpected WSL execution response")),
            }
        }
    }
}

#[cfg(test)]
mod tests;
