use thiserror::Error;

#[derive(Error, Debug)]
pub enum RunnerError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("ssh error: {0}")]
    Ssh(String),

    #[error("serial error: {0}")]
    Serial(String),

    #[error("WSL error: {0}")]
    Wsl(String),

    #[error("local shell error: {0}")]
    Local(String),

    #[error("authentication failed for user {0}")]
    AuthFailed(String),

    #[error("host key mismatch for {0}")]
    HostKeyMismatch(String),

    #[error("device not found: {0}")]
    DeviceNotFound(String),

    #[error("run not found: {0}")]
    RunNotFound(String),

    #[error("invalid input: {0}")]
    InvalidInput(String),

    #[error("task failed: {0}")]
    TaskFailed(String),

    #[error("update error: {0}")]
    Update(String),

    /// Managed Python Runtime 错误：code 为稳定错误代码（00027 §18）
    #[error("{code}: {message}")]
    ManagedRuntime { code: &'static str, message: String },
}

impl RunnerError {
    pub fn managed(code: &'static str, message: impl Into<String>) -> Self {
        RunnerError::ManagedRuntime {
            code,
            message: message.into(),
        }
    }
}

impl From<russh::Error> for RunnerError {
    fn from(e: russh::Error) -> Self {
        RunnerError::Ssh(e.to_string())
    }
}

impl serde::Serialize for RunnerError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<russh_sftp::client::error::Error> for RunnerError {
    fn from(e: russh_sftp::client::error::Error) -> Self {
        RunnerError::Ssh(format!("sftp: {e}"))
    }
}

pub type Result<T> = std::result::Result<T, RunnerError>;
