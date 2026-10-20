//! Bounded, read-only workspace preflight. Results are never reused for writes.
use super::{error, host::Host, relative, Attributes, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};

pub(super) const INSPECT_BATCH: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Fingerprint {
    pub attrs: Attributes,
    pub sha256: Option<String>,
}

impl Fingerprint {
    fn validate(&self, limit: u64) -> Result<()> {
        if self.attrs.kind == "dir" && self.sha256.is_none() {
            return Ok(());
        }
        if self.attrs.kind != "file"
            || self.attrs.size > limit
            || !self
                .sha256
                .as_ref()
                .is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err(error(
                "conflict",
                "Invalid or changed workspace fingerprint",
            ));
        }
        Ok(())
    }
}

pub(super) fn check_cancel(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Relaxed) {
        return Err(error("canceled", "Workspace inspection canceled"));
    }
    Ok(())
}

impl Host {
    pub(crate) async fn inspect(
        &mut self,
        paths: &[String],
        limit: u64,
        cancel: &AtomicBool,
    ) -> Result<Vec<Option<Fingerprint>>> {
        if paths.len() > super::ENTRY_LIMIT * 2 || limit > 64 * 1024 * 1024 {
            return Err(error("too_large", "Workspace inspection exceeds limits"));
        }
        for path in paths {
            relative(path)?;
        }
        let mut results = Vec::with_capacity(paths.len());
        let mut accelerated_batches = 0;
        let mut fallback_paths = 0;
        for batch in paths.chunks(INSPECT_BATCH) {
            check_cancel(cancel)?;
            let accelerated = match self {
                Self::Ssh(host) => host.inspect(batch, limit, cancel).await?,
                Self::Wsl(host) => {
                    let reply = host
                        .call(serde_json::json!({
                            "type":"tf_inspect", "paths":batch, "limit":limit,
                        }))
                        .await?;
                    Some(
                        serde_json::from_value::<Vec<Option<Fingerprint>>>(reply)
                            .map_err(|e| error("io", e.to_string()))?,
                    )
                }
                Self::Local(_) => None,
            };
            let values = match accelerated {
                Some(values) => {
                    accelerated_batches += 1;
                    values
                }
                None => {
                    fallback_paths += batch.len();
                    let mut values = Vec::with_capacity(batch.len());
                    for path in batch {
                        check_cancel(cancel)?;
                        values.push(self.inspect_one(path, limit, cancel).await?);
                    }
                    values
                }
            };
            if values.len() != batch.len() {
                return Err(error("io", "Incomplete workspace inspection reply"));
            }
            for value in values.iter().flatten() {
                value.validate(limit)?;
            }
            results.extend(values);
        }
        check_cancel(cancel)?;
        tracing::debug!(
            paths = paths.len(),
            accelerated_batches,
            fallback_paths,
            "workspace inspection"
        );
        Ok(results)
    }

    async fn inspect_one(
        &mut self,
        path: &str,
        limit: u64,
        cancel: &AtomicBool,
    ) -> Result<Option<Fingerprint>> {
        let Some(attrs) = self.stat(path).await? else {
            return Ok(None);
        };
        if attrs.kind == "dir" {
            return Ok(Some(Fingerprint {
                attrs,
                sha256: None,
            }));
        }
        if attrs.kind != "file" || attrs.size > limit {
            return Err(error(
                "conflict",
                "Expected a regular file within workspace limit",
            ));
        }
        let sha256 = match self.remote_digest(path, limit).await? {
            Some(hash) => hash,
            None => {
                let (mut file, opened) = self.open_read(path).await?;
                let result = async {
                    if opened != attrs {
                        return Err(error("conflict", "File changed while opening"));
                    }
                    let mut hasher = Sha256::new();
                    let mut offset = 0;
                    loop {
                        check_cancel(cancel)?;
                        let bytes = self.read(&mut file, offset).await?;
                        if bytes.is_empty() {
                            break;
                        }
                        offset += bytes.len() as u64;
                        if offset > limit {
                            return Err(error("too_large", "File grew beyond hash limit"));
                        }
                        hasher.update(bytes);
                    }
                    Ok(format!("{:x}", hasher.finalize()))
                }
                .await;
                let close = self.close(file, false, None).await;
                let hash = result?;
                close?;
                hash
            }
        };
        if self.stat(path).await? != Some(attrs.clone()) {
            return Err(error("conflict", "File changed while hashing"));
        }
        Ok(Some(Fingerprint {
            attrs,
            sha256: Some(sha256),
        }))
    }
}

// Optional POSIX/coreutils acceleration. No Python/rsync dependency. Every path
// is checked component by component, before AND after reading. Nanosecond stat
// strings and inode/dev are compared internally; the returned attrs retain the
// existing SFTP v3 representation used by mutation-time checks.
const SCRIPT: &str = r#"
set -f
LC_ALL=C; export LC_ALL
command -v stat >/dev/null 2>&1 && command -v sha256sum >/dev/null 2>&1 || exit 78
rr_parents() {
  rr_p=$rr_root
  [ ! -L "$rr_p" ] && [ -d "$rr_p" ] && [ -x "$rr_p" ] || return 1
  rr_ifs=$IFS; IFS=/; set -- $1; IFS=$rr_ifs
  while [ "$#" -gt 1 ]; do
    rr_p=${rr_p%/}/$1; shift
    [ ! -L "$rr_p" ] || return 1
    if [ ! -e "$rr_p" ]; then return 2; fi
    [ -d "$rr_p" ] && [ -x "$rr_p" ] || return 1
  done
}
rr_stat() { stat -c '%f %s %Y %u %g %d %i|%y|%z' -- "$1" 2>/dev/null; }
rr_one() {
  rr_i=$1; rr_rel=$2; rr_file=${rr_root%/}/$2
  rr_parents "$rr_rel"; rr_rc=$?
  if [ "$rr_rc" = 2 ]; then printf '%s M\n' "$rr_i"; return; fi
  [ "$rr_rc" = 0 ] && [ ! -L "$rr_file" ] || return 1
  if [ ! -e "$rr_file" ]; then printf '%s M\n' "$rr_i"; return; fi
  rr_before=$(rr_stat "$rr_file") || return 1
  if [ -d "$rr_file" ]; then printf '%s D %s\n' "$rr_i" "${rr_before%%|*}"; return; fi
  [ -f "$rr_file" ] || return 1
  set -- ${rr_before%%|*}; [ "$2" -le "$rr_limit" ] || return 1
  rr_hash=$(sha256sum < "$rr_file" 2>/dev/null) || return 1
  rr_after=$(rr_stat "$rr_file") || return 1
  [ "$rr_before" = "$rr_after" ] || return 1
  rr_parents "$rr_rel" && [ ! -L "$rr_file" ] || return 1
  printf '%s F %s %s\n' "$rr_i" "${rr_before%%|*}" "${rr_hash%% *}"
}
"#;

pub(super) fn script(root: &str, paths: &[String], limit: u64, marker: &str) -> String {
    use crate::runner::sh_quote;
    let mut out = format!(
        "{SCRIPT}\nrr_root={}\nrr_limit={limit}\nprintf '{marker}\\n'\n",
        sh_quote(root)
    );
    for (index, path) in paths.iter().enumerate() {
        out.push_str(&format!("rr_one {index} {} || exit 1\n", sh_quote(path)));
    }
    out
}

pub(super) fn parse(
    bytes: &[u8],
    marker: &str,
    count: usize,
    limit: u64,
) -> Option<Vec<Option<Fingerprint>>> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text.lines();
    if lines.next()? != marker {
        return None;
    }
    let mut results = Vec::with_capacity(count);
    for index in 0..count {
        let fields: Vec<_> = lines.next()?.split_whitespace().collect();
        if fields.first()?.parse::<usize>().ok()? != index {
            return None;
        }
        if fields.len() == 2 && fields[1] == "M" {
            results.push(None);
            continue;
        }
        let file = fields.get(1)? == &"F";
        if fields.len() != if file { 10 } else { 9 } || (!file && fields[1] != "D") {
            return None;
        }
        let mode = u32::from_str_radix(fields[2], 16).ok()?;
        let kind = match mode & 0o170000 {
            0o100000 => "file",
            0o040000 => "dir",
            _ => return None,
        };
        if (kind == "file") != file {
            return None;
        }
        let uid = fields[5].parse::<u32>().ok()?;
        let gid = fields[6].parse::<u32>().ok()?;
        fields[7].parse::<u64>().ok()?;
        fields[8].parse::<u64>().ok()?;
        let value = Fingerprint {
            attrs: Attributes {
                kind: kind.into(),
                size: fields[3].parse().ok()?,
                modified: fields[4]
                    .parse::<u64>()
                    .ok()?
                    .checked_mul(1_000_000_000)?
                    .to_string(),
                mode: Some(mode & 0o777),
                identity: format!("Some({uid}):Some({gid})"),
            },
            sha256: file.then(|| fields[9].to_ascii_lowercase()),
        };
        value.validate(limit).ok()?;
        results.push(Some(value));
    }
    if lines.next().is_some() {
        return None;
    }
    Some(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_reply_requires_exact_nonce_order_count_types_and_bounded_hashes() {
        let hash = "a".repeat(64);
        let valid = format!("nonce\n0 F 8180 3 1700000000 1000 1000 1 2 {hash}\n1 D 41c0 0 1700000000 1000 1000 1 3\n2 M\n");
        let values = parse(valid.as_bytes(), "nonce", 3, 3).unwrap();
        assert_eq!(values[0].as_ref().unwrap().attrs.mode, Some(0o600));
        assert_eq!(values[1].as_ref().unwrap().attrs.kind, "dir");
        assert!(values[2].is_none());
        assert!(parse(valid.as_bytes(), "other", 3, 3).is_none());
        assert!(parse(valid.as_bytes(), "nonce", 2, 3).is_none());
        assert!(parse(valid.as_bytes(), "nonce", 4, 3).is_none());
        assert!(parse(valid.as_bytes(), "nonce", 3, 2).is_none());
        for bad in [
            valid.replace("0 F", "1 F"),
            valid.replace("8180", "a180"),
            valid.replace(&hash, "bad"),
            valid.replace("1 D", "1 F"),
        ] {
            assert!(parse(bad.as_bytes(), "nonce", 3, 3).is_none());
        }
    }

    #[test]
    fn actual_posix_batch_script_handles_literal_names_binary_and_missing_paths() {
        #[cfg(windows)]
        let shell = std::path::PathBuf::from("C:/Program Files/Git/bin/bash.exe");
        #[cfg(not(windows))]
        let shell = std::path::PathBuf::from("/bin/sh");
        if !shell.is_file() {
            return;
        }
        let root = std::env::temp_dir().join(format!("rr-inspect-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let name = "汉字 a' $(touch injected).bin";
        std::fs::write(root.join(name), [0, 255, 10]).unwrap();
        std::fs::create_dir(root.join("empty")).unwrap();
        let canonical = crate::verbatim::simplify(&std::fs::canonicalize(&root).unwrap());
        #[cfg(windows)]
        let remote_root = crate::local::to_msys_path(&canonical);
        #[cfg(not(windows))]
        let remote_root = canonical.to_string_lossy().into_owned();
        let paths = vec![
            name.into(),
            "empty".into(),
            "missing".into(),
            "missing-parent/file".into(),
        ];
        let output = std::process::Command::new(&shell)
            .args(["-c", &script(&remote_root, &paths, 3, "nonce")])
            .current_dir(&root)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let values = parse(&output.stdout, "nonce", 4, 3).unwrap();
        assert_eq!(
            values[0].as_ref().unwrap().sha256.as_deref(),
            Some(format!("{:x}", Sha256::digest([0, 255, 10])).as_str())
        );
        assert!(values[2].is_none() && values[3].is_none());
        assert!(!root.join("injected").exists());
        let oversized = std::process::Command::new(&shell)
            .args(["-c", &script(&remote_root, &[name.into()], 2, "nonce")])
            .output()
            .unwrap();
        assert!(!oversized.status.success());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&root, root.join("link")).unwrap();
            let output = std::process::Command::new(&shell)
                .args([
                    "-c",
                    &script(&remote_root, &["link/empty".into()], 3, "nonce"),
                ])
                .output()
                .unwrap();
            assert!(!output.status.success());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
