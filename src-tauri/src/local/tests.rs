//! 本机 shell transport 测试：纯 argv 构造 + 真实本机进程集成（无硬件依赖，shell 缺失自动跳过）。
use super::shells::{self, Flavor, Shell};
use super::*;
use crate::process::{ConsoleMode, OutputStream};
use serde_json::json;
use std::sync::{Arc, Mutex};

fn fake_shell(id: &'static str, flavor: Flavor, login: bool) -> Shell {
    Shell {
        id,
        label: id,
        flavor,
        path: PathBuf::from(if cfg!(windows) {
            r"C:\shell.exe"
        } else {
            "/bin/sh"
        }),
        login,
    }
}

fn command_request(command: &str) -> RunRequest {
    serde_json::from_value(json!({
        "device_id": "test", "kind": "command", "command": command
    }))
    .unwrap()
}

#[test]
fn invocation_dispatches_per_flavor() {
    let cmd = command_request("echo hello");
    let posix = fake_shell("msys2", Flavor::Posix, true);
    let (_, args) = invocation(&posix, &cmd).unwrap();
    assert_eq!(args, vec!["-l", "-c", "echo hello"]);
    let plain = fake_shell("bash", Flavor::Posix, false);
    let (_, args) = invocation(&plain, &cmd).unwrap();
    assert_eq!(args, vec!["-c", "echo hello"]);
    let pwsh = fake_shell("pwsh", Flavor::PowerShell, false);
    let (_, args) = invocation(&pwsh, &cmd).unwrap();
    assert_eq!(args, vec!["-NoProfile", "-Command", "echo hello"]);
    let cmdshell = fake_shell("cmd", Flavor::Cmd, false);
    let (_, args) = invocation(&cmdshell, &cmd).unwrap();
    assert_eq!(args, vec!["/C", "echo hello"]);
}

#[test]
fn invocation_builds_script_entries_without_shell_interpolation() {
    let mut req = command_request("unused");
    req.kind = ScriptKind::Shell;
    req.workspace_dir = Some(if cfg!(windows) { r"E:\ws" } else { "/ws" }.into());
    req.entry = Some("sub/main.sh".into());
    req.args = vec!["a b".into()];
    let posix = fake_shell("bash", Flavor::Posix, false);
    let (program, args) = invocation(&posix, &req).unwrap();
    assert_eq!(program, posix.path);
    #[cfg(not(windows))]
    assert_eq!(args, vec!["/ws/sub/main.sh", "a b"]);
    // Windows 上 posix shell（msys2/gitbash）入口路径转成 /e/... 形式
    #[cfg(windows)]
    assert_eq!(args, vec!["/e/ws/sub/main.sh", "a b"]);

    let pwsh = fake_shell("pwsh", Flavor::PowerShell, false);
    let (_, args) = invocation(&pwsh, &req).unwrap();
    let expect = if cfg!(windows) {
        r"E:\ws\sub\main.sh"
    } else {
        "/ws/sub/main.sh"
    };
    assert_eq!(args, vec!["-NoProfile", "-File", expect, "a b"]);

    req.kind = ScriptKind::Python;
    req.entry = Some("main.py".into());
    let (program, args) = invocation(&posix, &req).unwrap();
    assert!(program
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("python"));
    assert!(args[0] == "-u" && args[1].ends_with("main.py") && args[2] == "a b");
}

#[test]
fn commands_without_a_workspace_start_in_a_local_user_directory() {
    let shell = fake_shell("cmd", Flavor::Cmd, false);
    let spec = spec_for(&shell, &command_request("echo hello")).unwrap();
    assert!(spec.cwd.is_some_and(|path| path.is_dir()));
}

#[test]
fn login_shells_get_chere_invoking_so_profile_keeps_the_spawn_cwd() {
    // msys2/gitbash（login posix）：注入 CHERE_INVOKING=1 防 /etc/profile cd $HOME
    let msys = fake_shell("msys2", Flavor::Posix, true);
    let spec = spec_for(&msys, &command_request("pwd")).unwrap();
    assert!(
        spec.env
            .iter()
            .any(|(k, v)| k == "CHERE_INVOKING" && v == "1"),
        "env: {:?}",
        spec.env
    );
    // 非登录 shell 不注入
    let bash = fake_shell("bash", Flavor::Posix, false);
    let spec = spec_for(&bash, &command_request("pwd")).unwrap();
    assert!(!spec
        .env
        .iter()
        .any(|(k, _)| k.eq_ignore_ascii_case("CHERE_INVOKING")));
    // 用户显式给出的同名变量优先，不重复注入
    let mut req = command_request("pwd");
    req.env.insert("chere_invoking".into(), "0".into());
    let spec = spec_for(&msys, &req).unwrap();
    let matches: Vec<_> = spec
        .env
        .iter()
        .filter(|(k, _)| k.eq_ignore_ascii_case("CHERE_INVOKING"))
        .collect();
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].1, "0");
}

#[test]
fn msys_path_conversion() {
    #[cfg(windows)]
    {
        assert_eq!(to_msys_path(Path::new(r"E:\a b\c.sh")), "/e/a b/c.sh");
        assert_eq!(
            to_msys_path(Path::new(r"\\server\share\x")),
            "//server/share/x"
        );
    }
}

// ---------- 真实本机进程集成（按 shell 可用性跳过） ----------

struct Collected {
    events: Vec<Event>,
}

fn collect() -> (Arc<Mutex<Collected>>, impl FnMut(Event)) {
    let collected = Arc::new(Mutex::new(Collected { events: Vec::new() }));
    let sink = collected.clone();
    (collected, move |event| {
        sink.lock().unwrap().events.push(event)
    })
}

fn output_text(collected: &Collected) -> String {
    let mut data = Vec::new();
    for event in &collected.events {
        if let Event::Output { data: d, .. } = event {
            data.extend_from_slice(d);
        }
    }
    String::from_utf8_lossy(&data).into_owned()
}

fn output_by_stream(collected: &Collected, want: OutputStream) -> String {
    let mut data = Vec::new();
    for event in &collected.events {
        if let Event::Output { stream, data: d } = event {
            if *stream == want {
                data.extend_from_slice(d);
            }
        }
    }
    String::from_utf8_lossy(&data).into_owned()
}

fn available(id: &str) -> Option<LocalConfig> {
    shells::resolve(&LocalConfig {
        shell: id.into(),
        path: None,
    })
    .ok()
    .map(|_| LocalConfig {
        shell: id.into(),
        path: None,
    })
}

fn fallback_id() -> &'static str {
    if cfg!(windows) {
        "cmd"
    } else {
        "sh"
    }
}

/// 平台相关的命令文本：(cmd, posix)
fn per_shell(shell_id: &str, for_cmd: &str, for_posix: &str, for_pwsh: &str) -> Option<String> {
    let shell = shells::resolve(&LocalConfig {
        shell: shell_id.into(),
        path: None,
    })
    .ok()?;
    Some(
        match shell.flavor {
            Flavor::Cmd => for_cmd,
            Flavor::Posix => for_posix,
            Flavor::PowerShell => for_pwsh,
        }
        .to_string(),
    )
}

async fn run_to_finish(config: &LocalConfig, req: &RunRequest) -> (Outcome, Collected) {
    let (collected, emit) = collect();
    let (_tx, mut rx) = mpsc::unbounded_channel();
    let outcome = execute(config, req, &mut rx, emit).await.unwrap();
    let guard = collected.lock().unwrap();
    let events = guard
        .events
        .iter()
        .map(|event| match event {
            Event::State(state) => Event::State(*state),
            Event::Output { stream, data } => Event::Output {
                stream: *stream,
                data: data.clone(),
            },
        })
        .collect();
    drop(guard);
    (outcome, Collected { events })
}

#[tokio::test]
async fn command_echo_exit_code_and_streams_pipe() {
    let Some(config) = available(fallback_id()) else {
        eprintln!("SKIP: no fallback shell");
        return;
    };
    let command = per_shell(
        fallback_id(),
        "echo hello-local & echo oops 1>&2 & exit 7",
        "echo hello-local; echo oops 1>&2; exit 7",
        "echo hello-local; [Console]::Error.WriteLine('oops'); exit 7",
    )
    .unwrap();
    let mut req = command_request(&command);
    req.console_mode = ConsoleMode::Pipe;
    let (outcome, collected) = run_to_finish(&config, &req).await;
    assert_eq!(outcome.code, Some(7));
    assert_eq!(outcome.stopped, None);
    assert!(output_by_stream(&collected, OutputStream::Stdout).contains("hello-local"));
    assert!(output_by_stream(&collected, OutputStream::Stderr).contains("oops"));
}

#[tokio::test]
async fn command_echo_pty_merges_output() {
    let Some(config) = available(fallback_id()) else {
        eprintln!("SKIP: no fallback shell");
        return;
    };
    let command = per_shell(
        fallback_id(),
        "echo hello-pty",
        "echo hello-pty",
        "echo hello-pty",
    )
    .unwrap();
    let mut req = command_request(&command);
    req.console_mode = ConsoleMode::Pty;
    let (outcome, collected) = run_to_finish(&config, &req).await;
    assert_eq!(outcome.code, Some(0));
    assert!(output_text(&collected).contains("hello-pty"));
}

#[tokio::test]
async fn pipe_stdin_reaches_the_workload() {
    let Some(config) = available(fallback_id()) else {
        eprintln!("SKIP: no fallback shell");
        return;
    };
    // 用退出码证明 stdin 被读取：读到一行 → exit 42，否则 → 41/其它。
    // cmd 不能用内嵌双引号（CRT 转义破坏，见设计文档边界），用 `if defined` 避开变量展开时机问题。
    let command = per_shell(
        fallback_id(),
        "set /p v=& if defined v (exit 42) else (exit 41)",
        "read v && exit 42",
        "$v=[Console]::In.ReadLine(); if ($null -ne $v) { exit 42 }",
    )
    .unwrap();
    let mut req = command_request(&command);
    req.console_mode = ConsoleMode::Pipe;
    let (_collected, emit) = collect();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let task = {
        let config = config.clone();
        let req = req.clone();
        tokio::spawn(async move { execute(&config, &req, &mut rx, emit).await.unwrap() })
    };
    // 启动完成前提交的输入也必须保留；并发启动较慢时不能静默丢失。
    tx.send(SessionControl::Input(b"input-value\n".to_vec()))
        .unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(20), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(outcome.code, Some(42));
}

#[tokio::test]
async fn user_stop_escalates_and_cancels_a_long_run() {
    let Some(config) = available(fallback_id()) else {
        eprintln!("SKIP: no fallback shell");
        return;
    };
    let command = per_shell(
        fallback_id(),
        "ping -n 60 127.0.0.1 >nul",
        "sleep 60",
        "Start-Sleep -Seconds 60",
    )
    .unwrap();
    let req = command_request(&command);
    let (_collected, emit) = collect();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let config2 = config.clone();
    let task = tokio::spawn(async move { execute(&config2, &req, &mut rx, emit).await.unwrap() });
    tokio::time::sleep(Duration::from_millis(500)).await;
    let started = std::time::Instant::now();
    tx.send(SessionControl::Interrupt).unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(20), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(outcome.stopped, Some(StopReason::User));
    assert!(
        started.elapsed() < Duration::from_secs(15),
        "stop escalation took too long"
    );
}

#[tokio::test]
async fn timeout_stops_a_long_run() {
    let Some(config) = available(fallback_id()) else {
        eprintln!("SKIP: no fallback shell");
        return;
    };
    let command = per_shell(
        fallback_id(),
        "ping -n 60 127.0.0.1 >nul",
        "sleep 60",
        "Start-Sleep -Seconds 60",
    )
    .unwrap();
    let mut req = command_request(&command);
    req.timeout_secs = 1;
    let started = std::time::Instant::now();
    let (outcome, _) = run_to_finish(&config, &req).await;
    assert_eq!(outcome.stopped, Some(StopReason::Timeout));
    assert!(started.elapsed() < Duration::from_secs(15));
}

#[tokio::test]
async fn every_detected_shell_runs_echo() {
    for info in shells::detect() {
        let config = LocalConfig {
            shell: info.id.clone(),
            path: None,
        };
        let marker = format!("local-{}", info.id);
        let Some(command) = per_shell(
            &info.id,
            &format!("echo {marker}"),
            &format!("echo {marker}"),
            &format!("echo {marker}"),
        ) else {
            continue;
        };
        let mut req = command_request(&command);
        req.console_mode = ConsoleMode::Pipe;
        let (outcome, collected) = run_to_finish(&config, &req).await;
        assert_eq!(outcome.code, Some(0), "shell {}", info.id);
        assert!(
            output_text(&collected).contains(&marker),
            "shell {} output: {}",
            info.id,
            output_text(&collected)
        );
    }
}

#[tokio::test]
async fn login_shells_keep_the_workspace_as_cwd() {
    // msys2/gitbash 的登录 profile 默认 cd $HOME；注入 CHERE_INVOKING 后 pwd 必须落在给定目录。
    // pwd 会按 /etc/fstab 挂载表化简路径（如 Temp → /tmp），用 msys 的 pwd -W 拿 Windows
    // 形式再比较；大小写与斜杠方向归一化。注册表里 login shell 只有 msys2/gitbash（Windows）。
    let dir = std::env::temp_dir().join(format!("rr-cwd-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let expected = dir
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    let mut tested = 0;
    for info in shells::detect() {
        let config = LocalConfig {
            shell: info.id.clone(),
            path: None,
        };
        let Ok(shell) = shells::resolve(&config) else {
            continue;
        };
        if !shell.login {
            continue;
        }
        let mut req = command_request("pwd -W");
        req.workspace_dir = Some(dir.to_string_lossy().into_owned());
        req.console_mode = ConsoleMode::Pipe;
        let (outcome, collected) = run_to_finish(&config, &req).await;
        assert_eq!(outcome.code, Some(0), "shell {}", info.id);
        let output = output_text(&collected);
        let actual = output.trim().replace('\\', "/").to_ascii_lowercase();
        assert!(
            actual.contains(&expected),
            "shell {} lost the spawn cwd; expected {} in output: {}",
            info.id,
            expected,
            output
        );
        tested += 1;
    }
    std::fs::remove_dir_all(&dir).ok();
    if tested == 0 {
        eprintln!("SKIP: no login shell detected");
    }
}

#[tokio::test]
async fn pty_resize_and_ctrl_c_reach_the_workload() {
    let Some(config) = available(fallback_id()) else {
        eprintln!("SKIP: no fallback shell");
        return;
    };
    let command = per_shell(
        fallback_id(),
        "ping -n 60 127.0.0.1",
        "sleep 60",
        "Start-Sleep -Seconds 60",
    )
    .unwrap();
    let mut req = command_request(&command);
    req.console_mode = ConsoleMode::Pty;
    let (_collected, emit) = collect();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let config2 = config.clone();
    let task = tokio::spawn(async move { execute(&config2, &req, &mut rx, emit).await.unwrap() });
    tokio::time::sleep(Duration::from_millis(800)).await;
    tx.send(SessionControl::Resize {
        cols: 100,
        rows: 30,
    })
    .unwrap();
    tx.send(SessionControl::Interrupt).unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(20), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(outcome.stopped, Some(StopReason::User));
}

#[tokio::test]
async fn test_device_reports_shell_version() {
    let Some(config) = available(fallback_id()) else {
        eprintln!("SKIP: no fallback shell");
        return;
    };
    let info = test_device(&config).await.unwrap();
    assert!(info.starts_with("Local "), "{info}");
    assert!(!info.trim_end().ends_with(')'), "{info}");
}
