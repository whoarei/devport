//! Interactive terminal sessions. Deliberately independent of RunManager/workspaces.
use crate::device::{DeviceProfile, TransportKind};
use crate::error::{Result, RunnerError};
use base64::{engine::general_purpose::STANDARD, Engine};
use parking_lot::Mutex;
use serde::Serialize;
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::sync::{mpsc, watch};

const SESSION_LIMIT: usize = 8;
const OUTPUT_LIMIT: usize = 1024 * 1024;
const READ_LIMIT: usize = 64 * 1024;
const INPUT_LIMIT: usize = 16 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Connecting,
    Connected,
    Closing,
    Exited,
    Failed,
    Closed,
}

#[derive(Clone, Debug, Serialize)]
pub struct Status {
    pub session_id: String,
    pub device_name: String,
    pub state: State,
    pub exit_code: Option<u32>,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct Read {
    pub status: Status,
    pub data: String,
}

pub enum Control {
    Input(Vec<u8>),
    Resize { cols: u32, rows: u32 },
}
pub enum Event {
    Connected,
    Output(Vec<u8>),
}

struct Handle {
    status: Status,
    output: std::collections::VecDeque<u8>,
    control: mpsc::Sender<Control>,
    cancel: watch::Sender<bool>,
    done: watch::Receiver<bool>,
}

#[derive(Clone, Default)]
pub struct TerminalManager {
    handles: Arc<Mutex<HashMap<String, Handle>>>,
}

fn invalid(message: &str) -> RunnerError {
    RunnerError::InvalidInput(message.into())
}

pub fn validate_size(cols: u32, rows: u32) -> Result<()> {
    if !(1..=4096).contains(&cols) || !(1..=4096).contains(&rows) {
        return Err(invalid("invalid terminal dimensions (1..4096)"));
    }
    Ok(())
}

pub async fn canceled(cancel: &mut watch::Receiver<bool>) {
    while !*cancel.borrow_and_update() {
        if cancel.changed().await.is_err() {
            break;
        }
    }
}

impl TerminalManager {
    /// 打开独立终端。`cwd` 为工作区终端的起始目录：Local 作为子进程 cwd，
    /// SSH/WSL 在 shell 启动后进入该目录（00029）；Serial 不支持终端。
    pub fn open(
        &self,
        device: DeviceProfile,
        config: PathBuf,
        cols: u32,
        rows: u32,
        cwd: Option<String>,
    ) -> Result<Status> {
        device.validate()?;
        validate_size(cols, rows)?;
        if device.transport == TransportKind::Serial {
            return Err(invalid("串口暂不支持独立终端，请使用运行控制台"));
        }
        if let Some(cwd) = &cwd {
            match device.transport {
                TransportKind::Local => {
                    if cwd.trim().is_empty() {
                        return Err(invalid("终端工作目录不能为空"));
                    }
                }
                TransportKind::Ssh | TransportKind::Wsl => {
                    crate::workspace_ref::validate_device_path(cwd).map_err(|m| invalid(&m))?;
                }
                TransportKind::Serial => unreachable!(),
            }
        }
        let (control, mut controls) = mpsc::channel(32);
        let (cancel, mut cancellation) = watch::channel(false);
        let (done_tx, done) = watch::channel(false);
        let status = Status {
            session_id: uuid::Uuid::new_v4().to_string(),
            device_name: device.name.clone(),
            state: State::Connecting,
            exit_code: None,
            error: None,
        };
        let id = status.session_id.clone();
        {
            let mut handles = self.handles.lock();
            if handles.len() >= SESSION_LIMIT {
                return Err(invalid("最多打开 8 个终端，请先关闭一个标签"));
            }
            handles.insert(
                id.clone(),
                Handle {
                    status: status.clone(),
                    output: Default::default(),
                    control,
                    cancel,
                    done,
                },
            );
        }
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            let emit = |event| manager.emit(&id, event);
            let result = match device.transport {
                TransportKind::Ssh => {
                    crate::ssh::terminal::execute(
                        &device,
                        &config,
                        cols,
                        rows,
                        cwd,
                        &mut controls,
                        &mut cancellation,
                        emit,
                    )
                    .await
                }
                TransportKind::Wsl => {
                    crate::wsl::terminal::execute(
                        device.wsl.as_ref().unwrap(),
                        cols,
                        rows,
                        cwd,
                        &mut controls,
                        &mut cancellation,
                        emit,
                    )
                    .await
                }
                TransportKind::Serial => unreachable!(),
                TransportKind::Local => {
                    crate::local::terminal::execute(
                        device.local.as_ref().unwrap(),
                        cwd.map(PathBuf::from),
                        cols,
                        rows,
                        &mut controls,
                        &mut cancellation,
                        emit,
                    )
                    .await
                }
            };
            if let Some(handle) = manager.handles.lock().get_mut(&id) {
                // Overflow is recorded before cancellation; never replace it with a clean close.
                if handle.status.state != State::Failed {
                    match result {
                        Ok(code) => {
                            handle.status.exit_code = code;
                            handle.status.state = if *cancellation.borrow() {
                                State::Closed
                            } else {
                                State::Exited
                            };
                        }
                        Err(error) => {
                            handle.status.state = State::Failed;
                            handle.status.error = Some(error.to_string());
                        }
                    }
                }
            }
            let _ = done_tx.send(true);
        });
        Ok(status)
    }

    fn emit(&self, id: &str, event: Event) -> Result<()> {
        let mut handles = self.handles.lock();
        let handle = handles
            .get_mut(id)
            .ok_or_else(|| invalid("terminal session not found"))?;
        match event {
            Event::Connected if handle.status.state == State::Connecting => {
                handle.status.state = State::Connected
            }
            Event::Output(data) => {
                if handle.output.len().saturating_add(data.len()) > OUTPUT_LIMIT {
                    handle.status.state = State::Failed;
                    handle.status.error =
                        Some("终端输出超过接收上限，连接已停止；请重新连接".into());
                    let _ = handle.cancel.send(true);
                    return Err(invalid("terminal output exceeded 1 MiB"));
                }
                handle.output.extend(data);
            }
            _ => {}
        }
        Ok(())
    }

    pub fn read(&self, id: &str) -> Result<Read> {
        let mut handles = self.handles.lock();
        let handle = handles
            .get_mut(id)
            .ok_or_else(|| invalid("terminal session not found"))?;
        let n = handle.output.len().min(READ_LIMIT);
        let bytes: Vec<_> = handle.output.drain(..n).collect();
        Ok(Read {
            status: handle.status.clone(),
            data: STANDARD.encode(bytes),
        })
    }

    pub fn input(&self, id: &str, data: String) -> Result<()> {
        if data.len() > INPUT_LIMIT {
            return Err(invalid("terminal input exceeds 16 KiB"));
        }
        self.control(id, Control::Input(data.into_bytes()))
    }

    pub fn resize(&self, id: &str, cols: u32, rows: u32) -> Result<()> {
        validate_size(cols, rows)?;
        self.control(id, Control::Resize { cols, rows })
    }

    fn control(&self, id: &str, control: Control) -> Result<()> {
        let handles = self.handles.lock();
        let handle = handles
            .get(id)
            .ok_or_else(|| invalid("terminal session not found"))?;
        if handle.status.state != State::Connected {
            return Err(invalid("terminal is not connected"));
        }
        handle
            .control
            .try_send(control)
            .map_err(|_| invalid("终端输入队列已满或连接已关闭，请稍后重试"))
    }

    pub fn has_active(&self) -> bool {
        self.handles.lock().values().any(|h| !*h.done.borrow())
    }

    pub async fn close(&self, id: &str) -> Result<()> {
        let mut done = {
            let mut handles = self.handles.lock();
            let Some(handle) = handles.get_mut(id) else {
                return Ok(());
            };
            if !*handle.done.borrow() {
                if handle.status.state != State::Failed {
                    handle.status.state = State::Closing;
                }
                let _ = handle.cancel.send(true);
            }
            handle.done.clone()
        };
        tokio::time::timeout(std::time::Duration::from_secs(20), async {
            while !*done.borrow_and_update() {
                if done.changed().await.is_err() {
                    break;
                }
            }
        })
        .await
        .map_err(|_| invalid("终端尚未完成关闭，请重试"))?;
        self.handles.lock().remove(id);
        Ok(())
    }

    pub async fn close_all(&self) -> Result<()> {
        let ids: Vec<_> = {
            let handles = self.handles.lock();
            for handle in handles.values() {
                let _ = handle.cancel.send(true);
            }
            handles.keys().cloned().collect()
        };
        for id in ids {
            self.close(&id).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(
        manager: &TerminalManager,
        id: &str,
    ) -> (
        mpsc::Receiver<Control>,
        watch::Receiver<bool>,
        watch::Sender<bool>,
    ) {
        let (control, rx) = mpsc::channel(32);
        let (cancel, cancellation) = watch::channel(false);
        let (done_tx, done) = watch::channel(false);
        manager.handles.lock().insert(
            id.into(),
            Handle {
                status: Status {
                    session_id: id.into(),
                    device_name: id.into(),
                    state: State::Connected,
                    exit_code: None,
                    error: None,
                },
                output: Default::default(),
                control,
                cancel,
                done,
            },
        );
        (rx, cancellation, done_tx)
    }

    #[test]
    fn validates_boundaries_and_never_accepts_serial_or_over_capacity() {
        let manager = TerminalManager::default();
        let device: DeviceProfile = serde_json::from_value(serde_json::json!({"id":"s", "name":"serial", "transport":"serial", "serial":{"port":"COM1"}})).unwrap();
        assert!(manager.open(device, PathBuf::new(), 80, 24, None).is_err());
        for (cols, rows) in [(0, 24), (80, 0), (4097, 24), (80, u32::MAX)] {
            assert!(validate_size(cols, rows).is_err());
        }
        validate_size(4096, 1).unwrap();
        let _leases: Vec<_> = (0..8).map(|n| fixture(&manager, &n.to_string())).collect();
        let device: DeviceProfile = serde_json::from_value(
            serde_json::json!({"id":"s", "name":"ssh", "host":"localhost", "username":"test"}),
        )
        .unwrap();
        assert!(manager
            .open(device, PathBuf::new(), 80, 24, None)
            .unwrap_err()
            .to_string()
            .contains('8'));
    }

    #[tokio::test]
    async fn workspace_cwd_is_accepted_for_local_ssh_wsl_but_not_serial() {
        let manager = TerminalManager::default();
        let cwd = "/srv/app".to_string();
        let ssh: DeviceProfile = serde_json::from_value(
            serde_json::json!({"id":"s", "name":"ssh", "host":"localhost", "username":"test"}),
        )
        .unwrap();
        // SSH/WSL 的工作区终端在 shell 启动后 cd 到该目录（00029）
        assert!(manager
            .open(ssh, PathBuf::new(), 80, 24, Some(cwd.clone()))
            .is_ok());
        let serial: DeviceProfile = serde_json::from_value(serde_json::json!({"id":"s", "name":"serial", "transport":"serial", "serial":{"port":"COM1"}})).unwrap();
        assert!(manager
            .open(serial, PathBuf::new(), 80, 24, Some(cwd))
            .is_err());
        // 远端 cwd 必须是合法的绝对 Linux 路径
        let ssh: DeviceProfile = serde_json::from_value(
            serde_json::json!({"id":"s", "name":"ssh", "host":"localhost", "username":"test"}),
        )
        .unwrap();
        assert!(manager
            .open(ssh, PathBuf::new(), 80, 24, Some("relative/dir".into()))
            .is_err());
    }

    #[test]
    fn input_is_bounded_and_ctrl_c_is_input_only_for_its_session() {
        let manager = TerminalManager::default();
        let (mut a, _, _done_a) = fixture(&manager, "a");
        let (mut b, _, _done_b) = fixture(&manager, "b");
        assert!(manager.input("missing", "hi".into()).is_err());
        assert!(manager.input("a", "x".repeat(INPUT_LIMIT + 1)).is_err());
        manager.input("a", "\x03".into()).unwrap();
        assert!(matches!(a.try_recv().unwrap(), Control::Input(data) if data == [3]));
        assert!(b.try_recv().is_err());
        for _ in 0..32 {
            manager.input("a", "hi".into()).unwrap();
        }
        assert!(manager.input("a", "full".into()).is_err());
        assert!(manager.resize("a", 0, 24).is_err());
        assert_eq!(manager.read("a").unwrap().status.state, State::Connected);
    }

    #[test]
    fn raw_output_remains_ordered_and_overflow_closes_without_silent_truncation() {
        let manager = TerminalManager::default();
        let (_rx, cancel, _done) = fixture(&manager, "a");
        let data = [255, 0, 27, 13, 10].repeat(20000);
        manager.emit("a", Event::Output(data.clone())).unwrap();
        let mut actual = Vec::new();
        for _ in 0..2 {
            actual.extend(STANDARD.decode(manager.read("a").unwrap().data).unwrap());
        }
        assert_eq!(actual, data);
        manager
            .emit("a", Event::Output(vec![0; OUTPUT_LIMIT]))
            .unwrap();
        assert!(manager.emit("a", Event::Output(vec![1])).is_err());
        assert_eq!(manager.read("a").unwrap().status.state, State::Failed);
        assert!(*cancel.borrow());
    }

    #[tokio::test]
    async fn closing_waits_for_cleanup_and_is_idempotent() {
        let manager = TerminalManager::default();
        let (_rx, mut cancel, done) = fixture(&manager, "a");
        assert!(manager.has_active());
        let closing = manager.close("a");
        tokio::pin!(closing);
        tokio::select! { result = &mut closing => panic!("closed too early: {result:?}"), _ = canceled(&mut cancel) => {} }
        assert!(manager.has_active());
        done.send(true).unwrap();
        closing.await.unwrap();
        manager.close("a").await.unwrap();
        assert!(!manager.has_active());
        assert!(manager.read("a").is_err());
    }
}
