use super::{
    error, relative, ssh::SshHost, wsl::WslHost, Attributes, Entry, Result, CHUNK, ENTRY_LIMIT,
};
use crate::{
    device::{DeviceProfile, TransportKind},
    workspace_ref::WorkspaceRef,
};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

pub(super) enum Host {
    Local(PathBuf),
    Ssh(SshHost),
    Wsl(WslHost),
}
pub(super) enum Handle {
    Local(tokio::fs::File),
    Remote(String),
}

pub(super) fn attributes(meta: &fs::Metadata) -> Attributes {
    #[cfg(unix)]
    let (mode, identity) = {
        use std::os::unix::fs::MetadataExt;
        (
            Some(meta.mode() & 0o777),
            format!("{}:{}", meta.dev(), meta.ino()),
        )
    };
    #[cfg(not(unix))]
    let (mode, identity) = (None, format!("{:?}", meta.created().ok()));
    Attributes {
        kind: if crate::workspace::redirected(meta) {
            "link"
        } else if meta.is_dir() {
            "dir"
        } else if meta.is_file() {
            "file"
        } else {
            "special"
        }
        .into(),
        size: meta.len(),
        modified: meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos().to_string())
            .unwrap_or_default(),
        mode,
        identity,
    }
}

fn local_path(root: &Path, path: &str, missing: bool) -> Result<PathBuf> {
    if crate::workspace::canonical_root(
        root.to_str()
            .ok_or_else(|| error("path", "Non UTF-8 transfer root"))?,
    )? != root
    {
        return Err(error("path", "Transfer root or ancestor changed"));
    }
    let parts = if path.is_empty() {
        vec![]
    } else {
        relative(path)?
    };
    let mut result = root.to_path_buf();
    if crate::workspace::redirected(&fs::symlink_metadata(root)?) {
        return Err(error("path", "Redirected root"));
    }
    for (index, part) in parts.iter().enumerate() {
        result.push(part);
        match fs::symlink_metadata(&result) {
            Ok(meta) => {
                if crate::workspace::redirected(&meta)
                    || (index + 1 < parts.len() && !meta.is_dir())
                {
                    return Err(error(
                        "path",
                        "Links and redirected paths are not supported",
                    ));
                }
            }
            Err(e) if missing && e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(result)
}

fn open_local(path: &Path, create: bool) -> Result<tokio::fs::File> {
    let mut options = fs::OpenOptions::new();
    if create {
        options.write(true).create_new(true);
    } else {
        options.read(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path)?;
    let meta = file.metadata()?;
    if crate::workspace::redirected(&meta) || !meta.is_file() {
        return Err(error("path", "Not a regular file"));
    }
    Ok(tokio::fs::File::from_std(file))
}

impl Host {
    pub async fn open(
        endpoint: &WorkspaceRef,
        device: Option<&DeviceProfile>,
        config: &Path,
    ) -> Result<Self> {
        match endpoint {
            WorkspaceRef::Local { dir } => Ok(Self::Local(crate::workspace::canonical_root(dir)?)),
            WorkspaceRef::Device { path, .. } => {
                crate::workspace_ref::validate_device_path(path).map_err(|e| error("path", e))?;
                let device = device.ok_or_else(|| error("device", "Device not found"))?;
                device
                    .validate()
                    .map_err(|e| error("device", e.to_string()))?;
                match device.transport {
                    TransportKind::Ssh => Ok(Self::Ssh(SshHost::open(device, config, path).await?)),
                    TransportKind::Wsl => Ok(Self::Wsl(
                        WslHost::open(device.wsl.as_ref().unwrap(), path).await?,
                    )),
                    _ => Err(error(
                        "unsupported",
                        "Only SSH and WSL devices support file transfers",
                    )),
                }
            }
        }
    }

    pub fn endpoint(&self, original: &WorkspaceRef) -> WorkspaceRef {
        match self {
            Self::Local(root) => {
                WorkspaceRef::local(crate::verbatim::simplify(root).to_string_lossy())
            }
            Self::Ssh(host) => WorkspaceRef::device(original.device_ref().unwrap().0, &host.root),
            Self::Wsl(host) => WorkspaceRef::device(original.device_ref().unwrap().0, &host.root),
        }
    }

    pub fn overwrite(&self) -> bool {
        match self {
            Self::Ssh(host) => host.overwrite,
            _ => true,
        }
    }
    pub fn safe_publish(&self) -> bool {
        match self {
            Self::Ssh(host) => host.hardlink,
            _ => true,
        }
    }

    pub fn local_alias(&self) -> Option<PathBuf> {
        match self {
            Self::Local(root) => Some(root.clone()),
            Self::Wsl(host) => host.local_alias.clone(),
            _ => None,
        }
    }
    pub fn alias_unknown(&self) -> bool {
        cfg!(windows) && matches!(self, Self::Wsl(host) if host.local_alias.is_none())
    }

    pub async fn stat(&mut self, path: &str) -> Result<Option<Attributes>> {
        match self {
            Self::Local(root) => {
                let target = local_path(root, path, true)?;
                match fs::symlink_metadata(target) {
                    Ok(meta) => Ok(Some(attributes(&meta))),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                    Err(e) => Err(e.into()),
                }
            }
            Self::Ssh(host) => host.stat(path).await,
            Self::Wsl(host) => host.stat(path).await,
        }
    }

    pub async fn list(&mut self, path: &str) -> Result<Vec<Entry>> {
        let mut entries = match self {
            Self::Local(root) => {
                let path = local_path(root, path, false)?;
                let mut entries = Vec::new();
                let mut dir = tokio::fs::read_dir(path).await?;
                while let Some(entry) = dir.next_entry().await? {
                    if entries.len() >= ENTRY_LIMIT {
                        return Err(error("too_large", "Directory exceeds 10000 entries"));
                    }
                    let name = entry
                        .file_name()
                        .into_string()
                        .map_err(|_| error("path", "Non UTF-8 filename"))?;
                    let attrs = attributes(&tokio::fs::symlink_metadata(entry.path()).await?);
                    entries.push(Entry { name, attrs });
                }
                entries
            }
            Self::Ssh(host) => host.list(path).await?,
            Self::Wsl(host) => host.list(path).await?,
        };
        entries.sort_by(|a, b| {
            (b.attrs.kind == "dir", &a.name).cmp(&(a.attrs.kind == "dir", &b.name))
        });
        Ok(entries)
    }

    pub async fn mkdir(&mut self, path: &str) -> Result<()> {
        match self {
            Self::Local(root) => {
                let target = local_path(root, path, true)?;
                match tokio::fs::create_dir(&target).await {
                    Ok(()) => Ok(()),
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                        let meta = fs::symlink_metadata(&target)?;
                        if meta.is_dir() && !crate::workspace::redirected(&meta) {
                            Ok(())
                        } else {
                            Err(error("conflict", "File/directory type conflict"))
                        }
                    }
                    Err(e) => Err(e.into()),
                }
            }
            Self::Ssh(host) => host.mkdir(path).await,
            Self::Wsl(host) => host.mkdir(path).await,
        }
    }

    pub async fn open_read(&mut self, path: &str) -> Result<(Handle, Attributes)> {
        match self {
            Self::Local(root) => {
                let file = open_local(&local_path(root, path, false)?, false)?;
                let attrs = attributes(&file.metadata().await?);
                Ok((Handle::Local(file), attrs))
            }
            Self::Ssh(host) => host.open_file(path, false).await,
            Self::Wsl(host) => host.open_file(path, false).await,
        }
    }

    pub async fn create_temp(&mut self, path: &str) -> Result<Handle> {
        match self {
            Self::Local(root) => Ok(Handle::Local(open_local(
                &local_path(root, path, true)?,
                true,
            )?)),
            Self::Ssh(host) => Ok(host.open_file(path, true).await?.0),
            Self::Wsl(host) => Ok(host.open_file(path, true).await?.0),
        }
    }

    pub async fn read(&mut self, handle: &mut Handle, offset: u64) -> Result<Vec<u8>> {
        match (self, handle) {
            (Self::Local(_), Handle::Local(file)) => {
                let mut bytes = vec![0; CHUNK];
                file.seek(std::io::SeekFrom::Start(offset)).await?;
                let count = file.read(&mut bytes).await?;
                bytes.truncate(count);
                Ok(bytes)
            }
            (Self::Ssh(host), Handle::Remote(handle)) => host.read(handle, offset).await,
            (Self::Wsl(host), Handle::Remote(handle)) => host.read(handle, offset).await,
            _ => unreachable!(),
        }
    }

    pub async fn write(&mut self, handle: &mut Handle, offset: u64, bytes: Vec<u8>) -> Result<()> {
        match (self, handle) {
            (Self::Local(_), Handle::Local(file)) => {
                file.write_all(&bytes).await?;
                Ok(())
            }
            (Self::Ssh(host), Handle::Remote(handle)) => host.write(handle, offset, bytes).await,
            (Self::Wsl(host), Handle::Remote(handle)) => host.write(handle, offset, bytes).await,
            _ => unreachable!(),
        }
    }

    pub async fn close(
        &mut self,
        handle: Handle,
        writing: bool,
        mode: Option<u32>,
    ) -> Result<Attributes> {
        match (self, handle) {
            (Self::Local(_), Handle::Local(file)) => {
                if writing {
                    #[cfg(unix)]
                    if let Some(mode) = mode {
                        use std::os::unix::fs::PermissionsExt;
                        file.set_permissions(fs::Permissions::from_mode(mode & 0o777))
                            .await?;
                    }
                    #[cfg(not(unix))]
                    let _ = mode;
                    file.sync_all().await?;
                }
                Ok(attributes(&file.metadata().await?))
            }
            (Self::Ssh(host), Handle::Remote(handle)) => host.close(handle, writing, mode).await,
            (Self::Wsl(host), Handle::Remote(handle)) => host.close(handle, writing, mode).await,
            _ => unreachable!(),
        }
    }

    pub async fn commit(
        &mut self,
        temp: &str,
        path: &str,
        overwrite: bool,
        expected: &Option<Attributes>,
    ) -> Result<()> {
        if self.stat(path).await? != *expected {
            return Err(error("conflict", "Target changed after preflight"));
        }
        match self {
            Self::Local(root) => {
                let temp = local_path(root, temp, false)?;
                let target = local_path(root, path, true)?;
                if overwrite {
                    tokio::fs::rename(temp, target).await?;
                } else {
                    tokio::fs::hard_link(&temp, target).await?;
                    let _ = tokio::fs::remove_file(temp).await;
                }
                Ok(())
            }
            Self::Ssh(host) => host.commit(temp, path, overwrite).await,
            Self::Wsl(host) => host.commit(temp, path, overwrite, expected).await,
        }
    }

    pub async fn remove_temp(&mut self, path: &str) -> Result<()> {
        match self {
            Self::Local(root) => {
                tokio::fs::remove_file(local_path(root, path, true)?).await?;
                Ok(())
            }
            Self::Ssh(host) => host.remove(path).await,
            Self::Wsl(host) => host.remove(path).await,
        }
    }
}
