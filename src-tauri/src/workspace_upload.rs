//! Shared bounded local workspace traversal and text handling. Wire encoding and
//! remote filesystem operations remain in each transport.
use crate::error::{Result, RunnerError};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy)]
pub struct Policy {
    pub file_limit: u64,
    pub total_limit: usize,
    pub entry_limit: usize,
    pub path_limit: usize,
    pub text_only: bool,
    pub skip_symlinks: bool,
}

pub const SERIAL: Policy = Policy {
    file_limit: 1024 * 1024,
    total_limit: 8 * 1024 * 1024,
    entry_limit: 1024,
    path_limit: 512,
    text_only: true,
    skip_symlinks: false,
};
pub const WSL: Policy = Policy {
    file_limit: 16 * 1024 * 1024,
    total_limit: 64 * 1024 * 1024,
    entry_limit: 4096,
    path_limit: 1024,
    text_only: false,
    skip_symlinks: false,
};
pub const SSH: Policy = Policy {
    file_limit: 64 * 1024 * 1024,
    total_limit: 256 * 1024 * 1024,
    entry_limit: 4096,
    path_limit: 1024,
    text_only: false,
    skip_symlinks: true,
};

pub struct Entry {
    pub path: String,
    pub data: Option<Vec<u8>>,
    pub mode: u32,
    pub source_bytes: usize,
}

#[derive(Clone)]
pub struct Source {
    pub relative: String,
    pub path: PathBuf,
    pub directory: bool,
    pub mode: u32,
    pub metadata: std::fs::Metadata,
}

fn invalid(message: impl Into<String>) -> RunnerError {
    RunnerError::InvalidInput(message.into())
}
fn size_error(policy: Policy) -> RunnerError {
    invalid(format!(
        "workspace limit: {} MiB per file, {} MiB total",
        policy.file_limit / (1024 * 1024),
        policy.total_limit / (1024 * 1024)
    ))
}

fn verify(path: &Path, parent: &Path) -> Result<std::fs::Metadata> {
    let meta = std::fs::symlink_metadata(path)?;
    #[cfg(windows)]
    let redirected = {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let redirected = meta.file_type().is_symlink();
    if redirected
        || (!meta.is_dir() && !meta.is_file())
        || std::fs::canonicalize(path)?.parent() != Some(parent)
    {
        return Err(invalid(format!(
            "workspace contains a link, redirected path or special file: {}",
            path.display()
        )));
    }
    Ok(meta)
}

pub fn scan(local: &Path, policy: Policy) -> Result<Vec<Source>> {
    fn runner_name(name: &std::ffi::OsStr) -> bool {
        if cfg!(windows) {
            name.to_str()
                .is_some_and(|name| name.eq_ignore_ascii_case(".runner"))
        } else {
            name == ".runner"
        }
    }
    fn visit(
        root: &Path,
        dir: &Path,
        policy: Policy,
        sources: &mut Vec<Source>,
        total: &mut u64,
    ) -> Result<()> {
        // Each directory is verified against the original canonical root, rather
        // than accepting a newly redirected ancestor during recursion.
        if std::fs::canonicalize(dir)? != dir {
            return Err(invalid("workspace directory was redirected"));
        }
        let mut items = Vec::new();
        for item in std::fs::read_dir(dir)? {
            let item = item?;
            if matches!(item.file_name().to_str(), Some(".git" | ".hg" | ".svn"))
                || (dir == root && runner_name(&item.file_name()))
            {
                continue;
            }
            if items.len() >= policy.entry_limit {
                return Err(invalid("workspace entry limit exceeded"));
            }
            items.push(item);
        }
        items.sort_by_key(|item| item.file_name());
        for item in items {
            if matches!(item.file_name().to_str(), Some(".git" | ".hg" | ".svn"))
                || (dir == root && runner_name(&item.file_name()))
            {
                continue;
            }
            let path = item.path();
            if policy.skip_symlinks && std::fs::symlink_metadata(&path)?.file_type().is_symlink() {
                continue;
            }
            let meta = verify(&path, dir)?;
            let relative = path
                .strip_prefix(root)
                .map_err(|_| invalid("path escapes workspace"))?
                .to_str()
                .ok_or_else(|| invalid("workspace filename must be UTF-8"))?
                .to_string();
            #[cfg(windows)]
            let relative = relative.replace('\\', "/");
            if relative.len() > policy.path_limit
                || relative.chars().any(char::is_control)
                || sources.len() >= policy.entry_limit
            {
                return Err(invalid(
                    "workspace entry limit exceeded or invalid filename",
                ));
            }
            if meta.is_file() {
                *total += meta.len();
                // Serial's total limit counts normalized text; CRLF may occupy
                // twice that space on disk. Other transports count raw bytes.
                let scan_limit = policy.total_limit as u64 * if policy.text_only { 2 } else { 1 };
                if meta.len() > policy.file_limit || *total > scan_limit {
                    return Err(size_error(policy));
                }
            }
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                meta.permissions().mode() & 0o777
            };
            #[cfg(not(unix))]
            let mode = if relative.to_lowercase().ends_with(".sh") {
                0o700
            } else {
                0o600
            };
            let directory = meta.is_dir();
            sources.push(Source {
                relative,
                path: path.clone(),
                directory,
                mode,
                metadata: meta,
            });
            if directory {
                visit(root, &path, policy, sources, total)?;
            }
        }
        Ok(())
    }
    let root = std::fs::canonicalize(local)?;
    let mut sources = Vec::new();
    visit(&root, &root, policy, &mut sources, &mut 0)?;
    Ok(sources)
}

pub(crate) fn source_metadata(source: &Source) -> Result<std::fs::Metadata> {
    let parent = source
        .path
        .parent()
        .ok_or_else(|| invalid("invalid workspace path"))?;
    let meta = verify(&source.path, parent)?;
    if meta.is_dir() != source.directory {
        return Err(invalid("workspace entry changed type during upload"));
    }
    Ok(meta)
}

pub fn read_source(source: Source, policy: Policy) -> Result<Entry> {
    source_metadata(&source)?;
    if source.directory {
        return Ok(Entry {
            path: source.relative,
            data: None,
            mode: source.mode,
            source_bytes: 0,
        });
    }
    let file = std::fs::File::open(&source.path)?;
    let opened = file.metadata()?;
    if !opened.is_file() || opened.len() > policy.file_limit {
        return Err(size_error(policy));
    }
    let mut data = Vec::new();
    file.take(policy.file_limit + 1).read_to_end(&mut data)?;
    if data.len() as u64 > policy.file_limit {
        return Err(size_error(policy));
    }
    if policy.text_only {
        std::str::from_utf8(&data)
            .ok()
            .filter(|s| !s.contains('\0'))
            .ok_or_else(|| {
                invalid(format!(
                    "serial V1 uploads UTF-8 text only: {}",
                    source.path.display()
                ))
            })?;
    }
    let source_bytes = data.len();
    // Managed project inputs are verified against the exact planning snapshot.
    // Binary-capable transports must not turn CRLF into a false input conflict.
    let project_input = matches!(
        source.relative.as_str(),
        "pyproject.toml" | ".python-version" | "uv.lock"
    );
    if policy.text_only || is_text_script(&source.relative) && !project_input {
        data = normalize_lf(data);
    }
    Ok(Entry {
        path: source.relative,
        data: Some(data),
        mode: source.mode,
        source_bytes,
    })
}

pub fn collect(local: &Path, policy: Policy) -> Result<Vec<Entry>> {
    let mut total = 0;
    scan(local, policy)?
        .into_iter()
        .map(|source| {
            let entry = read_source(source, policy)?;
            total += if policy.text_only {
                entry.data.as_ref().map_or(0, Vec::len)
            } else {
                entry.source_bytes
            };
            if total > policy.total_limit {
                return Err(size_error(policy));
            }
            Ok(entry)
        })
        .collect()
}

pub fn is_text_script(name: &str) -> bool {
    let leaf = name.rsplit('/').next().unwrap_or(name).to_lowercase();
    !leaf.contains('.')
        || matches!(
            leaf.rsplit('.').next(),
            Some(
                "sh" | "bash"
                    | "py"
                    | "txt"
                    | "cfg"
                    | "ini"
                    | "yaml"
                    | "yml"
                    | "json"
                    | "toml"
                    | "csv"
                    | "md"
                    | "env"
            )
        )
}

pub fn normalize_lf(data: Vec<u8>) -> Vec<u8> {
    if data.contains(&0)
        || std::str::from_utf8(&data).is_err()
        || !data.windows(2).any(|w| w == b"\r\n")
    {
        return data;
    }
    data.iter()
        .enumerate()
        .filter_map(|(i, &byte)| {
            if byte == b'\r' && data.get(i + 1) == Some(&b'\n') {
                None
            } else {
                Some(byte)
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("rr-upload-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn local_links_keep_transport_policy_and_cannot_escape_the_workspace() {
        let f = Fixture::new();
        let outside = Fixture::new();
        let target = outside.0.join("secret.txt");
        std::fs::write(&target, b"outside").unwrap();
        #[cfg(windows)]
        let result = std::os::windows::fs::symlink_file(&target, f.0.join("link.txt"));
        #[cfg(unix)]
        let result = std::os::unix::fs::symlink(&target, f.0.join("link.txt"));
        if let Err(error) = result {
            #[cfg(windows)]
            if error.raw_os_error() == Some(1314) {
                eprintln!("SKIP: no Windows symlink privilege");
                return;
            }
            panic!("cannot create link: {error}");
        }
        assert!(collect(&f.0, SERIAL).is_err());
        assert!(collect(&f.0, WSL).is_err());
        assert!(collect(&f.0, SSH).unwrap().is_empty());
    }

    #[test]
    fn shared_scan_enforces_file_total_entry_limits_and_rechecks_growing_files() {
        let f = Fixture::new();
        let policy = Policy {
            file_limit: 8,
            total_limit: 12,
            entry_limit: 2,
            ..WSL
        };
        std::fs::write(f.0.join("a.py"), b"12345678").unwrap();
        let source = scan(&f.0, policy).unwrap().remove(0);
        std::fs::write(f.0.join("a.py"), b"123456789").unwrap();
        assert!(read_source(source, policy).is_err());
        assert!(scan(&f.0, policy).is_err());
        std::fs::write(f.0.join("a.py"), b"12345678").unwrap();
        std::fs::write(f.0.join("b.py"), b"12345678").unwrap();
        assert!(scan(&f.0, policy).is_err());
        std::fs::write(f.0.join("b.py"), b"").unwrap();
        std::fs::write(f.0.join("c.py"), b"").unwrap();
        assert!(scan(&f.0, policy).is_err());
    }

    #[test]
    fn all_transports_share_normalization_while_serial_rejects_binary() {
        let f = Fixture::new();
        std::fs::create_dir(f.0.join("dir.with.dot")).unwrap();
        std::fs::write(f.0.join("dir.with.dot/run"), b"echo ok\r\n").unwrap();
        for policy in [SSH, WSL, SERIAL] {
            let entries = collect(&f.0, policy).unwrap();
            assert_eq!(entries[1].data.as_deref().unwrap(), b"echo ok\n");
        }
        std::fs::write(f.0.join("binary.py"), b"\xff\0\r\n").unwrap();
        for policy in [SSH, WSL] {
            let entries = collect(&f.0, policy).unwrap();
            assert_eq!(entries[0].data.as_deref().unwrap(), b"\xff\0\r\n");
        }
        assert!(collect(&f.0, SERIAL).is_err());
    }

    #[test]
    fn serial_total_counts_normalized_bytes_and_vcs_entries_do_not_consume_budget() {
        let f = Fixture::new();
        std::fs::write(f.0.join("run.sh"), b"\r\n\r\n\r\n\r\n").unwrap();
        std::fs::create_dir(f.0.join(".git")).unwrap();
        let policy = Policy {
            file_limit: 8,
            total_limit: 6,
            entry_limit: 1,
            ..SERIAL
        };
        let entries = collect(&f.0, policy).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].data.as_deref().unwrap(), b"\n\n\n\n");
        assert!(collect(
            &f.0,
            Policy {
                text_only: false,
                ..policy
            }
        )
        .is_err());
    }

    #[test]
    fn root_runner_metadata_is_excluded_before_all_transport_quotas() {
        let f = Fixture::new();
        std::fs::create_dir(f.0.join(".runner")).unwrap();
        std::fs::write(f.0.join(".runner/commands.json"), vec![0xff; 4096]).unwrap();
        std::fs::write(f.0.join("main.sh"), b"true\n").unwrap();
        for policy in [SSH, WSL, SERIAL] {
            let files = collect(
                &f.0,
                Policy {
                    file_limit: 32,
                    total_limit: 32,
                    entry_limit: 1,
                    ..policy
                },
            )
            .unwrap();
            assert_eq!(files.len(), 1);
            assert_eq!(files[0].path, "main.sh");
        }
    }
}
