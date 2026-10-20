//! RuntimeHost：Managed Runtime 面向 transport 的统一执行抽象。
//!
//! prepare/manager 只依赖本 trait；SSH/WSL/Local 各提供一个实现，
//! 测试使用 FakeHost + 可编程 fake uv（00005-python-runtime.md）。
use crate::error::{Result, RunnerError};
use futures::future::BoxFuture;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// 无 PTY 的受控执行结果
#[derive(Debug, Clone, Default)]
pub struct ExecResult {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl ExecResult {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }

    /// stderr/stdout 尾部，用于错误信息（已做凭据脱敏）
    pub fn tail(&self, max: usize) -> String {
        let mut text = String::new();
        if !self.stdout.is_empty() {
            text.push_str(&String::from_utf8_lossy(&self.stdout));
        }
        if !self.stderr.is_empty() {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&String::from_utf8_lossy(&self.stderr));
        }
        let text = crate::runtime::scrub_credentials(&text);
        if text.len() > max {
            format!("…{}", &text[text.len() - max..])
        } else {
            text
        }
    }
}

pub fn canceled_error() -> RunnerError {
    RunnerError::managed(crate::runtime::code::CANCELED, "preparation canceled")
}

pub fn check_cancel(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        Err(canceled_error())
    } else {
        Ok(())
    }
}

/// Atomic cancellation is shared with RunManager; keep pending IO responsive.
pub async fn cancelled(cancel: &AtomicBool) {
    while !cancel.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

/// 执行单个命令的默认最长等待（无取消信号时的兜底）
pub const EXEC_TIMEOUT: Duration = Duration::from_secs(600);

pub trait RuntimeHost: Send + Sync {
    /// Runtime 根目录（绝对路径；posix 远端已展开 ~）
    fn root(&self) -> &str;
    /// 目标是否为 Windows（影响路径分隔符与可执行文件名）
    fn is_windows(&self) -> bool;

    fn join(&self, base: &str, rel: &str) -> String {
        let sep = if self.is_windows() { '\\' } else { '/' };
        format!(
            "{}{}{}",
            base.trim_end_matches(['/', '\\']),
            sep,
            rel.trim_start_matches(['/', '\\'])
        )
    }

    /// 可执行文件名（Windows 追加 .exe）
    fn binary_name(&self, base: &str) -> String {
        if self.is_windows() && !base.to_lowercase().ends_with(".exe") {
            format!("{base}.exe")
        } else {
            base.to_string()
        }
    }

    /// 执行 argv（无 shell 解释参数；posix 远端由实现做严格引用）。
    /// 实现必须周期检查 cancel：置位后终止远程进程并返回 CANCELED 错误。
    fn exec<'a>(
        &'a self,
        argv: &'a [String],
        env: &'a [(String, String)],
        cwd: Option<&'a str>,
        input: Option<&'a [u8]>,
        cancel: &'a AtomicBool,
    ) -> BoxFuture<'a, Result<ExecResult>>;

    /// 覆盖写入文件并设置权限（mode 仅 posix 生效）
    fn write_file<'a>(
        &'a self,
        path: &'a str,
        data: &'a [u8],
        mode: u32,
    ) -> BoxFuture<'a, Result<()>>;

    /// 读取文件原始字节
    fn read_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Vec<u8>>>;

    /// 原子创建单级目录：true=创建成功，false=已存在
    fn mkdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<bool>>;

    fn mkdir_all<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<()>>;

    /// 同文件系统原子改名（发布 ready marker / uv 二进制用）
    fn rename<'a>(&'a self, from: &'a str, to: &'a str) -> BoxFuture<'a, Result<()>>;

    /// 删除文件或递归删除目录；调用方必须先验证路径包含于 Runtime 根目录
    fn remove<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<()>>;

    /// 路径存在性（不跟随链接判断由实现保证语义足够用于探测）
    fn exists<'a>(&'a self, path: &'a str) -> BoxFuture<'a, bool>;

    /// 列出目录条目名（不含 . / ..）；目录不存在返回空
    fn list<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Vec<String>>>;
}
