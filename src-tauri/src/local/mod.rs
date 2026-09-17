//! 本机 shell 直连 transport：不经 SSH/串口/WSL，直接在本机 spawn 进程。
//! 工作区原地运行（不上传、不复制），子进程以工作区目录为 cwd。
pub mod session;
pub mod shells;
pub mod terminal;

use crate::device::LocalConfig;
use crate::error::{Result, RunnerError};
use crate::process::{Outcome, RunState, SessionControl, StopReason};
use crate::runner::{RunRequest, ScriptKind};
use session::{ChildEvent, Session, SessionSpec};
use shells::{Flavor, Shell};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::sync::mpsc;

pub use crate::process::ExecutionEvent as Event;

fn failure(message: impl Into<String>) -> RunnerError {
    RunnerError::Local(message.into())
}

pub(super) fn default_working_directory() -> Option<PathBuf> {
    dirs::home_dir()
        .filter(|path| path.is_dir())
        .or_else(|| std::env::current_dir().ok().filter(|path| path.is_dir()))
}

/// msys2/gitbash 以登录 shell 启动（-l）时，/etc/profile 会 `cd "$HOME"`，把 spawn
/// 时给定的 cwd 覆盖掉；CHERE_INVOKING=1（与 Windows「Git Bash Here」右键菜单同一
/// 约定）让 profile 保留当前目录。仅 login posix shell 需要；用户显式给出的同名
/// 变量优先（Windows 环境变量大小写不敏感）。
fn preserve_cwd_env(shell: &Shell, env: &mut Vec<(String, String)>) {
    if shell.login
        && !env
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("CHERE_INVOKING"))
    {
        env.push(("CHERE_INVOKING".into(), "1".into()));
    }
}

/// 停止升级节奏，与 SSH/WSL 的 INT → TERM → KILL 对齐
const STAGE_TERM_AFTER: Duration = Duration::from_secs(3);
const STAGE_KILL_AFTER: Duration = Duration::from_secs(2);
const STAGE_GIVE_UP_AFTER: Duration = Duration::from_secs(3);
/// 退出后等待读取线程排空输出的宽限
const DRAIN_GRACE: Duration = Duration::from_millis(300);
const EXIT_POLL: Duration = Duration::from_millis(50);

/// 解析 Python 解释器（不经 shell，直接 spawn）
fn python_interpreter() -> Result<PathBuf> {
    #[cfg(windows)]
    const NAMES: [&str; 2] = ["python", "python3"];
    #[cfg(not(windows))]
    const NAMES: [&str; 2] = ["python3", "python"];
    for name in NAMES {
        if let Some(path) = shells::find_on_path(name) {
            return Ok(path);
        }
    }
    Err(failure(
        "python3 was not found in PATH; install Python or fix PATH",
    ))
}

/// 把入口相对路径拼成工作区内的原生绝对路径
fn entry_path(workspace: &str, entry: &str) -> PathBuf {
    let mut path = PathBuf::from(workspace);
    for part in entry.split('/') {
        path.push(part);
    }
    path
}

/// MSYS2/Git Bash 的 Windows 绝对路径转 posix 形式（E:\a\b → /e/a/b）
#[cfg(windows)]
fn to_msys_path(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    if s.len() >= 2 && s.as_bytes()[1] == b':' {
        format!("/{}{}", s[..1].to_ascii_lowercase(), &s[2..])
    } else {
        s
    }
}

/// 本机工作区目录（跨设备暂存后亦为本地路径；设备工作区不会到达这里）
fn workspace_dir(req: &RunRequest) -> Option<&str> {
    req.workspace.as_ref().and_then(|w| w.local_dir())
}

/// 按 shell 风味构造 spawn 参数；Python/Shell 类型不经 shell 解释参数
pub(crate) fn invocation(shell: &Shell, req: &RunRequest) -> Result<(PathBuf, Vec<String>)> {
    match req.kind {
        ScriptKind::Python => {
            let entry = req.entry.as_deref().unwrap_or("main.py");
            let workspace =
                workspace_dir(req).ok_or_else(|| failure("script requires a workspace"))?;
            // Managed Runtime：直接 spawn 环境内 Python，不探测系统 Python（00027 §13）
            if let Some(env_python) = &req.managed_env_python {
                let mut args = vec!["-u".to_string()];
                if req.managed_module {
                    args.push("-m".to_string());
                    args.push(entry.to_string());
                } else {
                    args.push(entry_path(workspace, entry).to_string_lossy().into_owned());
                }
                args.extend(req.args.iter().cloned());
                return Ok((PathBuf::from(env_python), args));
            }
            let mut args = vec![
                "-u".to_string(),
                entry_path(workspace, entry).to_string_lossy().into_owned(),
            ];
            args.extend(req.args.iter().cloned());
            Ok((python_interpreter()?, args))
        }
        ScriptKind::Shell => {
            let entry = req.entry.as_deref().unwrap_or("main.sh");
            let workspace =
                workspace_dir(req).ok_or_else(|| failure("script requires a workspace"))?;
            let entry = entry_path(workspace, entry);
            let mut args: Vec<String> = match shell.flavor {
                Flavor::Posix => {
                    let script = {
                        #[cfg(windows)]
                        {
                            to_msys_path(&entry)
                        }
                        #[cfg(not(windows))]
                        {
                            entry.to_string_lossy().into_owned()
                        }
                    };
                    if shell.login {
                        vec!["-l".to_string(), script]
                    } else {
                        vec![script]
                    }
                }
                Flavor::PowerShell => vec![
                    "-NoProfile".to_string(),
                    "-File".to_string(),
                    entry.to_string_lossy().into_owned(),
                ],
                Flavor::Cmd => vec!["/C".to_string(), entry.to_string_lossy().into_owned()],
            };
            args.extend(req.args.iter().cloned());
            Ok((shell.path.clone(), args))
        }
        ScriptKind::Command => {
            let command = req
                .command
                .clone()
                .ok_or_else(|| failure("command must not be empty"))?;
            let args = match shell.flavor {
                Flavor::Posix if shell.login => vec!["-l".to_string(), "-c".to_string(), command],
                Flavor::Posix => vec!["-c".to_string(), command],
                Flavor::PowerShell => {
                    vec!["-NoProfile".to_string(), "-Command".to_string(), command]
                }
                Flavor::Cmd => vec!["/C".to_string(), command],
            };
            Ok((shell.path.clone(), args))
        }
    }
}

fn spec_for(shell: &Shell, req: &RunRequest) -> Result<SessionSpec> {
    let (program, args) = invocation(shell, req)?;
    let cwd = match workspace_dir(req) {
        Some(workspace) => PathBuf::from(workspace),
        None => default_working_directory()
            .ok_or_else(|| failure("cannot determine the local working directory"))?,
    };
    let mut env: Vec<(String, String)> = req
        .env
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    // Managed Runtime：python-path 由后端验证，展开为工作区内绝对路径加入 PYTHONPATH
    if !req.managed_pythonpath.is_empty() {
        if let Some(workspace) = workspace_dir(req) {
            let paths: Vec<PathBuf> = req
                .managed_pythonpath
                .iter()
                .map(|p| entry_path(workspace, p))
                .collect();
            if let Ok(joined) = std::env::join_paths(paths) {
                env.push(("PYTHONPATH".into(), joined.to_string_lossy().into_owned()));
            }
        }
    }
    preserve_cwd_env(shell, &mut env);
    Ok(SessionSpec {
        program,
        args,
        cwd: Some(cwd),
        env,
        mode: req.console_mode,
        cols: req.cols,
        rows: req.rows,
    })
}

async fn sleep_until(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(d) => tokio::time::sleep_until(d).await,
        None => std::future::pending().await,
    }
}

pub async fn execute(
    config: &LocalConfig,
    req: &RunRequest,
    controls: &mut mpsc::UnboundedReceiver<SessionControl>,
    mut emit: impl FnMut(Event),
) -> Result<Outcome> {
    let canceled = || Outcome {
        code: None,
        stopped: Some(StopReason::User),
    };
    let shell = shells::resolve(config)?;
    let spec = spec_for(&shell, req)?;
    emit(Event::State(RunState::Starting));
    // spawn（含 ConPTY 创建）是阻塞操作，放入阻塞线程池；期间可取消
    let spawn = tokio::task::spawn_blocking(move || Session::spawn(&spec));
    tokio::pin!(spawn);
    let mut pending_controls = Vec::new();
    let mut session = loop {
        tokio::select! {
            biased;
            Some(control) = controls.recv() => {
                if matches!(control, SessionControl::Interrupt | SessionControl::Terminate | SessionControl::Kill) {
                    return Ok(canceled());
                }
                pending_controls.push(control);
            },
            result = &mut spawn => break result.map_err(|e| RunnerError::TaskFailed(e.to_string()))??,
        }
    };
    emit(Event::State(RunState::Running));
    for control in pending_controls {
        match control {
            SessionControl::Input(data) => session.input(data),
            SessionControl::Resize { cols, rows } => session.resize(cols, rows)?,
            SessionControl::Interrupt | SessionControl::Terminate | SessionControl::Kill => {}
        }
    }

    let mut timeout_deadline = (req.timeout_secs > 0)
        .then(|| tokio::time::Instant::now() + Duration::from_secs(req.timeout_secs));
    let mut stop_reason: Option<StopReason> = None;
    let mut stop_stage: u8 = 0;
    let mut stop_deadline: Option<tokio::time::Instant> = None;
    let mut exit_code: Option<u32> = None;
    let mut readers_done = 0usize;

    loop {
        if let Some(code) = session.try_wait()? {
            exit_code = Some(code);
            break;
        }
        let poll = tokio::time::sleep(EXIT_POLL);
        tokio::select! {
            biased;
            Some(control) = controls.recv() => match control {
                SessionControl::Input(data) if stop_reason.is_none() => session.input(data),
                SessionControl::Resize { cols, rows } if stop_reason.is_none() => session.resize(cols, rows)?,
                SessionControl::Interrupt | SessionControl::Terminate | SessionControl::Kill if stop_reason.is_none() => {
                    stop_reason = Some(StopReason::User);
                    emit(Event::State(RunState::Stopping));
                    // 无温和中断语义的平台/模式（pipe-Windows）直接进入第二阶段
                    if session.interrupt() {
                        stop_stage = 1;
                        stop_deadline = Some(tokio::time::Instant::now() + STAGE_TERM_AFTER);
                    } else {
                        session.terminate();
                        stop_stage = 2;
                        stop_deadline = Some(tokio::time::Instant::now() + STAGE_KILL_AFTER);
                    }
                }
                _ => {}
            },
            Some(event) = session.next_event() => match event {
                ChildEvent::Output { stream, data } => emit(Event::Output { stream, data }),
                ChildEvent::ReaderDone => readers_done += 1,
            },
            _ = poll => {}
            _ = sleep_until(timeout_deadline), if stop_reason.is_none() => {
                stop_reason = Some(StopReason::Timeout);
                timeout_deadline = None;
                emit(Event::State(RunState::Stopping));
                if session.interrupt() {
                    stop_stage = 1;
                    stop_deadline = Some(tokio::time::Instant::now() + STAGE_TERM_AFTER);
                } else {
                    session.terminate();
                    stop_stage = 2;
                    stop_deadline = Some(tokio::time::Instant::now() + STAGE_KILL_AFTER);
                }
            }
            _ = sleep_until(stop_deadline) => {
                match stop_stage {
                    1 => {
                        session.terminate();
                        stop_stage = 2;
                        stop_deadline = Some(tokio::time::Instant::now() + STAGE_KILL_AFTER);
                    }
                    2 => {
                        session.force_kill();
                        stop_stage = 3;
                        stop_deadline = Some(tokio::time::Instant::now() + STAGE_GIVE_UP_AFTER);
                    }
                    _ => {
                        // 进程无法被杀死：放弃等待，按当前停止原因收尾
                        session.force_kill();
                        break;
                    }
                }
            }
        }
    }

    // 停止/超时路径确保整棵进程树已清理（正常退出不动同组后代，见设计文档边界）
    if stop_reason.is_some() {
        session.force_kill();
    }
    // 退出前排空残余输出：等待读取线程 EOF 或宽限到期
    let grace = tokio::time::Instant::now() + DRAIN_GRACE;
    while readers_done < session.expected_readers {
        tokio::select! {
            biased;
            Some(event) = session.next_event() => match event {
                ChildEvent::Output { stream, data } => emit(Event::Output { stream, data }),
                ChildEvent::ReaderDone => readers_done += 1,
            },
            _ = tokio::time::sleep_until(grace) => break,
        }
    }
    Ok(Outcome {
        code: exit_code,
        stopped: stop_reason,
    })
}

/// 测试连接：以所选 shell 打印版本/平台信息
pub async fn test_device(config: &LocalConfig) -> Result<String> {
    let shell = shells::resolve(config)?;
    let args: Vec<String> = match shell.flavor {
        Flavor::Posix if shell.login => vec![
            "-l".into(),
            "-c".into(),
            "uname -a 2>/dev/null; { python3 --version || python --version; } 2>&1".into(),
        ],
        Flavor::Posix => vec![
            "-c".into(),
            "uname -a 2>/dev/null; { python3 --version || python --version; } 2>&1".into(),
        ],
        Flavor::PowerShell => vec![
            "-NoProfile".into(),
            "-Command".into(),
            "$PSVersionTable.PSVersion.ToString(); python --version 2>&1".into(),
        ],
        Flavor::Cmd => vec!["/C".into(), "ver & python --version 2>&1".into()],
    };
    let spec = SessionSpec {
        program: shell.path.clone(),
        args,
        cwd: default_working_directory(),
        env: Vec::new(),
        mode: crate::process::ConsoleMode::Pipe,
        cols: 80,
        rows: 24,
    };
    let probe = tokio::task::spawn_blocking(move || Session::spawn(&spec));
    let mut session = tokio::time::timeout(Duration::from_secs(15), probe)
        .await
        .map_err(|_| failure("local shell probe timed out"))?
        .map_err(|e| RunnerError::TaskFailed(e.to_string()))??;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let mut output: Vec<u8> = Vec::new();
    let mut exited = false;
    while !exited {
        if session.try_wait()?.is_some() {
            exited = true;
        }
        tokio::select! {
            biased;
            Some(event) = session.next_event() => if let ChildEvent::Output { data, .. } = event {
                let keep = data.len().min(64 * 1024_usize.saturating_sub(output.len()));
                output.extend_from_slice(&data[..keep]);
            },
            _ = tokio::time::sleep(EXIT_POLL) => {}
            _ = tokio::time::sleep_until(deadline) => {
                session.force_kill();
                return Err(failure("local shell probe timed out"));
            }
        }
    }
    // 排空管道中已缓冲的输出
    loop {
        match tokio::time::timeout(DRAIN_GRACE, session.next_event()).await {
            Ok(Some(ChildEvent::Output { data, .. })) => {
                let keep = data.len().min(64 * 1024_usize.saturating_sub(output.len()));
                output.extend_from_slice(&data[..keep]);
            }
            _ => break,
        }
    }
    Ok(format!(
        "Local {} ({})\n{}",
        shell.label,
        shell.path.display(),
        String::from_utf8_lossy(&output)
    ))
}

#[cfg(test)]
mod tests;
