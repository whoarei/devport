//! rr-cli：无 GUI 的核心链路验证工具
//!
//! 用法：
//!   rr-cli [host] [user] command <命令...>
//!   rr-cli [host] [user] python  <本地脚本.py> [args...]
//!   rr-cli [host] [user] shell   <本地脚本.sh> [args...]
//!
//! 默认 host=172.16.0.67 user=root（密钥认证，使用 ~/.ssh 下的默认私钥）

use remote_runner::device::{AuthMethod, DeviceProfile};
use remote_runner::runner::{RunEvent, RunManager, RunRequest, ScriptKind};
use remote_runner::ssh::session::ConsoleMode;
use std::collections::HashMap;
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()),
        )
        .init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut host = "172.16.0.67".to_string();
    let mut user = "root".to_string();
    let mut rest = args.as_slice();
    if !rest.is_empty()
        && !matches!(
            rest[0].as_str(),
            "command" | "python" | "shell" | "interact-test" | "stop-test"
        )
    {
        host = rest[0].clone();
        rest = &rest[1..];
        if !rest.is_empty()
            && !matches!(
                rest[0].as_str(),
                "command" | "python" | "shell" | "interact-test" | "stop-test"
            )
        {
            user = rest[0].clone();
            rest = &rest[1..];
        }
    }

    let mode = rest.first().cloned().unwrap_or_default();
    let params = rest.get(1..).unwrap_or_default();

    // 自检模式：pty 交互 / stop 取消
    if mode == "interact-test" || mode == "stop-test" {
        let interact = mode == "interact-test";
        let config_dir = dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("remote-runner");
        std::fs::create_dir_all(&config_dir).ok();

        // 准备临时工作区
        let ws = std::env::temp_dir().join(format!("rr-cli-selftest-{}", std::process::id()));
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(
            ws.join("ask.py"),
            "import sys\nprint('isatty:', sys.stdin.isatty())\nname = input('your name> ')\nprint('hello,', name)\n",
        )
        .unwrap();

        let device = DeviceProfile {
            is_default: false,
            transport: Default::default(),
            serial: None,
            wsl: None,
            local: None,
            id: "cli-device".to_string(),
            name: format!("{user}@{host}"),
            host: host.clone(),
            port: 22,
            username: user.clone(),
            auth: AuthMethod::Key { key_path: None },
            workspace_root: remote_runner::device::default_workspace_root(),
        };

        let (event_tx, mut event_rx) = remote_runner::events::channel();
        let manager = RunManager::new(&config_dir, event_tx);

        let request = if interact {
            RunRequest {
                device_id: device.id.clone(),
                workspace: Some(remote_runner::workspace_ref::WorkspaceRef::local(
                    ws.to_string_lossy(),
                )),
                kind: ScriptKind::Python,
                entry: Some("ask.py".to_string()),
                args: vec![],
                env: HashMap::new(),
                command: None,
                managed_python: false,
                managed_env_python: None,
                managed_pythonpath: vec![],
                managed_module: false,
                console_mode: ConsoleMode::Pty,
                cols: 120,
                rows: 40,
                timeout_secs: 30,
            }
        } else {
            RunRequest {
                device_id: device.id.clone(),
                workspace: None,
                kind: ScriptKind::Command,
                entry: None,
                args: vec![],
                env: HashMap::new(),
                command: Some("echo begin; sleep 60; echo SHOULD_NOT_PRINT".to_string()),
                managed_python: false,
                managed_env_python: None,
                managed_pythonpath: vec![],
                managed_module: false,
                console_mode: ConsoleMode::Pipe,
                cols: 120,
                rows: 40,
                timeout_secs: 0,
            }
        };

        let run_id = manager.start(request, device, config_dir, None).unwrap();
        eprintln!("[rr-cli] run_id = {run_id}");

        // 延迟动作：interact 发送 stdin；stop 发送停止
        {
            let manager = manager.clone();
            let rid = run_id.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                if interact {
                    eprintln!("[rr-cli] >>> sending stdin: world");
                    let _ = manager.send_input(&rid, b"world\n".to_vec());
                } else {
                    eprintln!("[rr-cli] >>> stopping");
                    let _ = manager.stop(&rid);
                }
            });
        }

        let mut final_state = String::new();
        while let Some(ev) = next_event(&mut event_rx, &manager, &run_id).await {
            match ev {
                RunEvent::Resync { .. } => unreachable!("CLI recovers directly"),
                RunEvent::RuntimeProgress { message, .. } => {
                    eprintln!("[rr-cli] prepare: {message}");
                }
                RunEvent::Output { data, .. } => {
                    print!("{}", String::from_utf8_lossy(&base64_decode(&data)));
                }
                RunEvent::Status { status } => {
                    eprintln!(
                        "[rr-cli] state={} exit={:?} err={:?}",
                        status.state, status.exit_code, status.error
                    );
                    if matches!(status.state.as_str(), "exited" | "failed" | "canceled") {
                        final_state = status.state.to_string();
                        break;
                    }
                }
            }
        }

        std::fs::remove_dir_all(&ws).ok();
        if interact {
            // 预期 exited 且 exit=0
            std::process::exit(if final_state == "exited" { 0 } else { 1 });
        } else {
            // 预期 canceled
            std::process::exit(if final_state == "canceled" { 0 } else { 1 });
        }
    }

    let (kind, entry, workspace, command, run_args) = match mode.as_str() {
        "command" => (
            ScriptKind::Command,
            None,
            None,
            Some(params.join(" ")),
            Vec::new(),
        ),
        "python" | "shell" => {
            let file = params.first().expect("need script file path");
            let path = PathBuf::from(file);
            let entry = path
                .file_name()
                .expect("bad file name")
                .to_string_lossy()
                .to_string();
            let workspace = path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or_else(|| std::path::Path::new("."))
                .to_string_lossy()
                .to_string();
            let kind = if mode == "python" {
                ScriptKind::Python
            } else {
                ScriptKind::Shell
            };
            (
                kind,
                Some(entry),
                Some(workspace),
                None,
                params[1..].to_vec(),
            )
        }
        _ => {
            eprintln!("usage: rr-cli [host] [user] command <cmd...> | python <file.py> [args] | shell <file.sh> [args]");
            std::process::exit(2);
        }
    };

    let config_dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("remote-runner");
    std::fs::create_dir_all(&config_dir).ok();

    let device = DeviceProfile {
        is_default: false,
        transport: Default::default(),
        serial: None,
        wsl: None,
        local: None,
        id: "cli-device".to_string(),
        name: format!("{user}@{host}"),
        host,
        port: 22,
        username: user,
        auth: AuthMethod::Key { key_path: None },
        workspace_root: remote_runner::device::default_workspace_root(),
    };

    let (event_tx, mut event_rx) = remote_runner::events::channel();
    let manager = RunManager::new(&config_dir, event_tx);

    let run_id = manager
        .start(
            RunRequest {
                device_id: device.id.clone(),
                workspace: workspace.map(remote_runner::workspace_ref::WorkspaceRef::local),
                kind,
                entry,
                args: run_args,
                env: HashMap::new(),
                command,
                managed_python: false,
                managed_env_python: None,
                managed_pythonpath: vec![],
                managed_module: false,
                console_mode: ConsoleMode::Pipe,
                cols: 120,
                rows: 40,
                timeout_secs: 60,
            },
            device,
            config_dir,
            None,
        )
        .expect("start run failed");
    eprintln!("[rr-cli] run_id = {run_id}");

    let mut exit_code: Option<u32> = None;
    while let Some(ev) = next_event(&mut event_rx, &manager, &run_id).await {
        match ev {
            RunEvent::Resync { .. } => unreachable!("CLI recovers directly"),
            RunEvent::RuntimeProgress { message, .. } => {
                eprintln!("[rr-cli] prepare: {message}");
            }
            RunEvent::Output { stream, data, .. } => {
                let bytes = base64_decode(&data);
                let text = String::from_utf8_lossy(&bytes);
                if stream == "stderr" {
                    eprint!("[stderr] {text}");
                } else {
                    print!("{text}");
                }
            }
            RunEvent::Status { status } => {
                eprintln!(
                    "[rr-cli] state={} exit={:?} err={:?}",
                    status.state, status.exit_code, status.error
                );
                match status.state.as_str() {
                    "exited" => {
                        exit_code = status.exit_code;
                        break;
                    }
                    "failed" | "canceled" => {
                        exit_code = status.exit_code.or(Some(255));
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    std::process::exit(exit_code.unwrap_or(0) as i32);
}

fn base64_decode(s: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .unwrap_or_default()
}

async fn next_event(
    rx: &mut tokio::sync::broadcast::Receiver<RunEvent>,
    manager: &RunManager,
    id: &str,
) -> Option<RunEvent> {
    loop {
        match rx.recv().await {
            Ok(event) => return Some(event),
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                eprintln!("[rr-cli] output truncated: {count} events skipped");
                *rx = manager.subscribe_events();
                if let Some(status) = manager.status(id) {
                    return Some(RunEvent::Status { status });
                }
            }
        }
    }
}
