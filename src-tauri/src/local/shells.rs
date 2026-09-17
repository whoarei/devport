//! 本机 shell 注册表：已知 shell 的探测、解析与调用风味。
use crate::device::LocalConfig;
use crate::error::{Result, RunnerError};
use serde::Serialize;
use std::path::PathBuf;

fn failure(message: impl Into<String>) -> RunnerError {
    RunnerError::Local(message.into())
}

/// shell 的命令行风味，决定脚本/命令类型的 argv 构造方式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flavor {
    Posix,
    PowerShell,
    Cmd,
}

/// 已解析、可直接用于 spawn 的本机 shell
#[derive(Debug, Clone)]
pub struct Shell {
    pub id: &'static str,
    pub label: &'static str,
    pub flavor: Flavor,
    pub path: PathBuf,
    /// posix shell 是否以 login 方式运行（msys2/gitbash 需要 /etc/profile 提供完整 PATH）
    pub login: bool,
    /// PowerShell 是否加 `-NoProfile`（唯一开关，见 `LocalConfig::no_profile`）
    pub no_profile: bool,
}

/// 前端下拉使用的可用 shell 信息
#[derive(Debug, Clone, Serialize)]
pub struct ShellInfo {
    pub id: String,
    pub label: String,
    pub path: String,
}

struct Candidate {
    id: &'static str,
    label: &'static str,
    flavor: Flavor,
    login: bool,
    candidates: Vec<PathBuf>,
}

/// PATH 查找（不依赖 which/where，Windows 追加 .exe）。
/// 注意：Windows 上排除 System32 下的 bash.exe（WSL 启动器，非本机 shell）。
pub(crate) fn find_on_path(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
        #[cfg(windows)]
        let candidate = dir.join(format!("{name}.exe"));
        #[cfg(not(windows))]
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(windows)]
fn system_root() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
}

fn registry() -> Vec<Candidate> {
    #[cfg(windows)]
    {
        let root = system_root();
        let mut pwsh = vec![PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe")];
        if let Some(found) = find_on_path("pwsh") {
            pwsh.insert(0, found);
        }
        let comspec = std::env::var_os("ComSpec")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join(r"System32\cmd.exe"));
        let mut msys2 = Vec::new();
        if let Some(root) = std::env::var_os("MSYS2_ROOT") {
            msys2.push(PathBuf::from(root).join(r"usr\bin\bash.exe"));
        }
        msys2.push(PathBuf::from(r"C:\msys64\usr\bin\bash.exe"));
        vec![
            Candidate {
                id: "pwsh",
                label: "PowerShell 7 (pwsh)",
                flavor: Flavor::PowerShell,
                login: false,
                candidates: pwsh,
            },
            Candidate {
                id: "powershell",
                label: "Windows PowerShell",
                flavor: Flavor::PowerShell,
                login: false,
                candidates: vec![root.join(r"System32\WindowsPowerShell\v1.0\powershell.exe")],
            },
            Candidate {
                id: "cmd",
                label: "Command Prompt (cmd)",
                flavor: Flavor::Cmd,
                login: false,
                candidates: vec![comspec],
            },
            Candidate {
                id: "msys2",
                label: "MSYS2 bash",
                flavor: Flavor::Posix,
                login: true,
                candidates: msys2,
            },
            Candidate {
                id: "gitbash",
                label: "Git Bash",
                flavor: Flavor::Posix,
                login: true,
                candidates: vec![PathBuf::from(r"C:\Program Files\Git\bin\bash.exe")],
            },
        ]
    }
    #[cfg(not(windows))]
    {
        let mut bash = vec![PathBuf::from("/bin/bash")];
        if let Some(found) = find_on_path("bash") {
            bash.insert(0, found);
        }
        let mut zsh = vec![PathBuf::from("/bin/zsh")];
        if let Some(found) = find_on_path("zsh") {
            zsh.insert(0, found);
        }
        vec![
            Candidate {
                id: "bash",
                label: "bash",
                flavor: Flavor::Posix,
                login: false,
                candidates: bash,
            },
            Candidate {
                id: "zsh",
                label: "zsh",
                flavor: Flavor::Posix,
                login: false,
                candidates: zsh,
            },
            Candidate {
                id: "sh",
                label: "sh",
                flavor: Flavor::Posix,
                login: false,
                candidates: vec![PathBuf::from("/bin/sh")],
            },
        ]
    }
}

/// 探测当前平台全部可用 shell
pub fn detect() -> Vec<ShellInfo> {
    registry()
        .into_iter()
        .filter_map(|c| {
            c.candidates
                .iter()
                .find(|p| p.is_file())
                .map(|path| ShellInfo {
                    id: c.id.to_string(),
                    label: c.label.to_string(),
                    path: path.to_string_lossy().into_owned(),
                })
        })
        .collect()
}

/// 按设备配置解析 shell；path 覆盖时必须是已存在的文件
pub fn resolve(config: &LocalConfig) -> Result<Shell> {
    config.validate()?;
    let candidate = registry()
        .into_iter()
        .find(|c| c.id == config.shell)
        .ok_or_else(|| {
            failure(format!(
                "unknown local shell {:?}; run shell detection to list available ids",
                config.shell
            ))
        })?;
    let path = match &config.path {
        Some(path) => {
            let path = PathBuf::from(path);
            if !path.is_file() {
                return Err(failure(format!(
                    "local shell executable does not exist: {}",
                    path.display()
                )));
            }
            path
        }
        None => candidate
            .candidates
            .iter()
            .find(|p| p.is_file())
            .cloned()
            .ok_or_else(|| {
                failure(format!(
                    "local shell {:?} was not found on this machine",
                    config.shell
                ))
            })?,
    };
    Ok(Shell {
        id: candidate.id,
        label: candidate.label,
        flavor: candidate.flavor,
        path,
        login: candidate.login,
        no_profile: config.no_profile,
    })
}

/// 仅测试使用：挑选一个必然存在的 shell（Windows: cmd；Unix: sh）
#[cfg(test)]
pub fn fallback_for_test() -> Shell {
    let id = if cfg!(windows) { "cmd" } else { "sh" };
    resolve(&LocalConfig {
        shell: id.into(),
        path: None,
        no_profile: false,
    })
    .expect("fallback shell must exist")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detection_finds_platform_fallback_shell() {
        let shells = detect();
        let fallback = if cfg!(windows) { "cmd" } else { "sh" };
        assert!(
            shells.iter().any(|s| s.id == fallback),
            "expected {fallback} in {shells:?}"
        );
    }

    #[test]
    fn resolve_rejects_unknown_ids_and_missing_paths() {
        let config = |shell: &str, path: Option<&str>| LocalConfig {
            shell: shell.into(),
            path: path.map(str::to_owned),
            no_profile: false,
        };
        assert!(resolve(&config("nosuchshell", None)).is_err());
        let fallback = if cfg!(windows) { "cmd" } else { "sh" };
        assert!(resolve(&config(fallback, Some("E:/definitely/missing/shell.exe"))).is_err());
        let shell = resolve(&config(fallback, None)).unwrap();
        assert!(shell.path.is_file());
        // profile 开关由配置解析到 shell 上（默认加载 profile）
        assert!(!shell.no_profile);
        assert!(
            resolve(&LocalConfig {
                no_profile: true,
                ..config(fallback, None)
            })
            .unwrap()
            .no_profile
        );
    }
}
