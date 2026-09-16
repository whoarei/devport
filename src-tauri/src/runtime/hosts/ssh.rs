//! SSH RuntimeHost：独立 exec channel + SFTP 文件操作 + 可取消进程组 kill。
//!
//! 远程命令通过 `/bin/sh -c` 执行并对每个参数做严格引用（sh_quote）；
//! 长命令包装 PID marker，cancel 时按进程树 INT→KILL 清理（与 runner 语义对齐）。
use crate::error::{Result, RunnerError};
use crate::runner::sh_quote;
use crate::runtime::host::{canceled_error, check_cancel, ExecResult, RuntimeHost};
use futures::future::BoxFuture;
use russh::ChannelMsg;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// SSH 会话的 Managed Runtime host；Handle 可克隆，支持 heartbeat 并发写
#[derive(Clone)]
pub struct SshHost {
    handle: Arc<russh::client::Handle<crate::ssh::client::ClientHandler>>,
    root: String,
}

impl SshHost {
    pub fn new(
        handle: russh::client::Handle<crate::ssh::client::ClientHandler>,
        root: String,
    ) -> Self {
        Self {
            handle: Arc::new(handle),
            root,
        }
    }

    /// 与已有 SSH 连接共享同一 Handle（RunManager 集成用）
    pub fn from_arc(
        handle: Arc<russh::client::Handle<crate::ssh::client::ClientHandler>>,
        root: String,
    ) -> Self {
        Self { handle, root }
    }

    pub fn handle(&self) -> &russh::client::Handle<crate::ssh::client::ClientHandler> {
        &self.handle
    }

    fn sftp(&self) -> BoxFuture<'_, Result<russh_sftp::client::SftpSession>> {
        Box::pin(async move {
            let channel = self.handle.channel_open_session().await?;
            channel.request_subsystem(true, "sftp").await?;
            Ok(russh_sftp::client::SftpSession::new(channel.into_stream()).await?)
        })
    }

    /// 用独立 channel 执行一条短 shell 命令（不捕获 PID）
    async fn sh(&self, script: &str, cancel: &AtomicBool) -> Result<ExecResult> {
        self.exec(
            &["/bin/sh".to_string(), "-c".to_string(), script.to_string()],
            &[],
            None,
            None,
            cancel,
        )
        .await
    }
}

/// PID marker：首行输出，用于 cancel 时定位远程进程组
fn pid_marker() -> String {
    format!("__RRPID_{}___", uuid::Uuid::new_v4().simple())
}

/// 按 PID 杀远程进程树（与 runner 的 kill_remote_tree 语义一致）
async fn kill_remote_pid(
    handle: &russh::client::Handle<crate::ssh::client::ClientHandler>,
    pid: u32,
    sig: &str,
) {
    let script = format!(
        "pkill -{sig} -P {pid} 2>/dev/null; kill -{sig} {pid} 2>/dev/null; kill -{sig} -- -{pid} 2>/dev/null; true"
    );
    let run = async {
        let mut channel = handle.channel_open_session().await?;
        channel.exec(false, script.as_str()).await?;
        while channel.wait().await.is_some() {}
        Ok::<(), russh::Error>(())
    };
    match tokio::time::timeout(Duration::from_secs(5), run).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => tracing::warn!("kill remote pid {pid}: {e}"),
        Err(_) => tracing::warn!("kill remote pid {pid} timed out"),
    }
}

impl RuntimeHost for SshHost {
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
            if argv.is_empty() {
                return Err(RunnerError::InvalidInput("exec requires an argv".into()));
            }
            // 包装：PID marker + env + argv（严格引用，不拼接未验证输入）
            let marker = pid_marker();
            let mut quoted = String::new();
            for (k, v) in env {
                quoted.push_str(&format!("{}={} ", k, sh_quote(v)));
            }
            for arg in argv {
                quoted.push_str(&sh_quote(arg));
                quoted.push(' ');
            }
            let cd = cwd
                .map(|c| format!("cd {} && ", sh_quote(c)))
                .unwrap_or_default();
            // marker 由包装 shell 打印；exec 使最终 PID 即该 shell 的 PID
            let script = format!("printf '{marker}%s{marker}\\n' \"$$\"; {cd}exec env {quoted}");
            let mut channel =
                tokio::time::timeout(Duration::from_secs(10), self.handle.channel_open_session())
                    .await
                    .map_err(|_| RunnerError::Ssh("ssh channel open timed out".into()))??;
            channel.exec(true, script.as_str()).await?;

            if let Some(data) = input {
                channel.data(data).await?;
            }
            // 半关闭 stdin，让 `cat` 类命令读到 EOF
            let _ = channel.eof().await;

            let mut result = ExecResult::default();
            let mut pid: Option<u32> = None;
            let mut first_line = Vec::new();
            loop {
                if cancel.load(Ordering::Relaxed) {
                    let _ = channel.signal(russh::Sig::KILL).await;
                    let _ = channel.close().await;
                    if let Some(pid) = pid {
                        kill_remote_pid(&self.handle, pid, "KILL").await;
                    }
                    return Err(canceled_error());
                }
                let tick = tokio::time::sleep(Duration::from_millis(100));
                let msg = tokio::time::timeout(Duration::from_secs(1), channel.wait());
                tokio::select! {
                    msg = msg => {
                        match msg {
                            Ok(Some(ChannelMsg::Data { data })) => {
                                if pid.is_some() {
                                    result.stdout.extend_from_slice(&data);
                                    continue;
                                }
                                first_line.extend_from_slice(&data);
                                if let Some(end) = first_line.iter().position(|&b| b == b'\n') {
                                    let mut line: Vec<u8> = first_line.drain(..=end).collect();
                                    line.pop(); // 去掉 '\n'
                                    if let Some(rest) = line.strip_prefix(marker.as_bytes()) {
                                        if let Some(digits) = rest.strip_suffix(marker.as_bytes()) {
                                            pid = String::from_utf8_lossy(digits)
                                                .parse::<u32>()
                                                .ok()
                                                .filter(|p| *p > 1);
                                        }
                                    }
                                    if pid.is_some() {
                                        // marker 剥离，其余字节进入正常输出
                                        result.stdout.append(&mut first_line);
                                    } else {
                                        line.push(b'\n');
                                        result.stdout.append(&mut line);
                                        result.stdout.append(&mut first_line);
                                    }
                                } else if first_line.len() > 4096 {
                                    // 无换行的超长首行：不是 marker，按普通输出放行
                                    result.stdout.append(&mut first_line);
                                }
                            }
                            Ok(Some(ChannelMsg::ExtendedData { data, .. })) => {
                                result.stderr.extend_from_slice(&data);
                            }
                            Ok(Some(ChannelMsg::ExitStatus { exit_status })) => {
                                result.code = Some(exit_status as i32);
                            }
                            Ok(Some(ChannelMsg::ExitSignal { .. })) => result.code = None,
                            Ok(Some(ChannelMsg::Eof)) => {}
                            Ok(Some(ChannelMsg::Close)) | Ok(None) => break,
                            Ok(Some(_)) => {}
                            Err(_) => continue,
                        }
                    }
                    _ = tick => {}
                }
            }
            // marker 未出现且没收到任何行：把缓冲原样输出
            if pid.is_none() && !first_line.is_empty() {
                result.stdout.extend_from_slice(&first_line);
            }
            Ok(result)
        })
    }

    fn write_file<'a>(
        &'a self,
        path: &'a str,
        data: &'a [u8],
        mode: u32,
    ) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let sftp = self.sftp().await?;
            let mut file = sftp.create(path).await?;
            use tokio::io::AsyncWriteExt;
            for chunk in data.chunks(64 * 1024) {
                file.write_all(chunk).await?;
            }
            file.shutdown().await?;
            let mut attributes = russh_sftp::protocol::FileAttributes::default();
            attributes.permissions = Some(mode & 0o777);
            sftp.set_metadata(path, attributes).await?;
            Ok(())
        })
    }

    fn read_file<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Vec<u8>>> {
        Box::pin(async move {
            let sftp = self.sftp().await?;
            Ok(sftp.read(path).await?)
        })
    }

    fn mkdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<bool>> {
        Box::pin(async move {
            // mkdir（无 -p）是 posix 原子建目录语义：0=创建，非 0=已存在或失败
            let result = self
                .exec(
                    &["mkdir".to_string(), path.to_string()],
                    &[],
                    None,
                    None,
                    &AtomicBool::new(false),
                )
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
                .exec(
                    &["mkdir".to_string(), "-p".to_string(), path.to_string()],
                    &[],
                    None,
                    None,
                    &AtomicBool::new(false),
                )
                .await?;
            Ok(())
        })
    }

    fn rename<'a>(&'a self, from: &'a str, to: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let script = format!("mv -- {} {}", sh_quote(from), sh_quote(to));
            let result = self.sh(&script, &AtomicBool::new(false)).await?;
            if result.success() {
                Ok(())
            } else {
                Err(RunnerError::Ssh(format!(
                    "rename failed: {}",
                    result.tail(200)
                )))
            }
        })
    }

    fn remove<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<()>> {
        Box::pin(async move {
            let script = format!("rm -rf -- {}", sh_quote(path));
            let _ = self.sh(&script, &AtomicBool::new(false)).await?;
            Ok(())
        })
    }

    fn exists<'a>(&'a self, path: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            let script = format!("test -e {}", sh_quote(path));
            self.sh(&script, &AtomicBool::new(false))
                .await
                .map(|r| r.success())
                .unwrap_or(false)
        })
    }

    fn list<'a>(&'a self, path: &'a str) -> BoxFuture<'a, Result<Vec<String>>> {
        Box::pin(async move {
            let result = self
                .exec(
                    &["ls".to_string(), "-A".to_string(), path.to_string()],
                    &[],
                    None,
                    None,
                    &AtomicBool::new(false),
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
