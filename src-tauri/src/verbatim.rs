//! Windows verbatim 路径（`\\?\`）还原成常规形式。
//!
//! `std::fs::canonicalize` 在 Windows 上返回 verbatim 形式（`\\?\D:\a\b`）：对 Win32 API
//! 合法，但一旦交给 shell 或界面就走样——PowerShell 把它渲染成
//! `Microsoft.PowerShell.Core\FileSystem::\\?\D:\a\b`，MSYS2/Git Bash 的路径转换会拼出
//! `//?/D:/a/b` 这种不存在的入口路径。
//!
//! 因此路径校验（包含关系、符号链接、组件合法性）继续使用 canonical 形式，
//! 只有把路径交给外部（shell spawn、终端 cwd、运行请求里的工作区）之前才经过这里。

use std::path::{Path, PathBuf};

/// 常规形式（非 verbatim）路径的长度上限 MAX_PATH。达到或超过它的路径必须保留
/// `\\?\` 前缀，否则 Win32 API 会拒绝。
#[cfg(windows)]
const MAX_NORMAL_PATH: usize = 260;

#[cfg(windows)]
const VERBATIM: &str = r"\\?\";

#[cfg(windows)]
const VERBATIM_UNC: &str = r"\\?\UNC\";

/// 还原 verbatim 前缀；只要不能确定还原后语义完全一致就原样返回。
///
/// 处理两类形式：`\\?\C:\a` → `C:\a`，`\\?\UNC\server\share` → `\\server\share`。
/// 设备路径（`\\?\Volume{GUID}\a`、`\\?\GLOBALROOT\...`）没有常规等价形式，保持原样。
#[cfg(windows)]
pub fn simplify(path: &Path) -> PathBuf {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    let wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    let body: Vec<u16> = if prefixed(&wide, VERBATIM_UNC) {
        let mut restored: Vec<u16> = r"\\".encode_utf16().collect();
        restored.extend_from_slice(&wide[VERBATIM_UNC.encode_utf16().count()..]);
        restored
    } else if prefixed(&wide, VERBATIM) {
        let rest = &wide[VERBATIM.encode_utf16().count()..];
        if !is_drive_path(rest) {
            return path.to_path_buf();
        }
        rest.to_vec()
    } else {
        return path.to_path_buf();
    };
    if body.len() >= MAX_NORMAL_PATH || has_verbatim_only_component(&body) {
        return path.to_path_buf();
    }
    PathBuf::from(OsString::from_wide(&body))
}

#[cfg(not(windows))]
pub fn simplify(path: &Path) -> PathBuf {
    path.to_path_buf()
}

#[cfg(windows)]
fn prefixed(wide: &[u16], prefix: &str) -> bool {
    // Windows 只输出大写的 `\\?\`，仍然按大小写不敏感比较以免漏判
    let lower = |c: u16| {
        if (0x41..=0x5A).contains(&c) {
            c + 0x20
        } else {
            c
        }
    };
    let prefix: Vec<u16> = prefix.encode_utf16().collect();
    wide.len() >= prefix.len()
        && wide[..prefix.len()]
            .iter()
            .zip(&prefix)
            .all(|(left, right)| lower(*left) == lower(*right))
}

/// `C:\...` 形式（盘符 + 冒号 + 反斜杠）
#[cfg(windows)]
fn is_drive_path(wide: &[u16]) -> bool {
    matches!(wide.first(), Some(0x41..=0x5A | 0x61..=0x7A))
        && wide.get(1) == Some(&(b':' as u16))
        && wide.get(2) == Some(&(b'\\' as u16))
}

/// 组件以点或空格结尾、或使用 DOS 保留设备名时，Win32 会自行改写路径含义
/// （去掉尾随点/空格、把 `CON` 当设备），只能保留 verbatim 前缀。
#[cfg(windows)]
fn has_verbatim_only_component(wide: &[u16]) -> bool {
    wide.split(|c| *c == b'\\' as u16).any(|part| {
        matches!(part.last(), Some(last) if *last == b'.' as u16 || *last == b' ' as u16)
            || is_reserved_name(part)
    })
}

#[cfg(windows)]
fn is_reserved_name(component: &[u16]) -> bool {
    let text = String::from_utf16_lossy(component);
    // 保留名对扩展名不敏感：CON.txt 同样是设备名
    let base = text
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (base.len() == 4
            && (base.starts_with("COM") || base.starts_with("LPT"))
            && matches!(base.as_bytes()[3], b'1'..=b'9'))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn strips_drive_and_unc_prefixes() {
        assert_eq!(
            simplify(Path::new(r"\\?\D:\安视讯\测试")),
            PathBuf::from(r"D:\安视讯\测试")
        );
        assert_eq!(
            simplify(Path::new(r"\\?\C:\ws\sub")),
            PathBuf::from(r"C:\ws\sub")
        );
        assert_eq!(
            simplify(Path::new(r"\\?\UNC\server\share\ws")),
            PathBuf::from(r"\\server\share\ws")
        );
        // 真实 canonicalize 产物还原后必须仍指向同一个目录
        let canonical = std::env::temp_dir().canonicalize().unwrap();
        let simplified = simplify(&canonical);
        assert!(
            !simplified.to_string_lossy().starts_with(r"\\?\"),
            "{simplified:?}"
        );
        assert!(simplified.is_dir());
    }

    #[test]
    fn leaves_non_verbatim_paths_untouched() {
        for path in [r"C:\ws", r"\\server\share\ws", "/tmp/ws", r"D:\安视讯\测试"] {
            assert_eq!(simplify(Path::new(path)), PathBuf::from(path));
        }
    }

    #[test]
    fn keeps_paths_with_no_normal_equivalent() {
        // 设备路径、超长路径、以及去掉前缀会改变含义的路径
        for path in [
            r"\\?\Volume{1c2d3e4f-0000-0000-0000-100000000000}\ws",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\ws",
            r"\\?\C:\ws\trailing.",
            r"\\?\C:\ws\trailing ",
            r"\\?\C:\ws\CON",
            r"\\?\C:\ws\com1.txt",
            r"\\?\C:\ws\LPT9",
            r"\\?\C:relative",
        ] {
            assert_eq!(simplify(Path::new(path)), PathBuf::from(path), "{path}");
        }
        // 达到 MAX_PATH 的路径保留前缀，否则 Win32 会拒绝
        let long = format!(r"\\?\C:\{}=\x", "d".repeat(MAX_NORMAL_PATH));
        assert_eq!(simplify(Path::new(&long)), PathBuf::from(&long));
    }
}
