//! Local RuntimeHost：本机文件系统 + 直接 spawn（不经 shell 解释参数）。
use crate::error::{Result, RunnerError};
use crate::runtime::host::{canceled_error, check_cancel, ExecResult, RuntimeHost};
use futures::future::BoxFuture;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 本机 Managed Runtime host；root 为本机绝对路径（应用数据目录下）
#[derive(Clone)]
pub struct LocalHost {
    root: String,
    windows: bool,
}

impl LocalHost {
    pub fn new(root: String) -> Result<Self> {
        crate::runtime::validate_runtime_root(&root, cfg!(windows))?;
        std::fs::create_dir_all(&root)?;
        Ok(Self {
            root,
            windows: cfg!(windows),
        })
    }

    fn native(path: &str) -> PathBuf {
        if cfg!(windows) {
            PathBuf::from(path.replace(['/'], "\\"))
        } else {
            PathBuf::from(path)
        }
    }

    fn remove_sync(path: &str) -> std::io::Result<()> {
        let native = Self::native(path);
        match std::fs::symlink_metadata(&native) {
            Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(&native),
            Ok(_) => std::fs::remove_file(&native),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }
}

impl RuntimeHost for LocalHost {
    fn root(&self) -> &str {
        &self.root
    }

    fn is_windows(&self) -> bool {
        self.windows
    }

    fn exec<'a>(
        &'a self,
        argv: &'a [String],
        env: &'a [(String, String)],
        cwd: Option<&'a str>,
        input: Option<&'a [u8]>,
        cancel: &'a AtomicBool,
    ) -> BoxFuture<'a, Result<ExecResult>> {
        // 参数复制为 owned：BoxFuture 生命周期只绑定 &self
        let argv: Vec<String> = argv.to_vec();
        let env: Vec<(String, String)> = env.to_vec();
        let cwd: Option<String> = cwd.map(str::to_string);
        let input: Vec<u8> = input.unwrap_or(&[]).to_vec();
        Box::pin(async move {
            check_cancel(cancel)?;
            if argv.is_empty() {
                return Err(RunnerError::InvalidInput("exec requires an argv".into()));
            }
            let mut command = tokio::process::Command::new(Self::native(&argv[0]));
            for arg in &argv[1..] {
                command.arg(Self::native(arg));
            }
            for (k, v) in &env {
                command.env(k, v);
            }
            if let Some(cwd) = &cwd {
                command.current_dir(Self::native(cwd));
            }
            command
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true);
            let mut child = command.spawn()?;
            if !input.is_empty() {
                let mut stdin = child.stdin.take().unwrap();
                stdin.write_all(&input).await?;
                drop(stdin); // EOF：uv 等子进程需要 stdin 关闭才会退出
            }
            let pid = child.id();
            // 并发读取管道，避免子进程写满管道阻塞导致 wait 死锁
            let mut stdout_pipe = child.stdout.take().unwrap();
            let mut stderr_pipe = child.stderr.take().unwrap();
            let stdout_task = tokio::spawn(async move {
                let mut data = Vec::new();
                let _ = stdout_pipe.read_to_end(&mut data).await;
                data
            });
            let stderr_task = tokio::spawn(async move {
                let mut data = Vec::new();
                let _ = stderr_pipe.read_to_end(&mut data).await;
                data
            });
            // 取消感知等待；退出后收集读取结果
            let status = loop {
                tokio::select! {
                    biased;
                    status = child.wait() => break status?,
                    _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                        if cancel.load(Ordering::Relaxed) {
                            let _ = child.start_kill();
                            kill_tree(self.windows, pid);
                            return Err(canceled_error());
                        }
                    }
                }
            };
            let stdout = stdout_task.await.unwrap_or_default();
            let stderr = stderr_task.await.unwrap_or_default();
            Ok(ExecResult {
                code: status.code(),
                stdout,
                stderr,
            })
        })
    }

    fn write_file<'a>(
        &'a self,
        path: &'a str,
        data: &'a [u8],
        mode: u32,
    ) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let native = Self::native(path);
            if let Some(parent) = native.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&native, data)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&native, std::fs::Permissions::from_mode(mode & 0o777))?;
            }
            let _ = mode;
            Ok(())
        })
    }

    fn read_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Vec<u8>>> {
        Box::pin(async move { Ok(std::fs::read(Self::native(path))?) })
    }

    fn mkdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<bool>> {
        Box::pin(async move {
            match std::fs::create_dir(Self::native(path)) {
                Ok(()) => Ok(true),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
                Err(e) => Err(e.into()),
            }
        })
    }

    fn mkdir_all<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            std::fs::create_dir_all(Self::native(path))?;
            Ok(())
        })
    }

    fn rename<'a>(&'a self, from: &'a str, to: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            std::fs::rename(Self::native(from), Self::native(to))?;
            Ok(())
        })
    }

    fn remove<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move { Ok(Self::remove_sync(path)?) })
    }

    fn exists<'a>(&'a self, path: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(async move { std::fs::symlink_metadata(Self::native(path)).is_ok() })
    }

    fn list<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Vec<String>>> {
        Box::pin(async move {
            let Ok(entries) = std::fs::read_dir(Self::native(path)) else {
                return Ok(Vec::new());
            };
            let mut names = Vec::new();
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    names.push(name.to_string());
                }
            }
            names.sort();
            Ok(names)
        })
    }
}

/// Windows 下终止整棵进程树（uv sync 可能拉起 build backend 子进程）
fn kill_tree(windows: bool, pid: Option<u32>) {
    if windows {
        if let Some(pid) = pid {
            let _ = std::process::Command::new("taskkill.exe")
                .args(["/T", "/F", "/PID"])
                .arg(pid.to_string())
                .output();
        }
    }
}

impl Drop for LocalHost {
    fn drop(&mut self) {
        let _ = Path::new(&self.root);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::sync::atomic::AtomicBool;

    fn host() -> (LocalHost, PathBuf) {
        let root = std::env::temp_dir().join(format!("rr-lhost-{}", uuid::Uuid::new_v4()));
        (
            LocalHost::new(root.to_string_lossy().into_owned()).unwrap(),
            root,
        )
    }

    #[tokio::test]
    async fn fs_ops_roundtrip() {
        let (host, root) = host();
        host.mkdir_all(&host.join(host.root(), "a/b"))
            .await
            .unwrap();
        assert!(host.mkdir(&host.join(host.root(), "a/c")).await.unwrap());
        assert!(!host.mkdir(&host.join(host.root(), "a/c")).await.unwrap());

        let file = host.join(host.root(), "a/b/f.txt");
        host.write_file(&file, b"hello", 0o644).await.unwrap();
        assert_eq!(host.read_file(&file).await.unwrap(), b"hello");
        assert!(host.exists(&file).await);
        assert_eq!(
            host.list(&host.join(host.root(), "a")).await.unwrap(),
            vec!["b", "c"]
        );

        let renamed = host.join(host.root(), "a/b/g.txt");
        host.rename(&file, &renamed).await.unwrap();
        assert!(!host.exists(&file).await);
        host.remove(&host.join(host.root(), "a")).await.unwrap();
        assert!(!host.exists(&host.join(host.root(), "a")).await);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// exec 用 `/bin/sh` 语义验证；Windows 本机无 posix shell，按惯例自动跳过
    #[cfg(unix)]
    #[tokio::test]
    async fn exec_roundtrip_unix_shell() {
        let (host, root) = host();
        let cancel = AtomicBool::new(false);
        let result = host
            .exec(
                &[
                    "/bin/sh".into(),
                    "-c".into(),
                    "cat; echo err >&2; exit 3".into(),
                ],
                &[],
                None,
                Some(b"in"),
                &cancel,
            )
            .await
            .unwrap();
        assert_eq!(result.code, Some(3));
        assert_eq!(result.stdout, b"in");
        assert_eq!(result.stderr, b"err\n");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn exec_cancel_terminates_process() {
        let (host, root) = host();
        let cancel = AtomicBool::new(false);
        let argv = [
            "/bin/sh".to_string(),
            "-c".to_string(),
            "sleep 30".to_string(),
        ];
        let exec_fut = host.exec(&argv, &[], None, None, &cancel);
        tokio::pin!(exec_fut);
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => {}
            _ = &mut exec_fut => panic!("sleep 30 should not finish before cancel"),
        }
        cancel.store(true, Ordering::Relaxed);
        let result = exec_fut.await;
        assert!(result
            .unwrap_err()
            .to_string()
            .contains(crate::runtime::code::CANCELED));
        std::fs::remove_dir_all(root).unwrap();
    }
}
