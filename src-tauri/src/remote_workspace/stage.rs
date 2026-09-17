//! 跨设备运行的暂存下载：把远端工作区复制到本机临时目录，
//! 之后完全复用既有的本机工作区上传管线（00029 §3.4）。
//!
//! 限额与过滤对齐 SSH 上传策略（workspace_upload::SSH）：64 MiB/文件、
//! 256 MiB/总量、4096 条目、1024 路径长度，跳过 .git/.hg/.svn；
//! 符号链接在 list_dir 层已被过滤。运行结束后由 Drop 清理临时目录。
use super::RemoteWorkspace;
use crate::device::DeviceProfile;
use crate::error::{Result, RunnerError};
use crate::workspace_upload;
use std::path::{Path, PathBuf};

/// 远端返回的条目名必须是可安全落到本机的单一路径组件。
/// `components` 面向相对路径（按 `/` 分段逐段校验），所以还要额外要求
/// 恰好一段：否则 "a/b" 会被拼成本地子目录而不是一个文件名。
fn safe_name(name: &str) -> Result<()> {
    let parts = crate::workspace::components(name)
        .map_err(|_| failed(format!("远端工作区返回了非法条目名：{name:?}")))?;
    if parts.len() != 1 {
        return Err(failed(format!("远端工作区返回了非法条目名：{name:?}")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::safe_name;

    #[test]
    fn only_plain_component_names_reach_the_local_staging_directory() {
        for good in ["main.py", ".python-version", "sub dir", "a-b_c.txt"] {
            assert!(safe_name(good).is_ok(), "should accept {good:?}");
        }
        // 远端响应是半可信输入：路径穿越、分隔符、Windows 保留名与控制字符
        // 都不能变成暂存目录里的本地路径
        for bad in [
            "..",
            ".",
            "",
            "a/b",
            "..\\x",
            "C:evil",
            "aux",
            "nul.txt",
            "trailing.",
            "trail ",
            "a\0b",
            "a\nb",
        ] {
            assert!(safe_name(bad).is_err(), "should reject {bad:?}");
        }
    }
}

pub struct Staging {
    dir: PathBuf,
}

impl Staging {
    pub fn path(&self) -> &Path {
        &self.dir
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.dir) {
            tracing::warn!("cleanup staging {} failed: {error}", self.dir.display());
        }
    }
}

fn failed(message: impl Into<String>) -> RunnerError {
    RunnerError::TaskFailed(message.into())
}

/// 下载 source 设备上的 workspace 到本机临时目录
pub async fn download(
    source: &DeviceProfile,
    config_dir: &Path,
    path: &str,
    run_id: &str,
) -> Result<Staging> {
    let mut remote = RemoteWorkspace::open(source, config_dir, path)
        .await
        .map_err(|e| failed(format!("打开远端工作区失败：{}", e.message)))?;
    let dir = std::env::temp_dir().join(format!("remote-runner-stage-{run_id}"));
    tokio::fs::create_dir_all(&dir).await?;
    let staging = Staging { dir };
    // 失败路径由 staging 的 Drop 负责清理半成品目录
    download_tree(&mut remote, &staging.dir).await?;
    tracing::info!(
        "staged remote workspace {}:{} for run {run_id} at {}",
        source.name,
        path,
        staging.dir.display()
    );
    Ok(staging)
}

async fn download_tree(remote: &mut RemoteWorkspace, local: &Path) -> Result<()> {
    let policy = workspace_upload::SSH;
    let mut entries = 0usize;
    let mut total = 0u64;
    // 显式栈避免异步递归；（相对目录, 本机目录）
    let mut stack = vec![(String::new(), local.to_path_buf())];
    while let Some((rel, dir)) = stack.pop() {
        let list = remote
            .list_dir(&rel)
            .await
            .map_err(|e| failed(format!("列举远端目录失败：{}", e.message)))?;
        for entry in list {
            if matches!(entry.name.as_str(), ".git" | ".hg" | ".svn") {
                continue;
            }
            // 文件名来自远端：落到本机前逐条校验，拒绝 . / ..、分隔符与保留名
            safe_name(&entry.name)?;
            entries += 1;
            if entries > policy.entry_limit {
                return Err(failed(format!(
                    "远端工作区条目超过 {} 上限",
                    policy.entry_limit
                )));
            }
            let child_rel = if rel.is_empty() {
                entry.name.clone()
            } else {
                format!("{rel}/{}", entry.name)
            };
            if child_rel.len() > policy.path_limit {
                return Err(failed(format!(
                    "远端工作区路径超过 {} 上限",
                    policy.path_limit
                )));
            }
            let target = dir.join(&entry.name);
            if entry.is_dir {
                tokio::fs::create_dir(&target).await?;
                stack.push((child_rel, target));
            } else {
                let data = remote
                    .read_raw(&child_rel, policy.file_limit)
                    .await
                    .map_err(|e| failed(format!("下载 {child_rel} 失败：{}", e.message)))?;
                total += data.len() as u64;
                if total > policy.total_limit as u64 {
                    return Err(failed(format!(
                        "远端工作区总大小超过 {} 上限",
                        policy.total_limit
                    )));
                }
                tokio::fs::write(&target, &data).await?;
            }
        }
    }
    Ok(())
}
