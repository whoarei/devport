//! 本机子进程会话：PTY（portable-pty，Windows ConPTY / Unix openpty）或分离管道。
//! 两种模式统一为阻塞 IO 线程 + tokio 事件通道；子进程退出由执行循环轮询 try_wait 检测。
use crate::error::{Result, RunnerError};
use crate::process::{ConsoleMode, OutputStream};
use std::io::{Read, Write};
use std::path::PathBuf;
use tokio::sync::mpsc;

const EVENT_QUEUE_CAPACITY: usize = 64;

fn failure(message: impl Into<String>) -> RunnerError {
    RunnerError::Local(message.into())
}

/// IO 线程向异步执行循环回报的事件；退出码不由通道传递（由 try_wait 轮询获得）
pub enum ChildEvent {
    Output {
        stream: OutputStream,
        data: Vec<u8>,
    },
    /// 一个输出读取线程结束（EOF 或读失败）；用于退出前排空输出
    ReaderDone,
}

pub struct SessionSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    pub env_clear: bool,
    pub mode: ConsoleMode,
    pub cols: u32,
    pub rows: u32,
}

enum ChildHandle {
    Pipe(std::process::Child),
    Pty(Box<dyn portable_pty::Child + Send + Sync>),
}

pub struct Session {
    child: ChildHandle,
    pid: Option<u32>,
    /// Unix 进程组 id（pipe 模式 setsid / PTY 模式 forkpty，均等于子进程 pid）
    #[cfg(unix)]
    pgid: Option<u32>,
    mode: ConsoleMode,
    input_tx: Option<std::sync::mpsc::Sender<Vec<u8>>>,
    master: Option<Box<dyn portable_pty::MasterPty + Send>>,
    events: mpsc::Receiver<ChildEvent>,
    /// 退出前排空输出时需要等待的读取线程数（pty=1，pipe=2）
    pub expected_readers: usize,
}

fn spawn_reader(
    mut reader: impl Read + Send + 'static,
    stream: OutputStream,
    tx: mpsc::Sender<ChildEvent>,
    mut dsr: Option<DsrResponder>,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        // DSR 序列 \x1b[6n 可能跨越读取边界，保留 3 字节上下文扫描
        let mut carry = [0u8; 3];
        let mut carry_len = 0usize;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if let Some(dsr) = &mut dsr {
                        let mut haystack = Vec::with_capacity(carry_len + n);
                        haystack.extend_from_slice(&carry[..carry_len]);
                        haystack.extend_from_slice(&buf[..n]);
                        if haystack.windows(4).any(|w| w == b"\x1b[6n") {
                            dsr.reply();
                        }
                        let keep = haystack.len().min(3);
                        carry[..keep].copy_from_slice(&haystack[haystack.len() - keep..]);
                        carry_len = keep;
                    }
                    if tx
                        .blocking_send(ChildEvent::Output {
                            stream,
                            data: buf[..n].to_vec(),
                        })
                        .is_err()
                    {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = tx.blocking_send(ChildEvent::ReaderDone);
    });
}

/// ConPTY 以 WIN32_INPUT_MODE 创建，启动时输出 `\x1b[6n` 查询光标位置并等待回复；
/// 没有真实终端应答时（如后台运行、前端尚未渲染）子进程会一直阻塞。
/// 读取线程代答启动阶段的光标查询。PTY 初始光标位于左上角，不能把
/// 初始 PTY 尺寸当作光标位置，否则 shell 会把提示符放到第 N 行。
/// xterm.js 也会应答，重复的 `1;1` 回复无害。
#[derive(Clone)]
struct DsrResponder {
    input_tx: std::sync::mpsc::Sender<Vec<u8>>,
    replied: bool,
}

impl DsrResponder {
    fn reply(&mut self) {
        if self.replied {
            return;
        }
        self.replied = true;
        let _ = self.input_tx.send(b"\x1b[1;1R".to_vec());
    }
}

fn spawn_writer(mut writer: impl Write + Send + 'static) -> std::sync::mpsc::Sender<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Ok(data) = rx.recv() {
            if writer.write_all(&data).is_err() {
                break;
            }
            let _ = writer.flush();
        }
    });
    tx
}

/// Windows：用系统 taskkill 终止整棵进程树
#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let status = std::process::Command::new(root.join(r"System32\taskkill.exe"))
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    if let Err(e) = status {
        tracing::warn!("taskkill /PID {pid} /T /F failed: {e}");
    }
}

/// Unix：向进程组发信号
#[cfg(unix)]
fn signal_group(pgid: u32, signal: libc::c_int) {
    let result = unsafe { libc::kill(-(pgid as libc::pid_t), signal) };
    if result != 0 {
        tracing::debug!(
            "kill(-{pgid}, {signal}) failed: {}",
            std::io::Error::last_os_error()
        );
    }
}

impl Session {
    pub fn spawn(spec: &SessionSpec) -> Result<Self> {
        match spec.mode {
            ConsoleMode::Pty => Self::spawn_pty(spec),
            ConsoleMode::Pipe => Self::spawn_pipe(spec),
        }
    }

    fn spawn_pty(spec: &SessionSpec) -> Result<Self> {
        let pair = portable_pty::native_pty_system()
            .openpty(portable_pty::PtySize {
                rows: spec.rows as u16,
                cols: spec.cols as u16,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| failure(format!("cannot create a pseudo terminal: {e}")))?;
        let mut command = portable_pty::CommandBuilder::new(&spec.program);
        if spec.env_clear {
            command.env_clear();
        }
        for arg in &spec.args {
            command.arg(arg);
        }
        if let Some(cwd) = &spec.cwd {
            command.cwd(cwd);
        }
        for (key, value) in &spec.env {
            command.env(key, value);
        }
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| failure(format!("cannot clone pty reader: {e}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| failure(format!("cannot take pty writer: {e}")))?;
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| failure(format!("cannot start {}: {e}", spec.program.display())))?;
        let pid = child.process_id();
        #[cfg(unix)]
        let pgid = pair.master.process_group_leader().map(|p| p as u32).or(pid);
        let (tx, events) = mpsc::channel(EVENT_QUEUE_CAPACITY);
        let input_tx = spawn_writer(writer);
        #[cfg(windows)]
        let dsr = DsrResponder {
            input_tx: input_tx.clone(),
            replied: false,
        };
        #[cfg(windows)]
        let dsr = Some(dsr);
        #[cfg(not(windows))]
        let dsr = None;
        spawn_reader(reader, OutputStream::Stdout, tx, dsr);
        // slave 必须在本进程内关闭，否则读取端永远收不到 EOF
        drop(pair.slave);
        Ok(Self {
            child: ChildHandle::Pty(child),
            pid,
            #[cfg(unix)]
            pgid,
            mode: ConsoleMode::Pty,
            input_tx: Some(input_tx),
            master: Some(pair.master),
            events,
            expected_readers: 1,
        })
    }

    fn spawn_pipe(spec: &SessionSpec) -> Result<Self> {
        let mut command = std::process::Command::new(&spec.program);
        command
            .args(&spec.args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if let Some(cwd) = &spec.cwd {
            command.current_dir(cwd);
        }
        if spec.env_clear {
            command.env_clear();
        }
        command.envs(spec.env.iter().map(|(k, v)| (k, v)));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        #[cfg(unix)]
        {
            // 独立会话：子进程 pid 即进程组 id，停止时可整组发信号
            use std::os::unix::process::CommandExt;
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        let mut child = command
            .spawn()
            .map_err(|e| failure(format!("cannot start {}: {e}", spec.program.display())))?;
        let pid = Some(child.id());
        #[cfg(unix)]
        let pgid = pid;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| failure("cannot capture child stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| failure("cannot capture child stderr"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| failure("cannot capture child stdin"))?;
        let (tx, events) = mpsc::channel(EVENT_QUEUE_CAPACITY);
        spawn_reader(stdout, OutputStream::Stdout, tx.clone(), None);
        spawn_reader(stderr, OutputStream::Stderr, tx, None);
        Ok(Self {
            child: ChildHandle::Pipe(child),
            pid,
            #[cfg(unix)]
            pgid,
            mode: ConsoleMode::Pipe,
            input_tx: Some(spawn_writer(stdin)),
            master: None,
            events,
            expected_readers: 2,
        })
    }

    /// 非阻塞轮询退出码
    pub fn try_wait(&mut self) -> Result<Option<u32>> {
        match &mut self.child {
            ChildHandle::Pipe(child) => match child.try_wait()? {
                Some(status) => Ok(Some(portable_pty::ExitStatus::from(status).exit_code())),
                None => Ok(None),
            },
            ChildHandle::Pty(child) => match child.try_wait()? {
                Some(status) => Ok(Some(status.exit_code())),
                None => Ok(None),
            },
        }
    }

    /// 接收 IO 线程事件
    pub async fn next_event(&mut self) -> Option<ChildEvent> {
        self.events.recv().await
    }

    /// stdin / PTY 输入
    pub fn input(&self, data: Vec<u8>) {
        if let Some(tx) = &self.input_tx {
            let _ = tx.send(data);
        }
    }

    /// PTY 缩放；pipe 模式忽略
    pub fn resize(&self, cols: u32, rows: u32) -> Result<()> {
        if let Some(master) = &self.master {
            master
                .resize(portable_pty::PtySize {
                    rows: rows as u16,
                    cols: cols as u16,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| failure(format!("resize failed: {e}")))?;
        }
        Ok(())
    }

    /// 第一阶段停止。返回 false 表示该平台/模式没有温和中断语义，
    /// 调用方应立即升级到强制终止。
    pub fn interrupt(&self) -> bool {
        match self.mode {
            // 终端驱动（Unix）/ ConPTY（Windows）把 0x03 转成 SIGINT / Ctrl+C
            ConsoleMode::Pty => {
                self.input(vec![3]);
                true
            }
            ConsoleMode::Pipe => {
                #[cfg(unix)]
                {
                    if let Some(pgid) = self.pgid {
                        signal_group(pgid, libc::SIGINT);
                    }
                    true
                }
                #[cfg(windows)]
                {
                    false
                }
            }
        }
    }

    /// 第二阶段：Unix 向进程组发 SIGTERM；Windows 无跨进程温和终止，直接终止进程树
    pub fn terminate(&mut self) {
        #[cfg(unix)]
        {
            if let Some(pgid) = self.pgid {
                signal_group(pgid, libc::SIGTERM);
            }
        }
        #[cfg(windows)]
        self.force_kill();
    }

    /// 最终阶段：SIGKILL 进程组 / taskkill 进程树 + 直接 kill 子进程
    pub fn force_kill(&mut self) {
        #[cfg(unix)]
        {
            if let Some(pgid) = self.pgid {
                signal_group(pgid, libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        if let Some(pid) = self.pid {
            kill_tree(pid);
        }
        match &mut self.child {
            ChildHandle::Pipe(child) => {
                let _ = child.kill();
            }
            ChildHandle::Pty(child) => {
                let _ = child.kill();
            }
        }
    }
}

/// 兜底：任何路径丢失 Session（如 future 被取消）都终止子进程，不留下孤儿
impl Drop for Session {
    fn drop(&mut self) {
        if matches!(self.try_wait(), Ok(None)) {
            self.force_kill();
            let _ = self.try_wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dsr_responder_only_answers_the_startup_query() {
        let (input_tx, input_rx) = std::sync::mpsc::channel();
        let mut responder = DsrResponder {
            input_tx,
            replied: false,
        };

        responder.reply();
        responder.reply();

        assert_eq!(input_rx.recv().unwrap(), b"\x1b[1;1R");
        assert!(matches!(
            input_rx.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
    }
}
