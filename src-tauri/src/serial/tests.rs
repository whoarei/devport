use crate::process::SessionControl;
use crate::runner::RunRequest;
use crate::serial::{
    self,
    session::{ShellSession, StopReason},
};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::sync::mpsc;

fn local_shell() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    let path = std::path::PathBuf::from("C:/Program Files/Git/bin/bash.exe");
    #[cfg(not(windows))]
    let path = std::path::PathBuf::from("/bin/sh");
    path.is_file().then_some(path)
}

#[test]
fn real_local_shell_validates_wrapper_quoting_and_exit_trap() {
    let Some(shell) = local_shell() else {
        eprintln!("local POSIX shell unavailable; skipping shell smoke test");
        return;
    };
    let command = serial::protocol::wrap(
        r#"printf '%s' "quote ' and literal \$()"; exit 7"#,
        "test",
        None,
    );
    let result = std::process::Command::new(shell)
        .arg("-c")
        .arg(command)
        .output()
        .unwrap();
    let mut parser = serial::protocol::FrameParser::new("test");
    let output = parser.push(&result.stdout).unwrap();
    assert_eq!(
        parser.code,
        Some(7),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(output, b"quote ' and literal $()");
}

#[test]
fn real_local_shell_delivers_interrupt_to_the_wrapped_command() {
    let Some(shell) = local_shell() else {
        eprintln!("local POSIX shell unavailable; skipping signal smoke test");
        return;
    };
    let command = serial::protocol::wrap("kill -INT $$", "signal", None);
    let result = std::process::Command::new(shell)
        .arg("-c")
        .arg(command)
        .output()
        .unwrap();
    let mut parser = serial::protocol::FrameParser::new("signal");
    assert!(parser.push(&result.stdout).unwrap().is_empty());
    assert_eq!(
        parser.code,
        Some(130),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn real_local_shell_upload_does_not_evaluate_file_content() {
    let Some(shell) = local_shell() else {
        eprintln!("local POSIX shell unavailable; skipping upload smoke test");
        return;
    };
    let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&root).unwrap();
    let file = serial::filesync::TextFile {
        relative: "a'b.py".into(),
        data: b"$(touch SHOULD_NOT_EXIST)\nRR_UPLOAD_EOF".to_vec(),
    };
    std::fs::write(root.join(&file.relative), vec![b'x'; 1000]).unwrap();
    let command = serial::protocol::wrap(
        &serial::filesync::upload_commands(&file, ".")
            .next()
            .unwrap(),
        "test",
        None,
    );
    let result = std::process::Command::new(shell)
        .current_dir(&root)
        .arg("-c")
        .arg(command)
        .output()
        .unwrap();
    let mut parser = serial::protocol::FrameParser::new("test");
    assert!(parser.push(&result.stdout).unwrap().is_empty());
    assert_eq!(
        parser.code,
        Some(0),
        "stderr={}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(std::fs::read(root.join("a'b.py")).unwrap(), file.data);
    assert!(!root.join("SHOULD_NOT_EXIST").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn large_upload_uses_bounded_arguments_and_preserves_all_bytes() {
    let Some(shell) = local_shell() else {
        return;
    };
    let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&root).unwrap();
    let file = serial::filesync::TextFile {
        relative: "large ' file.py".into(),
        data: b"literal $(touch SHOULD_NOT_EXIST)\n".repeat(8192),
    };
    // A script file avoids the *test host's* argv limit; each generated sh -c
    // invocation inside it still exercises the production wrapper and decoder.
    let mut script = String::from("set -e\n");
    let mut count = 0;
    for command in serial::filesync::upload_commands(&file, ".") {
        let wrapped = serial::protocol::wrap(&command, "large", None);
        serial::protocol::validate_wire_command(&wrapped).unwrap();
        assert!(wrapped.len() < 8192);
        script.push_str(&wrapped);
        count += 1;
    }
    assert!(count > 1);
    std::fs::write(root.join("upload.sh"), script).unwrap();
    let result = std::process::Command::new(shell)
        .current_dir(&root)
        .arg("upload.sh")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&result.stdout)
            .matches("\x1eRR_large_E:0\x1f")
            .count(),
        count
    );
    assert_eq!(std::fs::read(root.join(&file.relative)).unwrap(), file.data);
    assert!(!root.join("SHOULD_NOT_EXIST").exists());
    std::fs::remove_dir_all(root).unwrap();
}

// Consume a full shell command, including quoted multiline upload bodies.
async fn read_command(stream: &mut DuplexStream) -> (String, String) {
    let mut command = Vec::new();
    let mut quoted = false;
    let mut escaped = false;
    loop {
        let byte = stream.read_u8().await.unwrap();
        command.push(byte);
        if escaped {
            escaped = false;
            continue;
        }
        if !quoted && byte == b'\\' {
            escaped = true;
            continue;
        }
        if byte == b'\'' {
            quoted = !quoted;
        }
        if byte == b'\n' && !quoted {
            break;
        }
    }
    let command = String::from_utf8(command).unwrap();
    let nonce = command
        .split(|c: char| !c.is_ascii_hexdigit())
        .find(|s| s.len() == 32)
        .unwrap()
        .to_string();
    (command, nonce)
}

async fn begin(stream: &mut DuplexStream, nonce: &str) {
    stream
        .write_all(format!("\x1eRR_{nonce}_B\x1f").as_bytes())
        .await
        .unwrap();
}
async fn end(stream: &mut DuplexStream, nonce: &str, code: u32) {
    stream
        .write_all(format!("\x1eRR_{nonce}_E:{code}\x1froot@board# ").as_bytes())
        .await
        .unwrap();
}

#[tokio::test]
async fn workspace_python_checks_the_planned_lf_upload_and_rejects_later_metadata_changes() {
    use crate::workspace_ref::WorkspaceRef;
    use crate::workspace_run::{Context, Entry, Store};
    use sha2::{Digest, Sha256};
    for changed in [false, true] {
        let root = std::env::temp_dir().join(format!("rr-serial-crlf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("test.py"), "print('ok')\r\n").unwrap();
        std::fs::write(
            root.join("pyproject.toml"),
            "[project]\r\nname='original'\r\n",
        )
        .unwrap();
        let workspace = WorkspaceRef::local(root.to_string_lossy());
        let mut store = Store::open(&workspace, None, &root).await.unwrap();
        let inputs = store
            .inputs(
                &Entry::PythonScript {
                    path: "test.py".into(),
                },
                false,
                ".",
            )
            .await
            .unwrap();
        let raw_hash = inputs.hashes[0].1.clone();
        if changed {
            std::fs::write(
                root.join("pyproject.toml"),
                "[project]\r\nname='changed'\r\n",
            )
            .unwrap();
        }
        let files = serial::filesync::collect(&root).unwrap();
        let uploaded_hash = files
            .iter()
            .find_map(|entry| match entry {
                serial::filesync::UploadEntry::File(file) if file.relative == "pyproject.toml" => {
                    Some(format!("{:x}", Sha256::digest(&file.data)))
                }
                _ => None,
            })
            .unwrap();
        let upload_count = files
            .iter()
            .map(|file| file.commands("/tmp/workspace").count())
            .sum::<usize>();
        let (client, mut device) = tokio::io::duplex(4096);
        let fake = tokio::spawn(async move {
            for _ in 0..(2 + upload_count) {
                let (_, nonce) = read_command(&mut device).await;
                begin(&mut device, &nonce).await;
                end(&mut device, &nonce, 0).await;
            }
            let (command, nonce) = read_command(&mut device).await;
            assert!(!command.contains(&raw_hash));
            assert_eq!(command.contains(&uploaded_hash), !changed);
            begin(&mut device, &nonce).await;
            if changed {
                end(&mut device, &nonce, 1).await;
                return;
            }
            let probe_nonce = command
                .split("RR_PROBE_")
                .nth(1)
                .unwrap()
                .chars()
                .take(32)
                .collect::<String>();
            let probe =
                serde_json::json!({"program":"/usr/bin/python3","version":"3.12.9","env":{}});
            device
                .write_all(format!("\x1eRR_PROBE_{probe_nonce}{probe}\x1f").as_bytes())
                .await
                .unwrap();
            end(&mut device, &nonce, 0).await;
            let (command, nonce) = read_command(&mut device).await;
            assert!(command.contains("/usr/bin/python3"));
            begin(&mut device, &nonce).await;
            end(&mut device, &nonce, 0).await;
        });
        let mut req: RunRequest = serde_json::from_value(serde_json::json!({"device_id":"serial","kind":"python","entry":"test.py","workspace":workspace})).unwrap();
        req.project_inputs = Some(inputs);
        req.workspace_context = Some(Context {
            request: serde_json::from_value(serde_json::json!({"workspace":workspace,"device_id":"serial","device_revision":"test","command":{"entry":{"type":"python_script","path":"test.py"},"args":[]},"python":"device_default","settings":{"cwd":".","env":{},"console_mode":"pty","timeout_secs":0}})).unwrap(),
            source_device: None, config_dir: root.clone(),
        });
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let result = serial::execute(
            client,
            115200,
            &req,
            "/tmp/workspace",
            files,
            &mut rx,
            |_| {},
        )
        .await;
        fake.await.unwrap();
        if changed {
            assert!(result
                .unwrap_err()
                .to_string()
                .contains("project input probe failed"));
        } else {
            assert_eq!(result.unwrap().code, Some(0));
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[tokio::test]
async fn full_workspace_run_hides_setup_and_echo_and_preserves_exit_code() {
    let (client, mut device) = tokio::io::duplex(128);
    let fake = tokio::spawn(async move {
        for index in 0..4 {
            let (command, nonce) = read_command(&mut device).await;
            if index == 2 {
                assert!(command.contains("base64 -d"));
                assert!(command.contains("RR_UPLOAD_EOF"));
            }
            device.write_all(command.as_bytes()).await.unwrap(); // full shell echo
            begin(&mut device, &nonce).await;
            device
                .write_all(if index == 3 {
                    b"script output"
                } else {
                    b"internal output"
                })
                .await
                .unwrap();
            end(&mut device, &nonce, if index == 3 { 7 } else { 0 }).await;
        }
    });
    let request: RunRequest = serde_json::from_value(serde_json::json!({
        "device_id": "test", "kind": "python", "entry": "test.py", "workspace_dir": "."
    }))
    .unwrap();
    let (_tx, mut rx) = mpsc::unbounded_channel();
    let output = Mutex::new(Vec::new());
    let states = Mutex::new(Vec::new());
    let result = serial::execute(
        client,
        115200,
        &request,
        "/tmp/test",
        vec![serial::filesync::UploadEntry::File(
            serial::filesync::TextFile {
                relative: "test.py".into(),
                data: b"print('hello')\n".to_vec(),
            },
        )],
        &mut rx,
        |event| match event {
            serial::Event::Launch(_) => {}
            serial::Event::Output { data, .. } => output.lock().unwrap().extend(data),
            serial::Event::State(state) => states.lock().unwrap().push(state.as_str()),
        },
    )
    .await
    .unwrap();
    fake.await.unwrap();
    assert_eq!(result.code, Some(7));
    assert_eq!(result.stopped, None);
    assert_eq!(*output.lock().unwrap(), b"script output");
    assert_eq!(
        *states.lock().unwrap(),
        vec!["syncing", "starting", "running"]
    );
}

#[tokio::test]
async fn interactive_input_reaches_process_without_shell_commands() {
    let (client, mut device) = tokio::io::duplex(128);
    let (tx, mut rx) = mpsc::unbounded_channel();
    let fake = tokio::spawn(async move {
        let (_, nonce) = read_command(&mut device).await;
        begin(&mut device, &nonce).await;
        device.write_all(b"name? ").await.unwrap();
        let mut input = [0; 6];
        device.read_exact(&mut input).await.unwrap();
        assert_eq!(&input, b"world\n");
        device.write_all(b"hello world").await.unwrap();
        end(&mut device, &nonce, 0).await;
    });
    let mut output = Vec::new();
    let mut sent = false;
    let result = ShellSession::new(client, 115200)
        .execute(
            "python3 test.py",
            Some((80, 24)),
            None,
            &mut rx,
            |data| {
                output.extend(data);
                if !sent && output.ends_with(b"name? ") {
                    sent = true;
                    tx.send(SessionControl::Input(b"world\n".to_vec())).unwrap();
                }
            },
            |_| {},
        )
        .await
        .unwrap();
    assert_eq!(result.code, 0);
    assert_eq!(output, b"name? hello world");
    fake.await.unwrap();
}

#[tokio::test]
async fn home_workspace_is_resolved_before_upload_and_execution() {
    let (client, mut device) = tokio::io::duplex(4096);
    let fake = tokio::spawn(async move {
        for index in 0..5 {
            let (command, nonce) = read_command(&mut device).await;
            if index == 1 {
                assert!(command.contains("$HOME"));
            }
            if index >= 2 {
                assert!(
                    command.contains("/srv/custom home/devrunner/workspaces/run"),
                    "{command}"
                );
                assert!(!command.contains("~/devrunner"));
            }
            begin(&mut device, &nonce).await;
            if index == 1 {
                device.write_all(b"/srv/custom home").await.unwrap();
            }
            if index == 4 {
                device.write_all(b"done").await.unwrap();
            }
            end(&mut device, &nonce, 0).await;
        }
    });
    let req: RunRequest = serde_json::from_value(serde_json::json!({
        "device_id":"serial", "kind":"python", "entry":"test.py", "workspace":"."
    }))
    .unwrap();
    let (_tx, mut rx) = mpsc::unbounded_channel();
    let output = Mutex::new(Vec::new());
    let result = serial::execute(
        client,
        115200,
        &req,
        "~/devrunner/workspaces/run",
        vec![serial::filesync::UploadEntry::File(
            serial::filesync::TextFile {
                relative: "test.py".into(),
                data: b"print('done')".to_vec(),
            },
        )],
        &mut rx,
        |event| {
            if let serial::Event::Output { data, .. } = event {
                output.lock().unwrap().extend(data);
            }
        },
    )
    .await
    .unwrap();
    fake.await.unwrap();
    assert_eq!(result.code, Some(0));
    assert_eq!(*output.lock().unwrap(), b"done");
}

#[tokio::test]
async fn input_arriving_with_the_start_marker_is_queued_until_the_process_is_ready() {
    let (client, mut device) = tokio::io::duplex(128);
    let (tx, mut rx) = mpsc::unbounded_channel();
    let fake = tokio::spawn(async move {
        let (_, nonce) = read_command(&mut device).await;
        begin(&mut device, &nonce).await;
        let mut input = [0; 6];
        device.read_exact(&mut input).await.unwrap();
        assert_eq!(&input, b"early\n");
        end(&mut device, &nonce, 0).await;
    });
    tx.send(SessionControl::Input(b"early\n".to_vec())).unwrap();
    let result = ShellSession::new(client, 115200)
        .execute("cat", Some((80, 24)), None, &mut rx, |_| {}, |_| {})
        .await
        .unwrap();
    assert_eq!(result.code, 0);
    fake.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn timeout_interrupts_and_requires_confirmed_exit() {
    let (client, mut device) = tokio::io::duplex(128);
    let fake = tokio::spawn(async move {
        let (_, nonce) = read_command(&mut device).await;
        begin(&mut device, &nonce).await;
        assert_eq!(device.read_u8().await.unwrap(), 3);
        end(&mut device, &nonce, 130).await;
    });
    let (_tx, mut rx) = mpsc::unbounded_channel();
    let result = ShellSession::new(client, 115200)
        .execute(
            "sleep 60",
            None,
            Some(Duration::from_secs(1)),
            &mut rx,
            |_| {},
            |_| {},
        )
        .await
        .unwrap();
    assert_eq!(result.stopped, Some(StopReason::Timeout));
    assert_eq!(result.code, 130);
    fake.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn unresponsive_process_is_not_reported_as_canceled() {
    let (client, mut device) = tokio::io::duplex(128);
    let fake = tokio::spawn(async move {
        let (_, nonce) = read_command(&mut device).await;
        begin(&mut device, &nonce).await;
        assert_eq!(device.read_u8().await.unwrap(), 3);
        std::future::pending::<()>().await;
    });
    let (_tx, mut rx) = mpsc::unbounded_channel();
    let error = ShellSession::new(client, 115200)
        .execute(
            "sleep 60",
            None,
            Some(Duration::from_secs(1)),
            &mut rx,
            |_| {},
            |_| {},
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("may still be running"));
    fake.abort();
}

#[tokio::test(start_paused = true)]
async fn login_prompt_is_not_mistaken_for_a_ready_shell() {
    let (client, mut device) = tokio::io::duplex(1024);
    let fake = tokio::spawn(async move {
        let (command, _) = read_command(&mut device).await;
        device.write_all(command.as_bytes()).await.unwrap();
        device.write_all(b"login: root# password: $").await.unwrap();
        std::future::pending::<()>().await;
    });
    let (_tx, mut rx) = mpsc::unbounded_channel();
    let error = ShellSession::new(client, 115200)
        .execute(
            "uname -a",
            None,
            None,
            &mut rx,
            |_| panic!("login prompt must be hidden"),
            |_| {},
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("already logged"));
    fake.abort();
}

#[tokio::test]
async fn disconnect_before_end_marker_fails() {
    let (client, mut device) = tokio::io::duplex(128);
    tokio::spawn(async move {
        let (_, nonce) = read_command(&mut device).await;
        begin(&mut device, &nonce).await;
    });
    let (_tx, mut rx) = mpsc::unbounded_channel();
    let error = ShellSession::new(client, 115200)
        .execute("true", None, None, &mut rx, |_| {}, |_| {})
        .await
        .unwrap_err();
    assert!(error.to_string().contains("disconnected"));
}

#[tokio::test]
async fn user_stop_is_forwarded_as_ctrl_c() {
    let (client, mut device) = tokio::io::duplex(128);
    let (tx, mut rx) = mpsc::unbounded_channel();
    let seen = Arc::new(Mutex::new(false));
    let fake_seen = seen.clone();
    let fake = tokio::spawn(async move {
        let (_, nonce) = read_command(&mut device).await;
        begin(&mut device, &nonce).await;
        assert_eq!(device.read_u8().await.unwrap(), 3);
        *fake_seen.lock().unwrap() = true;
        end(&mut device, &nonce, 130).await;
    });
    let result = ShellSession::new(client, 115200)
        .execute(
            "sleep 60",
            None,
            None,
            &mut rx,
            |_| {},
            |state| {
                if state == crate::process::RunState::Running {
                    tx.send(SessionControl::Interrupt).unwrap();
                }
            },
        )
        .await
        .unwrap();
    assert_eq!(result.stopped, Some(StopReason::User));
    fake.await.unwrap();
    assert!(*seen.lock().unwrap());
}

#[tokio::test(start_paused = true)]
async fn partial_submission_stop_requires_remote_confirmation() {
    let (client, mut device) = tokio::io::duplex(1);
    let (tx, mut rx) = mpsc::unbounded_channel();
    let fake = tokio::spawn(async move {
        assert_eq!(device.read_u8().await.unwrap(), b's');
        tx.send(SessionControl::Interrupt).unwrap();
        loop {
            let byte = device.read_u8().await.unwrap();
            assert_ne!(
                byte, b'\n',
                "a partial command must not be submitted by Stop"
            );
            if byte == 3 {
                break;
            }
        }
        let mut rest = Vec::new();
        device.read_to_end(&mut rest).await.unwrap();
        assert!(rest.is_empty());
    });
    let error = ShellSession::new(client, 115200)
        .execute("sleep 60", None, None, &mut rx, |_| {}, |_| {})
        .await
        .unwrap_err();
    assert!(error.to_string().contains("stop was not confirmed"));
    fake.await.unwrap();
}

#[tokio::test]
async fn stop_before_io_never_touches_the_device() {
    let (client, mut device) = tokio::io::duplex(128);
    let (tx, mut rx) = mpsc::unbounded_channel();
    tx.send(SessionControl::Interrupt).unwrap();
    let result = ShellSession::new(client, 115200)
        .execute("true", None, None, &mut rx, |_| {}, |_| {})
        .await
        .unwrap();
    assert_eq!(result.stopped, Some(StopReason::User));
    let mut received = Vec::new();
    device.read_to_end(&mut received).await.unwrap();
    assert!(received.is_empty());
}

#[tokio::test]
async fn stopping_discards_early_input_even_when_begin_arrives_late() {
    let (client, mut device) = tokio::io::duplex(128);
    let (tx, mut rx) = mpsc::unbounded_channel();
    tx.send(SessionControl::Input(b"dangerous input\n".to_vec()))
        .unwrap();
    let fake = tokio::spawn(async move {
        let (_, nonce) = read_command(&mut device).await;
        tx.send(SessionControl::Interrupt).unwrap();
        begin(&mut device, &nonce).await;
        assert_eq!(device.read_u8().await.unwrap(), 3);
        end(&mut device, &nonce, 130).await;
        let mut received = Vec::new();
        device.read_to_end(&mut received).await.unwrap();
        assert!(
            received.is_empty(),
            "stdin escaped into the stopped command"
        );
    });
    let result = ShellSession::new(client, 115200)
        .execute("cat", Some((80, 24)), None, &mut rx, |_| {}, |_| {})
        .await
        .unwrap();
    assert_eq!(result.stopped, Some(StopReason::User));
    fake.await.unwrap();
}

#[tokio::test]
async fn setup_drops_input_and_completed_process_does_not_receive_queued_input() {
    for dimensions in [None, Some((80, 24))] {
        let (client, mut device) = tokio::io::duplex(128);
        let (tx, mut rx) = mpsc::unbounded_channel();
        tx.send(SessionControl::Input(b"must not reach shell\n".to_vec()))
            .unwrap();
        let fake = tokio::spawn(async move {
            let (_, nonce) = read_command(&mut device).await;
            device
                .write_all(format!("\x1eRR_{nonce}_B\x1f\x1eRR_{nonce}_E:0\x1f").as_bytes())
                .await
                .unwrap();
            let mut received = Vec::new();
            device.read_to_end(&mut received).await.unwrap();
            assert!(received.is_empty());
        });
        let result = ShellSession::new(client, 115200)
            .execute("true", dimensions, None, &mut rx, |_| {}, |_| {})
            .await
            .unwrap();
        assert_eq!(result.code, 0);
        fake.await.unwrap();
    }
}

#[tokio::test]
async fn failed_upload_chunk_prevents_remaining_chunks_and_script_execution() {
    let (client, mut device) = tokio::io::duplex(128);
    let fake = tokio::spawn(async move {
        for index in 0..4 {
            let (command, nonce) = read_command(&mut device).await;
            if index >= 2 {
                assert!(command.contains("base64 -d"));
            }
            begin(&mut device, &nonce).await;
            end(&mut device, &nonce, if index == 3 { 1 } else { 0 }).await;
        }
        let mut received = Vec::new();
        device.read_to_end(&mut received).await.unwrap();
        assert!(received.is_empty());
    });
    let req: RunRequest = serde_json::from_value(serde_json::json!({
        "device_id":"test", "kind":"python", "entry":"test.py", "workspace_dir":"."
    }))
    .unwrap();
    let file = serial::filesync::UploadEntry::File(serial::filesync::TextFile {
        relative: "test.py".into(),
        data: vec![b'a'; 10240],
    });
    let (_tx, mut rx) = mpsc::unbounded_channel();
    let error = serial::execute(
        client,
        115200,
        &req,
        "/tmp/test",
        vec![file],
        &mut rx,
        |_| {},
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("upload failed"));
    fake.await.unwrap();
}

#[tokio::test]
async fn invalid_wire_commands_fail_before_any_remote_changes() {
    for command in [
        "x".repeat(4096),
        "echo x\n".repeat(4096),
        "printf '\u{3}'".into(),
        "printf '\u{1b}'".into(),
        "printf '\r'".into(),
    ] {
        let req: RunRequest = serde_json::from_value(serde_json::json!({
            "device_id":"test", "kind":"command", "command":command, "workspace_dir":"."
        }))
        .unwrap();
        let (client, mut device) = tokio::io::duplex(128);
        let (_tx, mut rx) = mpsc::unbounded_channel();
        assert!(
            serial::execute(client, 115200, &req, "/tmp/test", vec![], &mut rx, |_| {})
                .await
                .is_err()
        );
        let mut received = Vec::new();
        device.read_to_end(&mut received).await.unwrap();
        assert!(received.is_empty());
    }
}

#[tokio::test]
async fn continuous_output_does_not_starve_stop_writes() {
    let (client, mut device) = tokio::io::duplex(4096);
    let (tx, mut rx) = mpsc::unbounded_channel();
    let fake = tokio::spawn(async move {
        let (_, nonce) = read_command(&mut device).await;
        begin(&mut device, &nonce).await;
        let (mut read, mut write) = tokio::io::split(&mut device);
        loop {
            tokio::select! {
                biased;
                byte = read.read_u8() => { assert_eq!(byte.unwrap(), 3); break; }
                result = write.write_all(&[b'x'; 1024]) => { result.unwrap(); }
            }
        }
        write
            .write_all(format!("\x1eRR_{nonce}_E:130\x1f").as_bytes())
            .await
            .unwrap();
    });
    let result = tokio::time::timeout(
        Duration::from_secs(3),
        ShellSession::new(client, 115200).execute(
            "yes",
            None,
            None,
            &mut rx,
            |_| {},
            |state| {
                if state == crate::process::RunState::Running {
                    tx.send(SessionControl::Interrupt).unwrap();
                }
            },
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result.stopped, Some(StopReason::User));
    fake.await.unwrap();
}

#[test]
fn terminal_setup_precedes_begin_and_setup_failure_still_has_an_exit_marker() {
    let Some(shell) = local_shell() else {
        return;
    };
    let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&root).unwrap();
    // Exercise the actual wrapper with a deterministic stty stand-in. This
    // verifies setup/cleanup ordering, not the host's hardware termios behavior.
    let fake_stty = "#!/bin/sh\ncase \"$1\" in -g) echo saved;; saved) printf RESTORED;; *) printf CONFIGURED;; esac\n";
    for (implementation, expected_code) in [(fake_stty, 0), ("#!/bin/sh\nexit 1\n", 125)] {
        std::fs::write(root.join("stty"), implementation).unwrap();
        let command = format!(
            "chmod +x stty; PATH=\"$PWD:$PATH\"; {}",
            serial::protocol::wrap("printf BODY", "tty", Some((120, 40)))
        );
        let result = std::process::Command::new(&shell)
            .current_dir(&root)
            .arg("-c")
            .arg(command)
            .output()
            .unwrap();
        let mut parser = serial::protocol::FrameParser::new("tty");
        let output = parser.push(&result.stdout).unwrap();
        assert_eq!(
            parser.code,
            Some(expected_code),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        if expected_code == 0 {
            assert!(result.stdout.starts_with(b"CONFIGURED\x1eRR_tty_B\x1f"));
            assert_eq!(output, b"BODYRESTORED");
        } else {
            assert!(output.is_empty());
        }
    }
    std::fs::remove_dir_all(root).unwrap();
}
