//! Bounded UTF-8 editing plus create/rename/delete/list of workspace entries.
//! This is independent of transport upload limits. External processes are not
//! covered by our mutex.
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

pub const FILE_LIMIT: usize = 1024 * 1024;
// Also held by the desktop run command, so a run cannot start during replacement.
pub static FILE_OPERATIONS: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize)]
pub struct FileError {
    pub code: &'static str,
    pub message: String,
}
impl std::fmt::Display for FileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl FileError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<std::io::Error> for FileError {
    fn from(error: std::io::Error) -> Self {
        let (code, label) = match error.kind() {
            std::io::ErrorKind::NotFound => ("not_found", "文件或目录不存在"),
            std::io::ErrorKind::PermissionDenied => ("permission", "没有文件读写权限"),
            std::io::ErrorKind::AlreadyExists => ("exists", "同名文件或目录已存在"),
            _ => ("io", "文件操作失败"),
        };
        Self::new(code, format!("{label}：{error}"))
    }
}

type Result<T> = std::result::Result<T, FileError>;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
}

#[derive(Debug, Serialize)]
pub struct Document {
    pub content: String,
    pub revision: String,
    pub eol: Eol,
    pub bom: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    /// 工作区来源（00029）；兼容旧字段名 dir（裸字符串 = 本机目录）
    #[serde(alias = "dir")]
    pub workspace: crate::workspace_ref::WorkspaceRef,
    pub name: String,
    pub content: String,
    pub expected_revision: String,
    pub eol: Eol,
    pub bom: bool,
}

#[derive(Debug, Serialize)]
pub struct Saved {
    pub revision: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
}

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub name: String,
    pub is_dir: bool,
}

pub(crate) fn redirected(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

fn invalid_path() -> FileError {
    FileError::new(
        "path",
        "仅可操作工作区内的普通文件或目录，不支持链接或重定向路径",
    )
}

/// Canonicalize the selected root, rejecting redirected roots and ancestors.
pub(crate) fn canonical_root(dir: &str) -> Result<PathBuf> {
    let absolute_root = std::path::absolute(dir)?;
    // Check the selected root and its ancestors too (not just the final entry).
    for ancestor in absolute_root.ancestors() {
        if redirected(&fs::symlink_metadata(ancestor)?) {
            return Err(invalid_path());
        }
    }
    let root = fs::canonicalize(&absolute_root)?;
    if !root.is_dir() {
        return Err(invalid_path());
    }
    Ok(root)
}

fn resolve(dir: &str, name: &str) -> Result<PathBuf> {
    if name.is_empty() || name.contains(['\0', ':', '\\']) {
        return Err(invalid_path());
    }
    let relative = Path::new(name);
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(invalid_path());
    }
    let root = canonical_root(dir)?;
    let mut path = root.clone();
    for part in relative.components() {
        path.push(part);
        if redirected(&fs::symlink_metadata(&path)?) {
            return Err(invalid_path());
        }
    }
    let canonical = fs::canonicalize(&path)?;
    if !canonical.starts_with(&root) || canonical != path || !fs::metadata(&path)?.is_file() {
        return Err(invalid_path());
    }
    Ok(path)
}

fn revision(data: &[u8], meta: &Metadata) -> String {
    let mut digest = Sha256::new();
    digest.update(data);
    // Include timestamps and file identity where available to detect replacement.
    digest.update(format!(
        "{:?}{:?}",
        meta.modified().ok(),
        meta.created().ok()
    ));
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        digest.update(meta.dev().to_le_bytes());
        digest.update(meta.ino().to_le_bytes());
    }
    format!("{:x}", digest.finalize())
}

fn bytes(path: &Path) -> Result<(Vec<u8>, Metadata)> {
    let file = File::open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() || redirected(&meta) {
        return Err(invalid_path());
    }
    if meta.len() > FILE_LIMIT as u64 {
        return Err(too_large());
    }
    let mut data = Vec::new();
    file.take(FILE_LIMIT as u64 + 1).read_to_end(&mut data)?;
    if data.len() > FILE_LIMIT {
        return Err(too_large());
    }
    Ok((data, meta))
}

fn too_large() -> FileError {
    FileError::new("too_large", "编辑器最多支持 1 MiB，请使用外部编辑器")
}

/// UTF-8 / BOM / 行尾检查并构造 Document；远端工作区（00029）共享同一文本契约，
/// revision 由调用方按各自来源计算。
pub(crate) fn decode_document(data: &[u8], revision: String) -> Result<Document> {
    let text = std::str::from_utf8(data)
        .map_err(|_| FileError::new("encoding", "仅支持 UTF-8 文本，请使用外部编辑器转换编码"))?;
    if text.contains('\0') {
        return Err(FileError::new("encoding", "不支持包含 NUL 的文件"));
    }
    let bom = text.starts_with('\u{feff}');
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let crlf = text.contains("\r\n");
    let normalized = text.replace("\r\n", "\n");
    if normalized.contains('\r') || (crlf && text.replace("\r\n", "").contains('\n')) {
        return Err(FileError::new(
            "eol",
            "文件包含混合或不支持的行尾，请用外部编辑器统一为 LF 或 CRLF",
        ));
    }
    Ok(Document {
        content: normalized,
        revision,
        eol: if crlf { Eol::Crlf } else { Eol::Lf },
        bom,
    })
}

/// 将编辑内容编码为落盘字节（BOM + 行尾）；远端工作区共享同一编码。
pub(crate) fn encode_content(content: &str, eol: Eol, bom: bool) -> Result<Vec<u8>> {
    if content.contains(['\0', '\r']) {
        return Err(FileError::new(
            "encoding",
            "编辑内容必须是无 NUL 的 LF 文本",
        ));
    }
    if content.len() > FILE_LIMIT {
        return Err(too_large());
    }
    let mut data = if bom {
        vec![0xef, 0xbb, 0xbf]
    } else {
        Vec::new()
    };
    match eol {
        Eol::Lf => data.extend_from_slice(content.as_bytes()),
        Eol::Crlf => data.extend_from_slice(content.replace('\n', "\r\n").as_bytes()),
    }
    if data.len() > FILE_LIMIT {
        return Err(too_large());
    }
    Ok(data)
}

pub fn read(dir: &str, name: &str) -> Result<Document> {
    let path = resolve(dir, name)?;
    let (data, meta) = bytes(&path)?;
    decode_document(&data, revision(&data, &meta))
}

// Keep the original file in place until a complete replacement is ready.
struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[cfg(not(windows))]
fn replace(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)
}

#[cfg(windows)]
fn replace(source: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn ReplaceFileW(
            replaced: *const u16,
            replacement: *const u16,
            backup: *const u16,
            flags: u32,
            exclude: *mut std::ffi::c_void,
            reserved: *mut std::ffi::c_void,
        ) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // ReplaceFile preserves the target ACL. Both strings are NUL terminated and
    // remain alive for the synchronous call; optional pointer arguments are null.
    let ok = unsafe {
        ReplaceFileW(
            target.as_ptr(),
            source.as_ptr(),
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Caller holds FILE_OPERATIONS and checks that no desktop run is syncing.
pub fn write(request: SaveRequest) -> Result<Saved> {
    let data = encode_content(&request.content, request.eol, request.bom)?;
    let crate::workspace_ref::WorkspaceRef::Local { dir } = &request.workspace else {
        return Err(invalid_path());
    };
    let path = resolve(dir, &request.name)?;
    let (original, meta) = bytes(&path)?;
    let conflict = || {
        FileError::new(
            "conflict",
            "文件已被其他程序修改。请复制需要保留的内容后重新加载，或取消保存",
        )
    };
    if revision(&original, &meta) != request.expected_revision {
        return Err(conflict());
    }
    if meta.permissions().readonly() {
        return Err(FileError::new("permission", "文件为只读，无法保存"));
    }
    let temp = Temporary(
        path.parent()
            .ok_or_else(invalid_path)?
            .join(format!(".rr-edit-{}.tmp", uuid::Uuid::new_v4())),
    );
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp.0)?;
    file.write_all(&data)?;
    file.set_permissions(meta.permissions())?;
    file.sync_all()?;
    drop(file);
    if resolve(dir, &request.name)? != path {
        return Err(conflict());
    }
    let (latest, latest_meta) = bytes(&path)?;
    if revision(&latest, &latest_meta) != request.expected_revision {
        return Err(conflict());
    }
    replace(&temp.0, &path)?;
    // Read after replacement so the revision includes the new file metadata.
    let saved = read(dir, &request.name)?;
    if saved.content != request.content {
        return Err(conflict());
    }
    Ok(Saved {
        revision: saved.revision,
    })
}

// ---------- 条目管理（新建 / 重命名 / 删除 / 列目录） ----------

const NAME_LIMIT: usize = 255;

fn invalid_name() -> FileError {
    FileError::new(
        "name",
        "名称无效：不能为空或为 . / ..，不能包含 \\ / : * ? \" < > | 或控制字符，不能以空格或 . 结尾，不能使用系统保留设备名，长度不超过 255",
    )
}

/// Windows device names are rejected on every platform so a workspace keeps
/// the same meaning when it is uploaded to SSH / WSL / serial devices.
fn reserved_device(name: &str) -> bool {
    const DEVICES: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = name.split('.').next().unwrap_or("");
    DEVICES
        .iter()
        .any(|device| device.eq_ignore_ascii_case(stem))
}

/// Split a workspace-relative path into validated components. Dot-prefixed names
/// are ordinary entries; standalone `.` and `..` are never path components.
pub(crate) fn components(relative: &str) -> Result<Vec<&str>> {
    if relative.is_empty() {
        return Err(invalid_name());
    }
    let mut parts = Vec::new();
    for part in relative.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(invalid_name());
        }
        if part.contains(['\\', ':', '*', '?', '"', '<', '>', '|', '\0'])
            || part.chars().any(char::is_control)
            || part.ends_with([' ', '.'])
            || part.len() > NAME_LIMIT
            || reserved_device(part)
        {
            return Err(invalid_name());
        }
        parts.push(part);
    }
    Ok(parts)
}

fn display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Resolve an existing directory inside the workspace. Every component must be
/// a real directory: links, junctions, and escapes are rejected on the way.
fn resolve_dir(root: &Path, parts: &[&str]) -> Result<PathBuf> {
    let mut path = root.to_path_buf();
    for part in parts {
        path.push(part);
        if redirected(&fs::symlink_metadata(&path)?) {
            return Err(invalid_path());
        }
        if !path.is_dir() {
            return Err(FileError::new(
                "not_found",
                format!("目录不存在：{}", display(root, &path)),
            ));
        }
    }
    Ok(path)
}

/// Resolve an existing file or directory, returning its metadata.
fn resolve_entry(root: &Path, parts: &[&str]) -> Result<(PathBuf, Metadata)> {
    let (name, parents) = parts.split_last().ok_or_else(invalid_name)?;
    let path = resolve_dir(root, parents)?.join(name);
    let meta = fs::symlink_metadata(&path)?;
    if redirected(&meta) {
        return Err(invalid_path());
    }
    let canonical = fs::canonicalize(&path)?;
    if !canonical.starts_with(root) || canonical != path {
        return Err(invalid_path());
    }
    Ok((path, meta))
}

/// Create an empty file or directory. Intermediate directories must exist.
/// Caller holds FILE_OPERATIONS and checks that no desktop run is syncing.
pub fn create(dir: &str, relative: &str, kind: EntryKind) -> Result<()> {
    let parts = components(relative)?;
    let root = canonical_root(dir)?;
    let (name, parents) = parts.split_last().ok_or_else(invalid_name)?;
    let path = resolve_dir(&root, parents)?.join(name);
    match kind {
        EntryKind::File => {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)?;
        }
        EntryKind::Dir => fs::create_dir(&path)?,
    }
    if redirected(&fs::symlink_metadata(&path)?) {
        let _ = match kind {
            EntryKind::File => fs::remove_file(&path),
            EntryKind::Dir => fs::remove_dir(&path),
        };
        return Err(invalid_path());
    }
    Ok(())
}

/// Create a file with initial content in one step（生成工作区配置模板等）。
/// 与 `write` 一样只接受无 NUL 的 LF 文本；已存在同名条目时拒绝。
/// Caller holds FILE_OPERATIONS and checks that no desktop run is syncing.
pub fn create_with_content(dir: &str, relative: &str, content: &str) -> Result<()> {
    if content.contains(['\0', '\r']) {
        return Err(FileError::new(
            "encoding",
            "文件内容必须是无 NUL 的 LF 文本",
        ));
    }
    if content.len() > FILE_LIMIT {
        return Err(too_large());
    }
    let parts = components(relative)?;
    let root = canonical_root(dir)?;
    let (name, parents) = parts.split_last().ok_or_else(invalid_name)?;
    let path = resolve_dir(&root, parents)?.join(name);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    if let Err(error) = file
        .write_all(content.as_bytes())
        .and_then(|()| file.sync_all())
    {
        let _ = fs::remove_file(&path);
        return Err(error.into());
    }
    drop(file);
    if redirected(&fs::symlink_metadata(&path)?) {
        let _ = fs::remove_file(&path);
        return Err(invalid_path());
    }
    Ok(())
}

/// Rename a file or directory. Existing targets are never overwritten; a
/// case-only rename of the same entry is allowed.
/// Caller holds FILE_OPERATIONS and checks that no desktop run is syncing.
pub fn rename(dir: &str, old_relative: &str, new_relative: &str) -> Result<()> {
    let old_parts = components(old_relative)?;
    let new_parts = components(new_relative)?;
    if old_parts == new_parts {
        return Ok(());
    }
    if new_parts.starts_with(old_parts.as_slice()) {
        return Err(FileError::new("path", "不能把目录重命名到自身内部"));
    }
    let root = canonical_root(dir)?;
    let (source, _) = resolve_entry(&root, &old_parts)?;
    let (name, parents) = new_parts.split_last().ok_or_else(invalid_name)?;
    let target = resolve_dir(&root, parents)?.join(name);
    if let Ok(existing) = fs::symlink_metadata(&target) {
        // Canonicalizing both sides makes a case-only rename of the same entry
        // compare equal while two distinct entries keep conflicting.
        let same_entry =
            !redirected(&existing) && fs::canonicalize(&source)? == fs::canonicalize(&target)?;
        if !same_entry {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                format!("目标已存在：{}", display(&root, &target)),
            )
            .into());
        }
    }
    fs::rename(&source, &target)?;
    Ok(())
}

/// Delete a file, or a directory with everything inside it. The workspace root
/// itself can never be addressed because a relative path is required.
/// Caller holds FILE_OPERATIONS and checks that no desktop run is syncing.
pub fn delete(dir: &str, relative: &str) -> Result<()> {
    let parts = components(relative)?;
    let root = canonical_root(dir)?;
    let (path, meta) = resolve_entry(&root, &parts)?;
    if meta.is_dir() {
        fs::remove_dir_all(&path)?;
    } else {
        fs::remove_file(&path)?;
    }
    Ok(())
}

/// List one directory level, including dot-prefixed entries. Links and junctions
/// are skipped so the tree only offers entries the app can operate on.
pub fn list_dir(dir: &str, subdir: &str) -> Result<Vec<Entry>> {
    let root = canonical_root(dir)?;
    let parts = if subdir.is_empty() {
        Vec::new()
    } else {
        components(subdir)?
    };
    let path = resolve_dir(&root, &parts)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&path)? {
        let entry = entry?;
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        // An entry may vanish between readdir and stat; skip instead of failing.
        let Ok(meta) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if redirected(&meta) {
            continue;
        }
        entries.push(Entry {
            name,
            is_dir: meta.is_dir(),
        });
    }
    entries.sort_by(|a, b| (b.is_dir, a.name.as_str()).cmp(&(a.is_dir, b.name.as_str())));
    Ok(entries)
}

/// Resolve a workspace directory as the working directory of a local terminal.
/// Validation matches listing: canonical root, no redirected components, every
/// part must be a real directory. Empty subdir means the workspace root.
/// 返回值直接成为 shell 的 cwd，因此用常规形式（去掉 canonicalize 的 `\\?\` 前缀）。
pub fn terminal_dir(dir: &str, subdir: &str) -> Result<PathBuf> {
    let root = canonical_root(dir)?;
    let parts = if subdir.is_empty() {
        Vec::new()
    } else {
        components(subdir)?
    };
    Ok(crate::verbatim::simplify(&resolve_dir(&root, &parts)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new(data: &[u8]) -> Self {
            let root = std::env::temp_dir().join(format!("rr-editor-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            fs::write(root.join("main.py"), data).unwrap();
            Self(root)
        }
        fn dir(&self) -> &str {
            self.0.to_str().unwrap()
        }
        fn request(&self, content: &str) -> SaveRequest {
            let doc = read(self.dir(), "main.py").unwrap();
            SaveRequest {
                workspace: crate::workspace_ref::WorkspaceRef::local(self.dir()),
                name: "main.py".into(),
                content: content.into(),
                expected_revision: doc.revision,
                eol: doc.eol,
                bom: doc.bom,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn preserves_bom_crlf_and_final_newline_and_returns_new_revision() {
        let f = Fixture::new(b"\xef\xbb\xbfprint(1)\r\n");
        let doc = read(f.dir(), "main.py").unwrap();
        assert_eq!(doc.content, "print(1)\n");
        let saved = write(f.request("print('中文')\n")).unwrap();
        assert_eq!(
            fs::read(f.0.join("main.py")).unwrap(),
            "\u{feff}print('中文')\r\n".as_bytes()
        );
        assert_ne!(saved.revision, doc.revision);
        assert_eq!(saved.revision, read(f.dir(), "main.py").unwrap().revision);
        write(f.request("")).unwrap();
        assert_eq!(fs::read(f.0.join("main.py")).unwrap(), b"\xef\xbb\xbf");
        assert_eq!(fs::read_dir(&f.0).unwrap().count(), 1);
    }

    #[test]
    fn conflict_and_deletion_preserve_external_changes() {
        let f = Fixture::new(b"original");
        let request = f.request("mine");
        fs::write(f.0.join("main.py"), b"external").unwrap();
        assert_eq!(write(request).unwrap_err().code, "conflict");
        assert_eq!(fs::read(f.0.join("main.py")).unwrap(), b"external");
        let request = f.request("mine");
        fs::remove_file(f.0.join("main.py")).unwrap();
        assert_eq!(write(request).unwrap_err().code, "not_found");
        assert!(!f.0.join("main.py").exists());
    }

    #[test]
    fn rejects_invalid_paths_encodings_and_sizes() {
        let f = Fixture::new(b"ok");
        for name in [
            "../main.py",
            "/main.py",
            "C:/main.py",
            "main.py:stream",
            "a\\b",
            "",
            "main.py\0",
        ] {
            assert_eq!(read(f.dir(), name).unwrap_err().code, "path");
        }
        for data in [b"a\0b".as_slice(), b"\xff", b"a\r\nb\nc", b"a\rb"] {
            fs::write(f.0.join("main.py"), data).unwrap();
            assert!(read(f.dir(), "main.py").is_err());
        }
        fs::write(f.0.join("main.py"), vec![b'a'; FILE_LIMIT]).unwrap();
        assert!(read(f.dir(), "main.py").is_ok());
        let request = f.request(&"b".repeat(FILE_LIMIT + 1));
        assert_eq!(write(request).unwrap_err().code, "too_large");
        let mut request = f.request(&"\n".repeat(FILE_LIMIT / 2 + 1));
        request.eol = Eol::Crlf;
        assert_eq!(write(request).unwrap_err().code, "too_large");
        fs::write(f.0.join("main.py"), vec![b'a'; FILE_LIMIT + 1]).unwrap();
        assert_eq!(read(f.dir(), "main.py").unwrap_err().code, "too_large");
    }

    #[test]
    fn replacement_failure_keeps_original() {
        let f = Fixture::new(b"original");
        assert!(replace(&f.0.join("missing"), &f.0.join("main.py")).is_err());
        assert_eq!(fs::read(f.0.join("main.py")).unwrap(), b"original");
    }

    #[cfg(windows)]
    #[test]
    fn sharing_violation_during_replace_preserves_original_and_cleans_temp() {
        use std::os::windows::fs::OpenOptionsExt;
        let f = Fixture::new(b"original");
        let request = f.request("new content");
        // Permit reading/writing, but keep FILE_SHARE_DELETE off so replacement fails.
        let held = OpenOptions::new()
            .read(true)
            .share_mode(3)
            .open(f.0.join("main.py"))
            .unwrap();
        assert!(write(request).is_err());
        drop(held);
        assert_eq!(fs::read(f.0.join("main.py")).unwrap(), b"original");
        assert_eq!(fs::read_dir(&f.0).unwrap().count(), 1);
    }

    #[test]
    fn readonly_file_is_not_replaced() {
        let f = Fixture::new(b"original");
        let path = f.0.join("main.py");
        let request = f.request("new content");
        let original_permissions = fs::metadata(&path).unwrap().permissions();
        let mut permissions = original_permissions.clone();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();
        let result = write(request);
        fs::set_permissions(&path, original_permissions).unwrap();
        assert_eq!(result.unwrap_err().code, "permission");
        assert_eq!(fs::read(path).unwrap(), b"original");
    }

    #[cfg(windows)]
    #[test]
    fn windows_symbolic_links_are_rejected_when_creation_is_permitted() {
        let f = Fixture::new(b"original");
        match std::os::windows::fs::symlink_file(f.0.join("main.py"), f.0.join("link.py")) {
            Ok(()) => assert_eq!(read(f.dir(), "link.py").unwrap_err().code, "path"),
            Err(error) if error.raw_os_error() == Some(1314) => {
                eprintln!(
                    "SKIP Windows symlink check: this account lacks symlink creation privilege"
                );
            }
            Err(error) => panic!("cannot create test symlink: {error}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_links_and_preserves_executable_permission() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let f = Fixture::new(b"echo hi\n");
        symlink(f.0.join("main.py"), f.0.join("link.py")).unwrap();
        assert_eq!(read(f.dir(), "link.py").unwrap_err().code, "path");
        fs::set_permissions(f.0.join("main.py"), fs::Permissions::from_mode(0o755)).unwrap();
        write(f.request("echo bye\n")).unwrap();
        assert_eq!(
            fs::metadata(f.0.join("main.py"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
    }

    fn names(entries: Vec<Entry>) -> Vec<(String, bool)> {
        entries
            .into_iter()
            .map(|entry| (entry.name, entry.is_dir))
            .collect()
    }

    #[test]
    fn create_with_content_writes_template_and_rejects_existing_or_bad_text() {
        let f = Fixture::new(b"ok");
        create_with_content(f.dir(), "pyproject.toml", "[project]\nname = \"x\"\n").unwrap();
        assert_eq!(
            fs::read(f.0.join("pyproject.toml")).unwrap(),
            b"[project]\nname = \"x\"\n"
        );
        assert_eq!(
            create_with_content(f.dir(), "pyproject.toml", "other")
                .unwrap_err()
                .code,
            "exists"
        );
        // 已存在的内容不被覆盖
        assert_eq!(
            fs::read(f.0.join("pyproject.toml")).unwrap(),
            b"[project]\nname = \"x\"\n"
        );
        assert_eq!(
            create_with_content(f.dir(), "bad.toml", "a\rb")
                .unwrap_err()
                .code,
            "encoding"
        );
        assert!(!f.0.join("bad.toml").exists());
        assert_eq!(
            create_with_content(f.dir(), "sub/cfg.toml", "x")
                .unwrap_err()
                .code,
            "not_found"
        );
    }

    #[test]
    fn creates_files_and_directories_and_lists_one_level() {
        let f = Fixture::new(b"ok");
        create(f.dir(), "notes.txt", EntryKind::File).unwrap();
        create(f.dir(), "sub", EntryKind::Dir).unwrap();
        create(f.dir(), "sub/inner.py", EntryKind::File).unwrap();
        assert_eq!(fs::read(f.0.join("notes.txt")).unwrap(), b"");
        assert!(f.0.join("sub").join("inner.py").is_file());
        assert_eq!(
            names(list_dir(f.dir(), "").unwrap()),
            [
                ("sub".to_string(), true),
                ("main.py".to_string(), false),
                ("notes.txt".to_string(), false)
            ]
        );
        assert_eq!(
            names(list_dir(f.dir(), "sub").unwrap()),
            [("inner.py".to_string(), false)]
        );
        assert_eq!(
            create(f.dir(), "notes.txt", EntryKind::File)
                .unwrap_err()
                .code,
            "exists"
        );
        assert_eq!(
            create(f.dir(), "sub", EntryKind::Dir).unwrap_err().code,
            "exists"
        );
        assert_eq!(
            create(f.dir(), "missing/inner.py", EntryKind::File)
                .unwrap_err()
                .code,
            "not_found"
        );
    }

    #[test]
    fn terminal_dir_resolves_root_and_subdir_but_rejects_files_and_escapes() {
        let f = Fixture::new(b"ok");
        create(f.dir(), "sub", EntryKind::Dir).unwrap();
        create(f.dir(), "sub/inner", EntryKind::Dir).unwrap();
        let canonical = fs::canonicalize(&f.0).unwrap();
        // 终端 cwd 走常规形式：Windows 上不能把 canonicalize 的 \\?\ 前缀交给 shell
        let expect = |rel: &str| {
            crate::verbatim::simplify(&if rel.is_empty() {
                canonical.clone()
            } else {
                canonical.join(rel)
            })
        };
        assert_eq!(terminal_dir(f.dir(), "").unwrap(), expect(""));
        assert_eq!(terminal_dir(f.dir(), "sub").unwrap(), expect("sub"));
        assert_eq!(
            terminal_dir(f.dir(), "sub/inner").unwrap(),
            expect("sub/inner")
        );
        assert!(!terminal_dir(f.dir(), "")
            .unwrap()
            .to_string_lossy()
            .starts_with(r"\\?\"));
        // 与 list_dir 同一套校验：越界/非法名 → name；指向文件或缺失 → not_found/path
        for subdir in ["..", "../evil", "a/../b", "./hidden", "a\\b"] {
            assert_eq!(
                terminal_dir(f.dir(), subdir).unwrap_err().code,
                "name",
                "{subdir:?}"
            );
        }
        assert_eq!(
            terminal_dir(f.dir(), "missing").unwrap_err().code,
            "not_found"
        );
        assert_eq!(
            terminal_dir(f.dir(), "main.py").unwrap_err().code,
            "not_found"
        );
        assert_eq!(
            terminal_dir(f.dir(), "sub/missing").unwrap_err().code,
            "not_found"
        );
    }

    #[test]
    fn rejects_invalid_entry_names_and_workspace_escapes() {
        let f = Fixture::new(b"ok");
        let long = "n".repeat(NAME_LIMIT + 1);
        for name in [
            "",
            ".",
            "..",
            "../evil",
            "a/../b",
            "/abs",
            "a//b",
            "./hidden",
            "a/./b",
            "con",
            "NUL.txt",
            "a\\b",
            "a:b",
            "bad*name",
            "tail.",
            "tail ",
            "a\0b",
            "ctrl\u{1}",
            long.as_str(),
        ] {
            assert_eq!(
                create(f.dir(), name, EntryKind::File).unwrap_err().code,
                "name",
                "{name:?}"
            );
            assert_eq!(delete(f.dir(), name).unwrap_err().code, "name", "{name:?}");
            assert_eq!(
                rename(f.dir(), "main.py", name).unwrap_err().code,
                "name",
                "{name:?}"
            );
            assert_eq!(
                rename(f.dir(), name, "ok.py").unwrap_err().code,
                "name",
                "{name:?}"
            );
            // An empty subdir selects the workspace root, so listing allows it.
            if !name.is_empty() {
                assert_eq!(
                    list_dir(f.dir(), name).unwrap_err().code,
                    "name",
                    "{name:?}"
                );
            }
        }
        assert_eq!(fs::read_dir(&f.0).unwrap().count(), 1);
        assert!(!f.0.join("evil").exists());
    }

    #[test]
    fn renames_entries_without_overwriting_targets() {
        let f = Fixture::new(b"original");
        create(f.dir(), "sub", EntryKind::Dir).unwrap();
        fs::write(f.0.join("other.txt"), b"other").unwrap();
        rename(f.dir(), "main.py", "renamed.py").unwrap();
        assert_eq!(fs::read(f.0.join("renamed.py")).unwrap(), b"original");
        assert!(!f.0.join("main.py").exists());
        assert_eq!(
            rename(f.dir(), "renamed.py", "other.txt").unwrap_err().code,
            "exists"
        );
        assert_eq!(fs::read(f.0.join("other.txt")).unwrap(), b"other");
        assert_eq!(
            rename(f.dir(), "renamed.py", "sub").unwrap_err().code,
            "exists"
        );
        rename(f.dir(), "renamed.py", "sub/moved.py").unwrap();
        assert!(f.0.join("sub").join("moved.py").is_file());
        rename(f.dir(), "sub", "moved").unwrap();
        assert!(f.0.join("moved").join("moved.py").is_file());
        assert_eq!(
            rename(f.dir(), "moved", "moved/nested").unwrap_err().code,
            "path"
        );
        assert!(f.0.join("moved").join("moved.py").is_file());
        rename(f.dir(), "other.txt", "other.txt").unwrap();
        assert_eq!(
            rename(f.dir(), "gone.py", "x.py").unwrap_err().code,
            "not_found"
        );
    }

    #[test]
    fn deletes_files_and_directories_recursively() {
        let f = Fixture::new(b"original");
        create(f.dir(), "sub", EntryKind::Dir).unwrap();
        create(f.dir(), "sub/nested", EntryKind::Dir).unwrap();
        create(f.dir(), "sub/nested/deep.py", EntryKind::File).unwrap();
        delete(f.dir(), "main.py").unwrap();
        assert!(!f.0.join("main.py").exists());
        delete(f.dir(), "sub").unwrap();
        assert!(!f.0.join("sub").exists());
        assert_eq!(delete(f.dir(), "main.py").unwrap_err().code, "not_found");
        assert_eq!(delete(f.dir(), "sub/nested").unwrap_err().code, "not_found");
        assert!(f.0.is_dir());
    }

    #[test]
    fn dot_entries_can_be_created_listed_edited_renamed_and_deleted() {
        let f = Fixture::new(b"ok");
        for name in [".env", ".gitignore", ".config.toml", "..settings"] {
            create(f.dir(), name, EntryKind::File).unwrap();
            assert!(list_dir(f.dir(), "")
                .unwrap()
                .iter()
                .any(|entry| entry.name == name && !entry.is_dir));
            let file = read(f.dir(), name).unwrap();
            write(SaveRequest {
                workspace: crate::workspace_ref::WorkspaceRef::local(f.dir()),
                name: name.into(),
                content: "example=value\n".into(),
                expected_revision: file.revision,
                eol: Eol::Lf,
                bom: false,
            })
            .unwrap();
            assert_eq!(read(f.dir(), name).unwrap().content, "example=value\n");
            rename(f.dir(), name, "visible.txt").unwrap();
            rename(f.dir(), "visible.txt", name).unwrap();
            delete(f.dir(), name).unwrap();
        }
        create(f.dir(), ".config", EntryKind::Dir).unwrap();
        create(f.dir(), ".config/.env", EntryKind::File).unwrap();
        assert_eq!(
            names(list_dir(f.dir(), "").unwrap()),
            [
                (".config".to_string(), true),
                ("main.py".to_string(), false)
            ]
        );
        assert_eq!(
            names(list_dir(f.dir(), ".config").unwrap()),
            [(".env".to_string(), false)]
        );
        assert!(terminal_dir(f.dir(), ".config").unwrap().is_dir());
        delete(f.dir(), ".config").unwrap();
        assert!(!f.0.join(".config").exists());
    }

    #[test]
    fn python_version_is_listed_and_fully_manageable() {
        let f = Fixture::new(b"ok");
        // 项目契约文件与其他点开头条目使用同一套名称规则。
        create(f.dir(), ".python-version", EntryKind::File).unwrap();
        assert_eq!(
            names(list_dir(f.dir(), "").unwrap()),
            [
                (".python-version".to_string(), false),
                ("main.py".to_string(), false)
            ]
        );
        let request = SaveRequest {
            workspace: crate::workspace_ref::WorkspaceRef::local(f.dir()),
            name: ".python-version".into(),
            content: "3.12.9\n".into(),
            expected_revision: read(f.dir(), ".python-version").unwrap().revision,
            eol: Eol::Lf,
            bom: false,
        };
        write(request).unwrap();
        assert_eq!(
            read(f.dir(), ".python-version").unwrap().content,
            "3.12.9\n"
        );
        rename(f.dir(), ".python-version", "python-version.bak").unwrap();
        rename(f.dir(), "python-version.bak", ".python-version").unwrap();
        delete(f.dir(), ".python-version").unwrap();
        assert!(!f.0.join(".python-version").exists());
    }

    #[cfg(unix)]
    #[test]
    fn entry_operations_reject_links_and_hide_them_from_the_tree() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new(b"ok");
        fs::create_dir(f.0.join("real")).unwrap();
        symlink(f.0.join("real"), f.0.join("link")).unwrap();
        symlink(f.0.join("main.py"), f.0.join("file-link.py")).unwrap();
        assert_eq!(
            names(list_dir(f.dir(), "").unwrap()),
            [("real".to_string(), true), ("main.py".to_string(), false)]
        );
        assert_eq!(delete(f.dir(), "link").unwrap_err().code, "path");
        assert_eq!(rename(f.dir(), "link", "other").unwrap_err().code, "path");
        assert_eq!(
            create(f.dir(), "link/inner.py", EntryKind::File)
                .unwrap_err()
                .code,
            "path"
        );
        assert!(f.0.join("real").is_dir());
        assert!(f.0.join("main.py").is_file());
    }

    #[cfg(windows)]
    #[test]
    fn entry_operations_reject_links_and_hide_them_from_the_tree() {
        let f = Fixture::new(b"ok");
        fs::create_dir(f.0.join("real")).unwrap();
        match std::os::windows::fs::symlink_dir(f.0.join("real"), f.0.join("link")) {
            Ok(()) => {
                assert_eq!(
                    names(list_dir(f.dir(), "").unwrap()),
                    [("real".to_string(), true), ("main.py".to_string(), false)]
                );
                assert_eq!(delete(f.dir(), "link").unwrap_err().code, "path");
                assert_eq!(rename(f.dir(), "link", "other").unwrap_err().code, "path");
                assert!(f.0.join("real").is_dir());
            }
            Err(error) if error.raw_os_error() == Some(1314) => {
                eprintln!("SKIP Windows link check: this account lacks symlink creation privilege");
            }
            Err(error) => panic!("cannot create test symlink: {error}"),
        }
    }
}
