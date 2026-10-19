use super::*;
use std::{collections::HashMap, path::PathBuf, sync::atomic::Ordering, time::Duration};

struct Fixture {
    root: PathBuf,
    python: PathBuf,
}
impl Fixture {
    fn new() -> Option<Self> {
        let python = std::env::var_os("REMOTE_RUNNER_TEST_PYTHON")
            .map(PathBuf::from)
            .or_else(|| {
                crate::local::shells::find_on_path(if cfg!(windows) { "python" } else { "python3" })
            })?;
        if python.to_string_lossy().contains("WindowsApps") {
            return None;
        }
        let root = std::env::temp_dir().join(format!("rr-probe-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        Some(Self { root, python })
    }
    fn env(&self) -> HashMap<String, String> {
        let mut paths = vec![self.python.parent().unwrap().to_path_buf()];
        // Windows Store aliases are launchers, not the test interpreter.
        paths.extend(
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).filter(|path| {
                !path
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .contains("windowsapps")
            }),
        );
        HashMap::from([(
            "PATH".into(),
            std::env::join_paths(paths)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        )])
    }
    fn pids(&self) -> Vec<u32> {
        std::fs::read(self.root.join("pids.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Also clean up deterministically if an assertion fails.
        for pid in self.pids().into_iter().filter(|pid| running(*pid)) {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = std::process::Command::new("taskkill.exe")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .creation_flags(0x08000000)
                    .output();
            }
            #[cfg(unix)]
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
        }
        let allowed = std::env::temp_dir().canonicalize().unwrap();
        if let Ok(root) = self.root.canonicalize() {
            assert!(
                root.starts_with(allowed)
                    && root
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with("rr-probe-test-")
            );
            let _ = std::fs::remove_dir_all(root);
        }
    }
}

fn device(shell: &str) -> DeviceProfile {
    serde_json::from_value(serde_json::json!({"id":"test-probe","name":"test-probe","transport":"local","local":{"shell":shell,"no_profile":true}})).unwrap()
}

fn running(pid: u32) -> bool {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, WAIT_TIMEOUT},
            System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
        };
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return false;
        }
        let running = WaitForSingleObject(handle, 0) == WAIT_TIMEOUT;
        CloseHandle(handle);
        running
    }
    #[cfg(unix)]
    {
        let status = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        let state = String::from_utf8_lossy(&status.stdout);
        !state.trim().is_empty() && !state.trim().starts_with('Z')
    }
}

#[tokio::test]
async fn large_literal_environment_uses_a_bounded_command_line_in_every_local_shell() {
    let Some(fixture) = Fixture::new() else {
        eprintln!("SKIP: set REMOTE_RUNNER_TEST_PYTHON");
        return;
    };
    let mut env = fixture.env();
    env.insert(
        "RR_LARGE_A".into(),
        format!("{}'\"$\r\n汉字😀", "a".repeat(18000)),
    );
    env.insert("RR_LARGE_B".into(), "b".repeat(18000));
    assert!(serde_json::to_vec(&env).unwrap().len() < 60 * 1024);
    let shells = crate::local::shells::detect();
    assert!(!shells.is_empty());
    for shell in shells {
        for program in [None, Some(fixture.python.to_str().unwrap())] {
            let probe = python(
                &device(&shell.id),
                &fixture.root,
                None,
                program,
                &env,
                Some(fixture.root.to_str().unwrap()),
                &AtomicBool::new(false),
            )
            .await
            .unwrap_or_else(|error| panic!("{}: {error}", shell.id));
            assert!(
                probe.env.get("RR_LARGE_A") == env.get("RR_LARGE_A"),
                "{}: literal environment changed",
                shell.id
            );
            assert_eq!(
                probe.env.get("RR_LARGE_B"),
                env.get("RR_LARGE_B"),
                "{}",
                shell.id
            );
        }
    }
}

#[tokio::test]
async fn explicit_empty_environment_is_preserved_before_python_startup() {
    let Some(fixture) = Fixture::new() else {
        eprintln!("SKIP: set REMOTE_RUNNER_TEST_PYTHON");
        return;
    };
    std::fs::write(
        fixture.root.join("sitecustomize.py"),
        "import os\nos.environ['RR_STARTUP_SAW_EMPTY'] = 'yes' if os.environ.get('RR_EXPLICIT_EMPTY') == '' else 'no'\n",
    ).unwrap();
    let mut env = fixture.env();
    env.insert("RR_EXPLICIT_EMPTY".into(), String::new());
    env.insert(
        "PYTHONPATH".into(),
        fixture.root.to_string_lossy().into_owned(),
    );
    let shells = crate::local::shells::detect();
    assert!(!shells.is_empty());
    for shell in shells {
        for program in [None, Some(fixture.python.to_str().unwrap())] {
            let probe = python(
                &device(&shell.id),
                &fixture.root,
                None,
                program,
                &env,
                Some(fixture.root.to_str().unwrap()),
                &AtomicBool::new(false),
            )
            .await
            .unwrap_or_else(|error| panic!("{}: {error}", shell.id));
            assert_eq!(
                probe.env.get("RR_EXPLICIT_EMPTY").map(String::as_str),
                Some(""),
                "{}",
                shell.id
            );
            assert_eq!(
                probe.env.get("RR_STARTUP_SAW_EMPTY").map(String::as_str),
                Some("yes"),
                "{}",
                shell.id
            );
        }
    }
}

async fn stopped_probe(mode: &str, shell: &str) {
    let Some(fixture) = Fixture::new() else {
        eprintln!("SKIP: set REMOTE_RUNNER_TEST_PYTHON");
        return;
    };
    let device = device(shell);
    if crate::local::shells::resolve(device.local.as_ref().unwrap()).is_err() {
        return;
    }
    let path = serde_json::to_string(
        &fixture
            .root
            .join("pids.json")
            .to_string_lossy()
            .replace('\\', "/"),
    )
    .unwrap();
    std::fs::write(fixture.root.join("sitecustomize.py"), format!("import os,sys,time,subprocess,json\nchild=subprocess.Popen([sys.executable,'-S','-c','import time;time.sleep(60)'])\nwith open({path},'w') as f: json.dump([os.getpid(),child.pid],f)\ntime.sleep(60)\n")).unwrap();
    let mut env = fixture.env();
    env.insert(
        "PYTHONPATH".into(),
        fixture.root.to_string_lossy().into_owned(),
    );
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = cancel.clone();
    let root = fixture.root.clone();
    let program = fixture.python.to_string_lossy().into_owned();
    let timeout = if mode == "timeout" {
        Duration::from_secs(5)
    } else {
        Duration::from_secs(20)
    };
    let task = tokio::spawn(async move {
        python_with_timeout(
            &device,
            &root,
            None,
            Some(&program),
            &env,
            Some(root.to_str().unwrap()),
            &flag,
            timeout,
        )
        .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while fixture.pids().len() != 2 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    if mode == "drop" {
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
    } else {
        if mode == "cancel" {
            cancel.store(true, Ordering::Relaxed);
        }
        let error = tokio::time::timeout(Duration::from_secs(8), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(
            error.to_string().contains(if mode == "cancel" {
                "canceled"
            } else {
                "timed out"
            }),
            "{error}"
        );
        let live = fixture
            .pids()
            .into_iter()
            .filter(|pid| running(*pid))
            .collect::<Vec<_>>();
        assert!(
            live.is_empty(),
            "{mode} {shell}: process still alive when the probe returned"
        );
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        while fixture.pids().iter().any(|pid| running(*pid)) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn cancellation_reaps_python_and_its_descendants() {
    for shell in if cfg!(windows) {
        vec!["pwsh", "cmd", "gitbash"]
    } else {
        vec!["bash", "sh"]
    } {
        stopped_probe("cancel", shell).await;
    }
}
#[tokio::test]
async fn timeout_reaps_python_and_its_descendants() {
    stopped_probe("timeout", if cfg!(windows) { "pwsh" } else { "bash" }).await;
}
#[tokio::test]
async fn dropping_the_probe_future_kills_its_descendants() {
    stopped_probe("drop", if cfg!(windows) { "pwsh" } else { "bash" }).await;
}
