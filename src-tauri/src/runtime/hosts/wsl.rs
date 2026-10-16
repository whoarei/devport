//! WSL RuntimeHost：持久 helper + 结构化 exec 协议（00027 §13）。
//!
//! 文件操作通过带严格引用的短 sh 命令完成；大文件（uv 二进制）通过 exec stdin 写入。
//! cancel：stop 消息杀 exec 进程组；bridge 销毁时 EOF 兜底清理。
use crate::device::WslConfig;
use crate::error::{Result, RunnerError};
use crate::runner::sh_quote;
use crate::runtime::host::{check_cancel, ExecResult, RuntimeHost};
use crate::wsl::{exec_managed, Bridge};
use futures::future::BoxFuture;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

pub struct WslHost {
    config: WslConfig,
    bridge: Arc<tokio::sync::Mutex<Bridge>>,
    root: String,
}

impl WslHost {
    pub async fn open(config: WslConfig, root: &str) -> Result<Self> {
        config.validate()?;
        let bridge = Bridge::launch(crate::wsl::helper_command(&config)?).await?;
        Ok(Self {
            config,
            bridge: Arc::new(tokio::sync::Mutex::new(bridge)),
            root: root.to_string(),
        })
    }

    pub fn distribution(&self) -> &str {
        &self.config.distribution
    }

    pub(crate) async fn resolve_path(&self, path: &str) -> Result<String> {
        self.bridge.lock().await.resolve_path(path)
    }

    async fn exec_inner(
        &self,
        argv: &[String],
        env: &[(String, String)],
        cwd: Option<&str>,
        input: Option<&[u8]>,
    ) -> Result<ExecResult> {
        exec_managed(
            &mut *self.bridge.lock().await,
            argv,
            env,
            cwd,
            input.unwrap_or(&[]),
        )
        .await
    }

    async fn sh(&self, script: &str) -> Result<ExecResult> {
        self.exec_inner(
            &["/bin/sh".to_string(), "-c".to_string(), script.to_string()],
            &[],
            None,
            None,
        )
        .await
    }
}

impl RuntimeHost for WslHost {
    fn root(&self) -> &str {
        &self.root
    }

    fn is_windows(&self) -> bool {
        false
    }

    fn exec<'a>(
        &'a self,
        argv: &'a [String],
        env: &'a [(String, String)],
        cwd: Option<&'a str>,
        input: Option<&'a [u8]>,
        cancel: &'a AtomicBool,
    ) -> BoxFuture<'a, Result<ExecResult>> {
        Box::pin(async move {
            check_cancel(cancel)?;
            let result = self.exec_inner(argv, env, cwd, input).await;
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                return Err(crate::runtime::host::canceled_error());
            }
            result
        })
    }

    fn write_file<'a>(
        &'a self,
        path: &'a str,
        data: &'a [u8],
        mode: u32,
    ) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            // 严格引用路径；数据走 stdin，不拼进命令行
            let script = format!(
                "cat > {} && chmod {:o} {}",
                sh_quote(path),
                mode & 0o777,
                sh_quote(path)
            );
            let result = self
                .exec_inner(
                    &["/bin/sh".to_string(), "-c".to_string(), script],
                    &[],
                    None,
                    Some(data),
                )
                .await?;
            if result.success() {
                Ok(())
            } else {
                Err(RunnerError::Wsl(format!(
                    "write_file failed: {}",
                    result.tail(200)
                )))
            }
        })
    }

    fn read_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Vec<u8>>> {
        Box::pin(async move {
            let result = self
                .exec_inner(&["cat".to_string(), path.to_string()], &[], None, None)
                .await?;
            if result.success() {
                Ok(result.stdout)
            } else {
                Err(RunnerError::Wsl(format!(
                    "read_file failed: {}",
                    result.tail(200)
                )))
            }
        })
    }

    fn mkdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<bool>> {
        Box::pin(async move {
            let result = self
                .exec_inner(&["mkdir".to_string(), path.to_string()], &[], None, None)
                .await?;
            if result.success() {
                return Ok(true);
            }
            Ok(self.exists(path).await)
        })
    }

    fn mkdir_all<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let _ = self
                .exec_inner(
                    &["mkdir".to_string(), "-p".to_string(), path.to_string()],
                    &[],
                    None,
                    None,
                )
                .await?;
            Ok(())
        })
    }

    fn rename<'a>(&'a self, from: &'a str, to: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let result = self
                .exec_inner(
                    &["mv".to_string(), from.to_string(), to.to_string()],
                    &[],
                    None,
                    None,
                )
                .await?;
            if result.success() {
                Ok(())
            } else {
                Err(RunnerError::Wsl(format!(
                    "rename failed: {}",
                    result.tail(200)
                )))
            }
        })
    }

    fn remove<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let _ = self
                .exec_inner(
                    &["rm".to_string(), "-rf".to_string(), path.to_string()],
                    &[],
                    None,
                    None,
                )
                .await?;
            Ok(())
        })
    }

    fn exists<'a>(&'a self, path: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            self.sh(&format!("test -e {}", sh_quote(path)))
                .await
                .map(|r| r.success())
                .unwrap_or(false)
        })
    }

    fn list<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Vec<String>>> {
        Box::pin(async move {
            let result = self
                .exec_inner(
                    &["ls".to_string(), "-A".to_string(), path.to_string()],
                    &[],
                    None,
                    None,
                )
                .await?;
            if !result.success() {
                return Ok(Vec::new());
            }
            Ok(String::from_utf8_lossy(&result.stdout)
                .lines()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect())
        })
    }
}

/// 清理：Drop 时释放 bridge（wsl.exe kill_on_drop → helper EOF → finally 杀进程组）
impl Drop for WslHost {
    fn drop(&mut self) {
        if Arc::strong_count(&self.bridge) == 1 {
            // 持有最后一份引用：Bridge 随 Arc 销毁
        }
    }
}
