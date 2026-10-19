//! Transport-independent process console and control messages.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunState {
    Preparing,
    Syncing,
    Starting,
    Running,
    Stopping,
    Exited,
    Failed,
    Canceled,
}

impl RunState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Preparing => "preparing",
            Self::Syncing => "syncing",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Exited => "exited",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
        }
    }
    pub const fn is_active(self) -> bool {
        matches!(
            self,
            Self::Preparing | Self::Syncing | Self::Starting | Self::Running | Self::Stopping
        )
    }
    /// Preparation, sync, and stop keep the workspace under transport control,
    /// so every local workspace change (save/create/rename/delete) is blocked.
    pub const fn blocks_workspace_change(self) -> bool {
        matches!(self, Self::Preparing | Self::Syncing | Self::Stopping)
    }
}

impl std::fmt::Display for RunState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StopReason {
    User,
    Timeout,
}

#[derive(Debug)]
pub struct Outcome {
    pub code: Option<u32>,
    pub stopped: Option<StopReason>,
}

/// Transport-independent progress contract consumed by RunManager.
pub enum ExecutionEvent {
    Launch(crate::workspace_run::Launch),
    State(RunState),
    Output { stream: OutputStream, data: Vec<u8> },
}

#[derive(Clone, Copy)]
pub struct Capabilities {
    pub pipe: bool,
    pub resize: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConsoleMode {
    Pty,
    Pipe,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputStream {
    Stdout,
    Stderr,
}

#[derive(Debug)]
pub enum SessionEvent {
    Output { stream: OutputStream, data: Vec<u8> },
    Exit { code: Option<u32> },
    Failed { error: String },
    Closed,
}

/// 上层对远程进程的控制消息
#[derive(Debug)]
pub enum SessionControl {
    Input(Vec<u8>),
    Resize {
        cols: u32,
        rows: u32,
    },
    /// Ctrl+C 语义：PTY 下发 0x03；pipe 下发 SIGINT
    Interrupt,
    Terminate,
    /// 尽力发送 KILL 并关闭 channel；远程进程仍需上层按 PID 清理。
    Kill,
}
