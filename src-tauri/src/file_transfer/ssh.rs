use super::{error, host::Handle, relative, Attributes, Entry, Result, CHUNK, ENTRY_LIMIT};
use crate::{device::DeviceProfile, ssh::client::SshConnection};
use russh_sftp::{
    client::{error::Error, RawSftpSession},
    protocol::{FileAttributes, OpenFlags, Packet, StatusCode},
};
use std::{
    path::Path,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    sync::watch,
};

/// russh-sftp 2.4 keeps pending replies until their timeout on EOF. Monitor the
/// stream so a disconnected peer fails immediately, including during commit.
struct Monitored<S> {
    stream: S,
    closed: watch::Sender<bool>,
    prefix: [u8; 4],
    prefix_len: usize,
    remaining: usize,
}
impl<S> Monitored<S> {
    fn new(stream: S, closed: watch::Sender<bool>) -> Self {
        Self {
            stream,
            closed,
            prefix: [0; 4],
            prefix_len: 0,
            remaining: 0,
        }
    }
    fn frame_bytes(&mut self, mut bytes: &[u8]) -> std::io::Result<()> {
        while !bytes.is_empty() {
            if self.remaining > 0 {
                let count = self.remaining.min(bytes.len());
                self.remaining -= count;
                bytes = &bytes[count..];
                continue;
            }
            let count = (4 - self.prefix_len).min(bytes.len());
            self.prefix[self.prefix_len..self.prefix_len + count].copy_from_slice(&bytes[..count]);
            self.prefix_len += count;
            bytes = &bytes[count..];
            if self.prefix_len == 4 {
                self.remaining = u32::from_be_bytes(self.prefix) as usize;
                self.prefix_len = 0;
                if self.remaining == 0 || self.remaining > 256 * 1024 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "SFTP response exceeds 256 KiB",
                    ));
                }
            }
        }
        Ok(())
    }
}
impl<S: AsyncRead + Unpin> AsyncRead for Monitored<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let previous = buf.filled().len();
        let room = buf.remaining();
        let result = Pin::new(&mut self.stream).poll_read(cx, buf);
        if matches!(&result, Poll::Ready(Ok(()))) {
            if let Err(error) = self.frame_bytes(&buf.filled()[previous..]) {
                self.closed.send_replace(true);
                return Poll::Ready(Err(error));
            }
        }
        if matches!(&result, Poll::Ready(Err(_)))
            || (matches!(&result, Poll::Ready(Ok(())))
                && room > 0
                && buf.filled().len() == previous)
        {
            self.closed.send_replace(true);
        }
        result
    }
}
impl<S: AsyncWrite + Unpin> AsyncWrite for Monitored<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let result = Pin::new(&mut self.stream).poll_write(cx, bytes);
        if matches!(&result, Poll::Ready(Err(_))) {
            self.closed.send_replace(true);
        }
        result
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}
async fn monitored<T>(
    closed: &watch::Sender<bool>,
    future: impl std::future::Future<Output = std::result::Result<T, Error>>,
) -> std::result::Result<T, Error> {
    let mut receiver = closed.subscribe();
    if *receiver.borrow() {
        return Err(Error::UnexpectedBehavior("SFTP connection closed".into()));
    }
    tokio::select! { biased; result = future => result, _ = receiver.changed() => Err(Error::UnexpectedBehavior("SFTP connection closed before acknowledgement".into())) }
}

pub(crate) struct SshHost {
    _connection: SshConnection,
    session: RawSftpSession,
    closed: watch::Sender<bool>,
    pub root: String,
    pub overwrite: bool,
    pub hardlink: bool,
    fsync: bool,
}

fn map(e: Error) -> crate::workspace::FileError {
    match e {
        Error::Status(status) => error(
            match status.status_code {
                StatusCode::NoSuchFile => "not_found",
                StatusCode::PermissionDenied => "permission",
                StatusCode::OpUnsupported => "unsupported",
                _ => "remote",
            },
            status.error_message,
        ),
        e => error("io", e.to_string()),
    }
}

fn attrs(a: &FileAttributes) -> Attributes {
    Attributes {
        kind: if a.is_symlink() {
            "link"
        } else if a.is_dir() {
            "dir"
        } else if a.is_regular() {
            "file"
        } else {
            "special"
        }
        .into(),
        size: a.len(),
        modified: a
            .mtime
            .map(|n| (u64::from(n) * 1_000_000_000).to_string())
            .unwrap_or_default(),
        mode: a.permissions.map(|n| n & 0o777),
        identity: format!("{:?}:{:?}", a.uid, a.gid),
    }
}

impl SshHost {
    pub async fn open(device: &DeviceProfile, config: &Path, path: &str) -> Result<Self> {
        let connection = SshConnection::connect(device, config)
            .await
            .map_err(|e| error("io", e.to_string()))?;
        let channel = connection
            .handle
            .channel_open_session()
            .await
            .map_err(|e| error("io", e.to_string()))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| error("io", e.to_string()))?;
        let (closed, _) = watch::channel(false);
        let session = RawSftpSession::new(Monitored::new(channel.into_stream(), closed.clone()));
        session.set_timeout(60);
        let version = monitored(&closed, session.init()).await.map_err(map)?;
        if version.version != 3 {
            return Err(error("unsupported", "SFTP version 3 required"));
        }
        let has = |name: &str| version.extensions.get(name).is_some_and(|v| v == "1");
        let path = if path.starts_with("~/") {
            let home = monitored(&closed, session.realpath("."))
                .await
                .map_err(map)?
                .files
                .first()
                .ok_or_else(|| error("io", "Missing home directory"))?
                .filename
                .clone();
            crate::device::expand_home_path(path, &home)
                .map_err(|e| error("path", e.to_string()))?
        } else {
            path.to_string()
        };
        let root = monitored(&closed, session.realpath(path))
            .await
            .map_err(map)?
            .files
            .first()
            .ok_or_else(|| error("io", "Missing canonical root"))?
            .filename
            .clone();
        let host = Self {
            _connection: connection,
            session,
            closed,
            root,
            overwrite: has("posix-rename@openssh.com"),
            hardlink: has("hardlink@openssh.com"),
            fsync: has("fsync@openssh.com"),
        };
        if host.stat("").await?.is_none_or(|a| a.kind != "dir") {
            return Err(error("path", "Root is not a directory"));
        }
        Ok(host)
    }

    async fn path(&self, relative_path: &str, missing: bool) -> Result<String> {
        let root = monitored(&self.closed, self.session.lstat(&self.root))
            .await
            .map_err(map)?
            .attrs;
        if root.is_symlink() || !root.is_dir() {
            return Err(error("path", "Transfer root changed or became a link"));
        }
        let parts = if relative_path.is_empty() {
            vec![]
        } else {
            relative(relative_path)?
        };
        let mut path = self.root.trim_end_matches('/').to_owned();
        for (index, part) in parts.iter().enumerate() {
            path.push('/');
            path.push_str(part);
            match monitored(&self.closed, self.session.lstat(&path)).await {
                Ok(a) => {
                    if a.attrs.is_symlink() || (index + 1 < parts.len() && !a.attrs.is_dir()) {
                        return Err(error(
                            "path",
                            "Links or non-directory ancestors are not supported",
                        ));
                    }
                }
                Err(Error::Status(s)) if missing && s.status_code == StatusCode::NoSuchFile => {}
                Err(e) => return Err(map(e)),
            }
        }
        if path.is_empty() {
            path.push('/');
        }
        Ok(path)
    }

    pub async fn stat(&self, path: &str) -> Result<Option<Attributes>> {
        let path = self.path(path, true).await?;
        match monitored(&self.closed, self.session.lstat(path)).await {
            Ok(a) => Ok(Some(attrs(&a.attrs))),
            Err(Error::Status(s)) if s.status_code == StatusCode::NoSuchFile => Ok(None),
            Err(e) => Err(map(e)),
        }
    }

    pub async fn list(&self, path: &str) -> Result<Vec<Entry>> {
        let path = self.path(path, false).await?;
        let handle = monitored(&self.closed, self.session.opendir(path))
            .await
            .map_err(map)?
            .handle;
        let result = async {
            let mut entries = Vec::new();
            loop {
                match monitored(&self.closed, self.session.readdir(&handle)).await {
                    Ok(names) => {
                        for entry in names.files {
                            if matches!(entry.filename.as_str(), "." | "..") {
                                continue;
                            }
                            if entries.len() >= ENTRY_LIMIT {
                                return Err(error("too_large", "Directory exceeds 10000 entries"));
                            }
                            entries.push(Entry {
                                name: entry.filename,
                                attrs: attrs(&entry.attrs),
                            });
                        }
                    }
                    Err(Error::Status(s)) if s.status_code == StatusCode::Eof => break,
                    Err(e) => return Err(map(e)),
                }
            }
            Ok(entries)
        }
        .await;
        let _ = monitored(&self.closed, self.session.close(handle)).await;
        result
    }

    pub async fn mkdir(&self, path: &str) -> Result<()> {
        if let Some(a) = self.stat(path).await? {
            return if a.kind == "dir" {
                Ok(())
            } else {
                Err(error("conflict", "File/directory type conflict"))
            };
        }
        monitored(
            &self.closed,
            self.session
                .mkdir(self.path(path, true).await?, FileAttributes::empty()),
        )
        .await
        .map_err(map)?;
        Ok(())
    }

    pub async fn open_file(&self, path: &str, create: bool) -> Result<(Handle, Attributes)> {
        if create && !self.hardlink && !self.overwrite {
            return Err(error(
                "unsupported",
                "SFTP server lacks safe publication extensions",
            ));
        }
        let path = self.path(path, create).await?;
        let mut a = FileAttributes::empty();
        if create {
            a.permissions = Some(0o600);
        }
        let flags = if create {
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE
        } else {
            OpenFlags::READ
        };
        let handle = monitored(&self.closed, self.session.open(path, flags, a))
            .await
            .map_err(map)?
            .handle;
        let meta = monitored(&self.closed, self.session.fstat(&handle))
            .await
            .map_err(map)?
            .attrs;
        if !meta.is_regular() {
            let _ = monitored(&self.closed, self.session.close(handle)).await;
            return Err(error("path", "Not a regular file"));
        }
        Ok((Handle::Remote(handle), attrs(&meta)))
    }

    pub async fn read(&self, handle: &str, offset: u64) -> Result<Vec<u8>> {
        match monitored(
            &self.closed,
            self.session.read(handle, offset, CHUNK as u32),
        )
        .await
        {
            Ok(data) => Ok(data.data),
            Err(Error::Status(s)) if s.status_code == StatusCode::Eof => Ok(vec![]),
            Err(e) => Err(map(e)),
        }
    }
    pub async fn write(&self, handle: &str, offset: u64, data: Vec<u8>) -> Result<()> {
        monitored(&self.closed, self.session.write(handle, offset, data))
            .await
            .map_err(map)?;
        Ok(())
    }
    pub async fn close(
        &self,
        handle: String,
        writing: bool,
        mode: Option<u32>,
    ) -> Result<Attributes> {
        let result = async {
            if writing {
                if let Some(mode) = mode {
                    let mut a = FileAttributes::empty();
                    a.permissions = Some(mode & 0o777);
                    monitored(&self.closed, self.session.fsetstat(&handle, a))
                        .await
                        .map_err(map)?;
                }
                if self.fsync {
                    monitored(&self.closed, self.session.fsync(&handle))
                        .await
                        .map_err(map)?;
                }
            }
            Ok(attrs(
                &monitored(&self.closed, self.session.fstat(&handle))
                    .await
                    .map_err(map)?
                    .attrs,
            ))
        }
        .await;
        monitored(&self.closed, self.session.close(handle))
            .await
            .map_err(map)?;
        result
    }
    pub async fn commit(&self, temp: &str, path: &str, overwrite: bool) -> Result<()> {
        let temp = self.path(temp, false).await?;
        let target = self.path(path, true).await?;
        if overwrite {
            if !self.overwrite {
                return Err(error("unsupported", "SFTP server lacks atomic overwrite"));
            }
            let mut data = Vec::new();
            for path in [temp, target] {
                data.extend_from_slice(&(path.len() as u32).to_be_bytes());
                data.extend_from_slice(path.as_bytes());
            }
            match monitored(
                &self.closed,
                self.session.extended("posix-rename@openssh.com", data),
            )
            .await
            .map_err(map)?
            {
                Packet::Status(s) if s.status_code == StatusCode::Ok => Ok(()),
                Packet::Status(s) => Err(map(Error::Status(s))),
                _ => Err(error("unknown", "Unexpected commit acknowledgement")),
            }
        } else {
            if !self.hardlink {
                return Err(error("unsupported", "SFTP server lacks safe publication"));
            }
            monitored(&self.closed, self.session.hardlink(&temp, target))
                .await
                .map_err(map)?;
            // The file has been published. Cleanup is tracked separately by the manager.
            Ok(())
        }
    }
    pub async fn remove(&self, path: &str) -> Result<()> {
        monitored(
            &self.closed,
            self.session.remove(self.path(path, true).await?),
        )
        .await
        .map_err(map)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[tokio::test]
    async fn oversized_sftp_frame_fails_before_the_library_allocates_its_payload() {
        let (client, mut peer) = tokio::io::duplex(128);
        let (closed, _) = watch::channel(false);
        let session = RawSftpSession::new(Monitored::new(client, closed.clone()));
        let peer = tokio::spawn(async move {
            let mut request = [0; 64];
            peer.read(&mut request).await.unwrap();
            // A hostile frame header must never trigger a four-gigabyte allocation.
            peer.write_all(&u32::MAX.to_be_bytes()).await.unwrap();
        });
        assert!(tokio::time::timeout(
            std::time::Duration::from_secs(1),
            monitored(&closed, session.init())
        )
        .await
        .unwrap()
        .is_err());
        peer.await.unwrap();
    }
}
