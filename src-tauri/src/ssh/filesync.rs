use crate::error::Result;
use crate::ssh::client::SshConnection;
use russh_sftp::client::SftpSession;
use std::path::Path;
use tokio::io::AsyncWriteExt;

pub async fn open_sftp(conn: &SshConnection) -> Result<SftpSession> {
    let channel = conn.handle.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    let sftp = SftpSession::new(channel.into_stream()).await?;
    Ok(sftp)
}

pub(crate) async fn resolve_path(conn: &SshConnection, path: &str) -> Result<String> {
    crate::device::validate_workspace_root(path)?;
    if path.starts_with("~/") {
        let home = open_sftp(conn).await?.canonicalize(".").await?;
        return crate::device::expand_home_path(path, &home);
    }
    Ok(path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_text_without_corrupting_binary_assets() {
        assert!(is_text_script("run"));
        assert!(is_text_script("TEST.SH"));
        assert!(!is_text_script("data.bin"));
        assert_eq!(normalize_lf(b"a\r\nb\r\n".to_vec()), b"a\nb\n");
        for data in [b"\0\r\n".as_slice(), b"\xff\r\n"] {
            assert_eq!(normalize_lf(data.to_vec()), data);
        }
    }
}

async fn mkdir_p(sftp: &SftpSession, path: &str) -> Result<()> {
    // 逐级创建目录，忽略“已存在”错误
    let mut current = String::new();
    for part in path.split('/') {
        if part.is_empty() {
            if current.is_empty() {
                current.push('/');
            }
            continue;
        }
        if !current.ends_with('/') && !current.is_empty() {
            current.push('/');
        }
        current.push_str(part);
        let p = current.trim_end_matches('/');
        if p.is_empty() {
            continue;
        }
        if let Err(error) = sftp.create_dir(p).await {
            if !sftp.metadata(p).await?.is_dir() {
                return Err(error.into());
            }
        }
    }
    Ok(())
}

/// 递归上传本地目录到远程目录（V1：全量同步）
pub async fn upload_dir(sftp: &SftpSession, local: &Path, remote: &str) -> Result<u64> {
    use crate::workspace_upload::{self, SSH};
    let local = local.to_path_buf();
    let sources = tokio::task::spawn_blocking(move || workspace_upload::scan(&local, SSH))
        .await
        .map_err(|e| crate::error::RunnerError::TaskFailed(e.to_string()))??;
    mkdir_p(sftp, remote).await?;
    let mut count = 0;
    let mut total = 0;
    for source in sources {
        // At most one bounded file is resident. All local filesystem work runs
        // off the Tokio executor, so other runs and Stop remain responsive.
        let entry = tokio::task::spawn_blocking(move || workspace_upload::read_source(source, SSH))
            .await
            .map_err(|e| crate::error::RunnerError::TaskFailed(e.to_string()))??;
        let path = format!("{}/{}", remote.trim_end_matches('/'), entry.path);
        if let Some(data) = entry.data {
            total += entry.source_bytes;
            if total > SSH.total_limit {
                return Err(crate::error::RunnerError::InvalidInput(
                    "SSH workspace total size limit exceeded".into(),
                ));
            }
            let mut file = sftp.create(&path).await?;
            for chunk in data.chunks(64 * 1024) {
                file.write_all(chunk).await?;
            }
            file.shutdown().await?;
            let mut permissions = russh_sftp::protocol::FileAttributes::default();
            permissions.permissions = Some(entry.mode);
            sftp.set_metadata(&path, permissions).await?;
            count += 1;
        } else {
            mkdir_p(sftp, &path).await?;
        }
    }
    Ok(count)
}

#[cfg(test)]
use crate::workspace_upload::{is_text_script, normalize_lf};
