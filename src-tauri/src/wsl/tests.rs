use super::*;
use crate::device::{DeviceProfile, TransportKind};
use std::path::PathBuf;

fn request(command: &str) -> RunRequest {
    serde_json::from_value(
        json!({"device_id":"test", "kind":"command", "command":command, "console_mode":"pipe"}),
    )
    .unwrap()
}

fn temporary() -> PathBuf {
    let root = std::env::temp_dir().join(format!("rr-wsl-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

#[test]
fn profiles_require_only_wsl_target_and_reject_invalid_arguments() {
    let mut device: DeviceProfile =
        serde_json::from_value(json!({"id":"wsl", "name":"Ubuntu", "transport":"wsl",
        "wsl":{"distribution":"Ubuntu-24.04"}}))
        .unwrap();
    assert_eq!(device.transport, TransportKind::Wsl);
    assert!(device.host.is_empty());
    device.validate().unwrap();
    for invalid in ["", "--shutdown", "Ubuntu\n", " Ubuntu", "Ubuntu\0"] {
        device.wsl.as_mut().unwrap().distribution = invalid.into();
        assert!(device.validate().is_err(), "{invalid:?}");
    }
    device.wsl.as_mut().unwrap().distribution = "Ubuntu-24.04".into();
    device.wsl.as_mut().unwrap().user = "--root".into();
    assert!(device.validate().is_err());
    device.wsl = None;
    assert!(device.validate().is_err());
    let old: DeviceProfile = serde_json::from_value(
        json!({"id":"old", "name":"SSH", "host":"localhost", "username":"user"}),
    )
    .unwrap();
    old.validate().unwrap();
    assert!(old.wsl.is_none());
}

#[test]
fn distribution_output_accepts_utf16_and_utf8() {
    let text = "Ubuntu-24.04\r\n发行版\r\n";
    let utf16: Vec<_> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
    assert_eq!(decode_wsl_text(&utf16), text);
    assert_eq!(decode_wsl_text(text.as_bytes()), text);
}

#[test]
fn workspace_snapshot_preserves_binary_empty_dirs_and_literal_names() {
    let root = temporary();
    std::fs::create_dir(root.join("空目录")).unwrap();
    std::fs::write(root.join("literal ' $.sh"), b"printf hi\r\n").unwrap();
    std::fs::write(root.join("data.bin"), b"\xff\0\r\n").unwrap();
    let entries = filesync::collect(&root).unwrap();
    assert_eq!(entries.len(), 3);
    assert!(entries
        .iter()
        .any(|e| e.path == "空目录" && e.data.is_none()));
    assert_eq!(
        entries
            .iter()
            .find(|e| e.path.ends_with(".sh"))
            .unwrap()
            .data
            .as_deref(),
        Some(b"printf hi\n".as_slice())
    );
    assert_eq!(
        entries
            .iter()
            .find(|e| e.path == "data.bin")
            .unwrap()
            .data
            .as_deref(),
        Some(b"\xff\0\r\n".as_slice())
    );
    std::fs::File::create(root.join("huge"))
        .unwrap()
        .set_len(filesync::FILE_LIMIT + 1)
        .unwrap();
    assert!(filesync::collect(&root).is_err());
    std::fs::remove_dir_all(root).unwrap();
}

// Normal Windows CI has no WSL requirement. Opt in with an explicit distribution:
// REMOTE_RUNNER_TEST_WSL=Ubuntu-24.04 cargo test --offline wsl::tests -- --include-ignored
fn python(code: &str) -> Command {
    #[cfg(windows)]
    let mut command = {
        let distribution = std::env::var("REMOTE_RUNNER_TEST_WSL")
            .expect("set REMOTE_RUNNER_TEST_WSL to an installed test distribution");
        let mut command = wsl_command().unwrap();
        command.args([
            "--distribution",
            &distribution,
            "--cd",
            "~",
            "--exec",
            "python3",
        ]);
        command
    };
    #[cfg(not(windows))]
    let mut command = Command::new("python3");
    command.args(["-I", "-u", "-c", code]);
    command
}

async fn terminal_output(
    rx: &mut mpsc::UnboundedReceiver<crate::terminal::Event>,
    expected: &str,
) -> String {
    tokio::time::timeout(Duration::from_secs(15), async {
        let mut text = String::new();
        while let Some(event) = rx.recv().await {
            if let crate::terminal::Event::Output(data) = event {
                text.push_str(&String::from_utf8_lossy(&data));
                if text.contains(expected) {
                    return text;
                }
            }
        }
        panic!("terminal closed before {expected:?}: {text:?}");
    })
    .await
    .unwrap_or_else(|_| panic!("terminal did not print {expected:?}"))
}

#[tokio::test]
#[cfg_attr(
    windows,
    ignore = "requires an explicitly selected local WSL distribution"
)]
async fn terminal_shell_preserves_state_ctrl_c_resize_and_exit() {
    use crate::terminal::{Control, Event as TE};
    let (tx, mut controls) = mpsc::channel(32);
    let (_cancel, mut cancel) = tokio::sync::watch::channel(false);
    let (events, mut rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        terminal::execute_with_command(
            python(HELPER),
            80,
            24,
            None,
            &mut controls,
            &mut cancel,
            |event| {
                events.send(event).unwrap();
                Ok(())
            },
        )
        .await
    });
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(30), rx.recv())
            .await
            .unwrap(),
        Some(TE::Connected)
    ));
    // Split markers in source so echoed commands cannot satisfy output assertions.
    tx.send(Control::Input(
        b"stty -echo; PS1=''; cd /tmp; export RR_TERMINAL_TEST=kept; printf '__RR_%s__\\n' ready\n"
            .to_vec(),
    ))
    .await
    .unwrap();
    terminal_output(&mut rx, "__RR_ready__").await;
    tx.send(Control::Resize {
        cols: 113,
        rows: 37,
    })
    .await
    .unwrap();
    tx.send(Control::Input(b"printf '__RR_STATE:%s:%s__\\n' \"$PWD\" \"$RR_TERMINAL_TEST\"; stty size; printf '__RR_%s__\\n' sized\n".to_vec())).await.unwrap();
    let output = terminal_output(&mut rx, "__RR_sized__").await;
    assert!(output.contains("__RR_STATE:/tmp:kept__"), "{output}");
    assert!(output.contains("37 113"), "{output}");
    tx.send(Control::Input(
        b"printf '__RR_%s__\\n' sleeping; sleep 60\n".to_vec(),
    ))
    .await
    .unwrap();
    terminal_output(&mut rx, "__RR_sleeping__").await;
    tokio::time::sleep(Duration::from_millis(150)).await;
    tx.send(Control::Input(vec![3])).await.unwrap();
    tx.send(Control::Input(b"printf '__RR_%s__\\n' survived\n".to_vec()))
        .await
        .unwrap();
    terminal_output(&mut rx, "__RR_survived__").await;
    tx.send(Control::Input(b"exit 7\n".to_vec())).await.unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(10), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        Some(7)
    );
}

#[tokio::test]
#[cfg_attr(
    windows,
    ignore = "requires an explicitly selected local WSL distribution"
)]
async fn terminal_close_cleans_job_control_groups_and_other_sessions_survive() {
    use crate::terminal::{Control, Event as TE};
    let (tx, mut controls) = mpsc::channel(32);
    let (cancel_tx, mut cancel) = tokio::sync::watch::channel(false);
    let (events, mut rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        terminal::execute_with_command(
            python(HELPER),
            80,
            24,
            None,
            &mut controls,
            &mut cancel,
            |event| {
                events.send(event).unwrap();
                Ok(())
            },
        )
        .await
    });
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(30), rx.recv())
            .await
            .unwrap(),
        Some(TE::Connected)
    ));
    tx.send(Control::Input(
        b"stty -echo; PS1=''; printf '__RR_%s__\\n' ready\n".to_vec(),
    ))
    .await
    .unwrap();
    terminal_output(&mut rx, "__RR_ready__").await;
    // A second helper is a separate session and must remain usable.
    let mut other = Bridge::launch(python(HELPER)).await.unwrap();
    other
        .request(
            json!({"type":"init", "terminal":true, "mode":"pty", "cols":80,"rows":24,"timeout":0}),
        )
        .await
        .unwrap();
    other.send(json!({"type":"start"})).await.unwrap();
    assert!(matches!(other.next().await.unwrap(), Message::Started));
    tx.send(Control::Input(
        b"sleep 60 & printf '__RR_%s:%s__\\n' SID \"$$\"; printf '__RR_%s__\\n' jobs; sleep 60\n"
            .to_vec(),
    ))
    .await
    .unwrap();
    let output = terminal_output(&mut rx, "__RR_jobs__").await;
    let sid: u32 = output
        .split("__RR_SID:")
        .nth(1)
        .unwrap()
        .split("__")
        .next()
        .unwrap()
        .parse()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    cancel_tx.send(true).unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(12), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        None
    );
    // Check the child's entire session, including foreground/background groups, excluding reaped zombies.
    let probe = format!("import os\nalive=[]\nfor n in os.listdir('/proc'):\n if n.isdigit():\n  try:\n   if os.getsid(int(n)) == {sid} and open('/proc/'+n+'/stat').read().rsplit(')',1)[1].split()[0] != 'Z': alive.append(n)\n  except (ProcessLookupError,FileNotFoundError): pass\nassert not alive, alive\n");
    assert!(python(&probe).output().await.unwrap().status.success());
    other
        .send(json!({"type":"input", "data":STANDARD.encode(b"exit 9\n")}))
        .await
        .unwrap();
    let code = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Message::Exit { code, .. } = other.next().await.unwrap() {
                break code;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(code, Some(9));
    other.wait().await.unwrap();
}

#[tokio::test]
#[cfg_attr(
    windows,
    ignore = "requires an explicitly selected local WSL distribution"
)]
async fn terminal_eof_is_failure_and_cancel_before_launch_starts_nothing() {
    let (_tx, mut controls) = mpsc::channel(32);
    let (_cancel_tx, mut cancel) = tokio::sync::watch::channel(false);
    let fake = "import json,sys\nprint(json.dumps({'type':'ready','version':1,'info':'fake'}),flush=True)\nsys.stdin.readline()\nprint(json.dumps({'type':'ack'}),flush=True)\nsys.stdin.readline()\nprint(json.dumps({'type':'started'}),flush=True)\n";
    assert!(terminal::execute_with_command(
        python(fake),
        80,
        24,
        None,
        &mut controls,
        &mut cancel,
        |_| Ok(())
    )
    .await
    .is_err());
    let (_cancel_tx, mut cancel) = tokio::sync::watch::channel(true);
    let result = terminal::execute_with_command(
        Command::new("must-not-exist-terminal-test"),
        80,
        24,
        None,
        &mut controls,
        &mut cancel,
        |_| panic!("must not start"),
    )
    .await
    .unwrap();
    assert_eq!(result, None);
}

async fn run(
    req: &RunRequest,
    on_event: impl FnMut(Event),
    controls: &mut mpsc::UnboundedReceiver<SessionControl>,
) -> Result<Outcome> {
    tokio::time::timeout(
        Duration::from_secs(20),
        execute_with_command(
            python(HELPER),
            req,
            "/unused",
            false,
            Vec::new(),
            controls,
            on_event,
            None,
        ),
    )
    .await
    .expect("WSL test timed out")
}

#[tokio::test]
#[cfg_attr(
    windows,
    ignore = "requires an explicitly selected local WSL distribution"
)]
async fn pipe_preserves_binary_streams_and_nonzero_exit() {
    let req = request("python3 -c 'import os; os.write(1,bytes([255,0,13,10])*20000); os.write(2,b\"error\\n\")'; exit 7");
    let (_tx, mut rx) = mpsc::unbounded_channel();
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let result = run(
        &req,
        |event| {
            if let Event::Output { stream, data } = event {
                match stream {
                    OutputStream::Stdout => stdout.extend(data),
                    OutputStream::Stderr => stderr.extend(data),
                }
            }
        },
        &mut rx,
    )
    .await
    .unwrap();
    assert_eq!(stdout, b"\xff\0\r\n".repeat(20000));
    assert_eq!(stderr, b"error\n");
    assert_eq!(result.code, Some(7));
    assert_eq!(result.stopped, None);
}

#[tokio::test]
#[cfg_attr(
    windows,
    ignore = "requires an explicitly selected local WSL distribution"
)]
async fn pty_supports_input_and_live_resize() {
    let mut req = request("python3 -u -c 'import os,sys; print(\"TTY\",sys.stdin.isatty()); text=input(); print(\"GOT\",text,os.get_terminal_size().columns)' ");
    req.console_mode = crate::process::ConsoleMode::Pty;
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut output = Vec::new();
    let mut sent = false;
    let result = run(
        &req,
        |event| {
            if let Event::Output { data, .. } = event {
                output.extend(data);
                if !sent && String::from_utf8_lossy(&output).contains("TTY True") {
                    sent = true;
                    tx.send(SessionControl::Resize {
                        cols: 101,
                        rows: 33,
                    })
                    .unwrap();
                    tx.send(SessionControl::Input(b"hello WSL\n".to_vec()))
                        .unwrap();
                }
            }
        },
        &mut rx,
    )
    .await
    .unwrap();
    assert_eq!(result.code, Some(0));
    assert!(
        String::from_utf8_lossy(&output).contains("GOT hello WSL 101"),
        "{:?}",
        String::from_utf8_lossy(&output)
    );
}

#[tokio::test]
#[cfg_attr(
    windows,
    ignore = "requires an explicitly selected local WSL distribution"
)]
async fn stop_and_timeout_escalate_for_uncooperative_process_groups() {
    for timeout in [false, true] {
        let mut req = request("exec python3 -u -c 'import signal,time; signal.signal(signal.SIGINT,signal.SIG_IGN); signal.signal(signal.SIGTERM,signal.SIG_IGN); print(\"READY\"); time.sleep(60)'");
        req.timeout_secs = u64::from(timeout);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut output = Vec::new();
        let mut sent = false;
        let result = run(
            &req,
            |event| {
                if let Event::Output { data, .. } = event {
                    output.extend(data);
                    if !timeout && !sent && String::from_utf8_lossy(&output).contains("READY") {
                        sent = true;
                        tx.send(SessionControl::Interrupt).unwrap();
                    }
                }
            },
            &mut rx,
        )
        .await
        .unwrap();
        assert_eq!(result.code, Some(137));
        assert_eq!(
            result.stopped,
            Some(if timeout {
                StopReason::Timeout
            } else {
                StopReason::User
            })
        );
    }
}

#[tokio::test]
#[cfg_attr(
    windows,
    ignore = "requires an explicitly selected local WSL distribution"
)]
async fn upload_is_literal_and_rejects_existing_or_redirected_destinations() {
    let remote = format!("/tmp/rr-wsl-test-{}", uuid::Uuid::new_v4());
    let root = temporary();
    let payload = b"\xff\0\r\n$(touch SHOULD_NOT_EXIST)".repeat(10000);
    std::fs::write(root.join("literal ' $.bin"), &payload).unwrap();
    std::fs::create_dir(root.join("empty")).unwrap();
    let mut req = request("python3 -c 'import pathlib,hashlib; print(hashlib.sha256(next(pathlib.Path(\".\").glob(\"*.bin\")).read_bytes()).hexdigest()); print(pathlib.Path(\"empty\").is_dir())'");
    req.workspace = Some(crate::workspace_ref::WorkspaceRef::local(
        root.to_string_lossy().into_owned(),
    ));
    let (_tx, mut rx) = mpsc::unbounded_channel();
    let mut output = Vec::new();
    let result = execute_with_command(
        python(HELPER),
        &req,
        &remote,
        false,
        filesync::collect(&root).unwrap(),
        &mut rx,
        |event| {
            if let Event::Output { data, .. } = event {
                output.extend(data);
            }
        },
        None,
    )
    .await
    .unwrap();
    assert_eq!(result.code, Some(0));
    use sha2::Digest;
    assert!(
        String::from_utf8_lossy(&output).contains(&format!("{:x}", sha2::Sha256::digest(&payload)))
    );
    assert!(String::from_utf8_lossy(&output).contains("True"));
    // Reusing an existing run directory is forbidden.
    assert!(execute_with_command(
        python(HELPER),
        &req,
        &remote,
        false,
        Vec::new(),
        &mut rx,
        |_| {},
        None
    )
    .await
    .is_err());
    let anchor = format!("{remote}-anchor");
    let setup = format!("import os; os.mkdir({anchor:?}); os.mkdir({anchor:?} + '/target'); os.symlink('target', {anchor:?} + '/link')");
    assert!(python(&setup).status().await.unwrap().success());
    assert!(execute_with_command(
        python(HELPER),
        &req,
        &format!("{anchor}/link/run"),
        false,
        Vec::new(),
        &mut rx,
        |_| {},
        None,
    )
    .await
    .is_err());
    let check = format!("import os,shutil; assert not os.listdir({anchor:?} + '/target'); shutil.rmtree({anchor:?})");
    assert!(python(&check).status().await.unwrap().success());
    let cleanup = format!("import shutil; shutil.rmtree({remote:?})");
    assert!(python(&cleanup).status().await.unwrap().success());
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
#[cfg_attr(
    windows,
    ignore = "requires an explicitly selected local WSL distribution"
)]
async fn eof_without_completion_is_failure_and_prelaunch_stop_executes_nothing() {
    let (_tx, mut rx) = mpsc::unbounded_channel();
    let result = execute_with_command(
        python("print('{\"type\":\"ready\",\"version\":1,\"info\":\"test\"}')"),
        &request("true"),
        "/unused",
        false,
        Vec::new(),
        &mut rx,
        |_| {},
        None,
    )
    .await;
    assert!(result.is_err());
    let (tx, mut rx) = mpsc::unbounded_channel();
    tx.send(SessionControl::Interrupt).unwrap();
    let result = run(
        &request("exit 99"),
        |_| panic!("stopped before launch"),
        &mut rx,
    )
    .await
    .unwrap();
    assert_eq!(result.stopped, Some(StopReason::User));
    assert_eq!(result.code, None);
}

#[tokio::test]
#[cfg_attr(
    windows,
    ignore = "requires an explicitly selected local WSL distribution"
)]
async fn dropping_connection_kills_its_workload() {
    let mut bridge = Bridge::launch(python(HELPER)).await.unwrap();
    bridge
        .request(
            json!({"type":"init", "remote":null, "mode":"pipe", "cols":80, "rows":24, "timeout":0,
        "command":"exec python3 -u -c 'import os,time; print(os.getpid()); time.sleep(60)'"}),
        )
        .await
        .unwrap();
    bridge.send(json!({"type":"start"})).await.unwrap();
    let mut output = Vec::new();
    let pid: u32 = loop {
        match bridge.next().await.unwrap() {
            Message::Started => {}
            Message::Output { data, .. } => {
                output.extend(STANDARD.decode(data).unwrap());
                if output.contains(&b'\n') {
                    break String::from_utf8(output).unwrap().trim().parse().unwrap();
                }
            }
            other => panic!("unexpected response: {other:?}"),
        }
    };
    drop(bridge);
    // The Windows launcher must release the helper's control pipe when dropped.
    let check = format!("import os,time\nfor _ in range(60):\n try: os.kill({pid},0)\n except ProcessLookupError: break\n time.sleep(0.05)\nelse: raise RuntimeError('workload survived control disconnect')");
    assert!(python(&check).status().await.unwrap().success());
}

#[cfg(windows)]
#[tokio::test]
#[ignore = "requires an explicitly selected local WSL distribution"]
async fn run_manager_records_wsl_output_and_history_without_ssh() {
    use crate::runner::{RunEvent, RunManager};
    let root = temporary();
    let distribution = std::env::var("REMOTE_RUNNER_TEST_WSL").unwrap();
    let device: DeviceProfile = serde_json::from_value(json!({"id":"test", "name":"WSL test", "transport":"wsl", "wsl":{"distribution":distribution}})).unwrap();
    assert!(list_distributions().await.unwrap().contains(&distribution));
    assert!(test_device(device.wsl.as_ref().unwrap())
        .await
        .unwrap()
        .contains("Python"));
    let (tx, mut rx) = crate::events::channel();
    let manager = RunManager::new(&root, tx);
    let id = manager
        .start(
            request("printf 'WSL_DIRECT_OK'; exit 3"),
            device,
            root.clone(),
            None,
        )
        .unwrap();
    let mut output = Vec::new();
    tokio::time::timeout(Duration::from_secs(20), async {
        while let Ok(event) = rx.recv().await {
            match event {
                RunEvent::Output { data, .. } => output.extend(STANDARD.decode(data).unwrap()),
                RunEvent::Status { status } if status.ended_at.is_some() => {
                    assert_eq!(status.state, RunState::Exited, "{:?}", status.error);
                    assert_eq!(status.exit_code, Some(3));
                    break;
                }
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(output, b"WSL_DIRECT_OK");
    assert_eq!(manager.history()[0].run_id, id);
    assert!(manager.list_running().is_empty());
    let (tx, _) = crate::events::channel();
    assert_eq!(RunManager::new(&root, tx).history()[0].run_id, id);
    std::fs::remove_dir_all(root).unwrap();
}

/// helper 发出的每一条消息都必须能被 Rust 侧反序列化。
/// serde 的 `rename_all = "lowercase"` 不会插入下划线（`ExecExit` → `execexit`），
/// 多词变体必须显式 rename —— 否则 helper 的 `exec_exit` 会被静默当成未知消息。
/// 这不依赖 WSL 发行版，因此在所有平台上都运行。
#[test]
fn helper_message_names_round_trip_through_the_rust_protocol() {
    fn variant(message: &Message) -> &'static str {
        match message {
            Message::Ready { .. } => "ready",
            Message::Ack => "ack",
            Message::Started => "started",
            Message::Output { .. } => "output",
            Message::ExecExit { .. } => "exec_exit",
            Message::Exit { .. } => "exit",
            Message::Error { .. } => "error",
            Message::FsEntry { .. } => "fs_entry",
            Message::FsFile { .. } => "fs_file",
            Message::FsChunk { .. } => "fs_chunk",
            Message::FsDone => "fs_done",
            Message::FsSaved { .. } => "fs_saved",
            Message::FsError { .. } => "fs_error",
        }
    }
    let cases = [
        (json!({"type":"ready","version":1,"info":"helper"}), "ready"),
        (json!({"type":"ack"}), "ack"),
        (json!({"type":"started"}), "started"),
        (
            json!({"type":"output","stream":"stdout","data":""}),
            "output",
        ),
        (json!({"type":"exec_exit","code":7}), "exec_exit"),
        (json!({"type":"exit","code":0}), "exit"),
        (json!({"type":"error","message":"boom"}), "error"),
        (
            json!({"type":"fs_entry","name":"a.py","dir":false,"link":false}),
            "fs_entry",
        ),
        (json!({"type":"fs_file","revision":"r","size":3}), "fs_file"),
        (json!({"type":"fs_chunk","data":""}), "fs_chunk"),
        (json!({"type":"fs_done"}), "fs_done"),
        (json!({"type":"fs_saved","revision":"r"}), "fs_saved"),
        (
            json!({"type":"fs_error","code":"not_found","message":"gone"}),
            "fs_error",
        ),
    ];
    for (value, expected) in cases {
        let text = value.to_string();
        let parsed: Message = serde_json::from_value(value)
            .unwrap_or_else(|e| panic!("helper message {text} is not understood by Rust: {e}"));
        assert_eq!(variant(&parsed), expected, "wrong variant for {text}");
    }
    // 派生名（缺下划线）不是合法协议名：误加 rename_all 会立刻被这条断言挡住
    assert!(serde_json::from_value::<Message>(json!({"type":"execexit","code":0})).is_err());
    assert!(
        serde_json::from_value::<Message>(json!({"type":"fserror","code":"io","message":"x"}))
            .is_err()
    );
}

/// 执行结束标记必须携带退出码，否则会被当成未知消息
#[test]
fn exec_exit_carries_the_exit_code() {
    let parsed: Message = serde_json::from_value(json!({"type":"exec_exit","code":3})).unwrap();
    assert!(matches!(parsed, Message::ExecExit { code: Some(3) }));
    let parsed: Message = serde_json::from_value(json!({"type":"exec_exit","code":null})).unwrap();
    assert!(matches!(parsed, Message::ExecExit { code: None }));
}

/// Rust 侧发送的 fs_* 请求也必须与 helper 接受的名字一致
#[test]
fn rust_fs_requests_use_the_names_the_helper_accepts() {
    let sent = [
        json!({"type":"fs_open","path":"/srv"}),
        json!({"type":"fs_list","path":""}),
        json!({"type":"fs_read","path":"a.py","limit":1}),
        json!({"type":"fs_write","path":"a.py","expected":"r"}),
        json!({"type":"fs_wchunk","data":""}),
        json!({"type":"fs_wdone"}),
        json!({"type":"fs_create","path":"a.py","kind":"file"}),
        json!({"type":"fs_rename","from":"a.py","to":"b.py"}),
        json!({"type":"fs_delete","path":"a.py"}),
    ];
    let helper = include_str!("helper.py");
    for message in sent {
        let name = message["type"].as_str().unwrap();
        assert!(
            helper.contains(&format!("\"{name}\"")),
            "helper does not handle the `{name}` request"
        );
    }
}

/// Windows 的命令行上限是 32767 字符：helper 源码一旦作为 `-c` 参数传递，
/// 脚本变大就会让 CreateProcess 直接失败（os error 206，且错误信息看起来
/// 像「没有安装发行版」）。这里锁住「脚本走 stdin、命令行保持精简」的契约。
#[test]
fn helper_source_travels_over_stdin_and_keeps_the_command_line_short() {
    let config = WslConfig {
        distribution: "Ubuntu-24.04".into(),
        user: "root".into(),
    };
    let helper = helper_command(&config).unwrap();
    let args: Vec<String> = helper
        .command
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let command_line = args.join(" ");
    assert!(
        command_line.len() < 1024,
        "helper command line must stay far below the Windows limit: {} chars",
        command_line.len()
    );
    assert!(
        !command_line.contains("def main"),
        "the helper source must not be passed as an argument"
    );
    // 载荷是完整 helper 源码的 base64：引导程序首行读到的就是它
    let payload = helper.payload.expect("helper source payload");
    assert_eq!(
        String::from_utf8(STANDARD.decode(&payload).unwrap()).unwrap(),
        HELPER
    );
    // 引导程序本身保持极短，且只依赖 os（-I 隔离下没有三方模块）
    assert!(BOOTSTRAP.len() < 256, "bootstrap must stay tiny");
    assert!(BOOTSTRAP.contains("os.read(0,65536)"));
}

/// 在宿主 python 上直接跑真实的 `BOOTSTRAP`：把一段假 helper 源码作为载荷
/// 经 stdin 下发，验证「首行即载荷」的引导契约能被真正执行。
/// 载荷按 helper 的量级构造（远超管道缓冲），因此也覆盖分块读取不丢字节。
/// 没有宿主 python 时跳过（与缺 shell 时的本机测试同样的处理）。
#[tokio::test]
async fn bootstrap_reads_the_helper_source_from_stdin() {
    let Some(python) = host_python() else {
        eprintln!("skipping: no host python3 on PATH");
        return;
    };
    // 真实 helper.py 的 base64 载荷约 46 KiB，超过管道缓冲：这里用同等量级
    let padding = "x".repeat(200_000);
    let source = format!(
        "# {padding}
import json,sys
print(json.dumps({{\"type\":\"ready\",\"version\":1,\"info\":str({})}}),flush=True)
sys.stdin.readline()
print(json.dumps({{\"type\":\"ack\"}}),flush=True)
",
        padding.len()
    );
    let mut command = Command::new(python);
    command.args(["-I", "-u", "-c", BOOTSTRAP]);
    let mut bridge = Bridge::launch(HelperCommand::with_payload(command, &source))
        .await
        .expect("the bootstrap must hand the payload to python");
    // 长度一致说明跨多次读取/写入后载荷仍然完整
    assert_eq!(bridge.info, padding.len().to_string());
    bridge.send(json!({"type": "start"})).await.unwrap();
    assert!(matches!(bridge.next().await.unwrap(), Message::Ack));
    assert!(bridge.wait().await.is_ok());
}

/// 宿主解释器：优先 python3，其次 python（Windows 上常只有后者）
fn host_python() -> Option<String> {
    ["python3", "python"]
        .into_iter()
        .find(|name| {
            std::process::Command::new(name)
                .arg("-c")
                .arg("import sys")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
        })
        .map(str::to_string)
}
