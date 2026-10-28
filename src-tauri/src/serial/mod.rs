pub mod filesync;
pub mod protocol;
pub mod session;
pub mod terminal;
#[cfg(test)]
mod tests;
pub mod transport;

use crate::device::DeviceProfile;
use crate::error::{Result, RunnerError};
use crate::process::SessionControl;
use crate::process::{Outcome, OutputStream, RunState};
use crate::runner::{build_script, sh_quote, RunRequest, ScriptKind};
use session::ShellSession;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;

pub use session::StopReason;

pub use crate::process::ExecutionEvent as Event;

/// Validate every generated line before opening the port or creating remote files.
pub fn preflight(req: &RunRequest, remote: &str, files: &[filesync::UploadEntry]) -> Result<()> {
    let nonce = "00000000000000000000000000000000";
    protocol::validate_wire_command(&protocol::wrap(
        &build_script(req, remote),
        nonce,
        Some((req.cols, req.rows)),
    ))?;
    protocol::validate_wire_command(&protocol::wrap(
        &format!("mkdir -p {}", sh_quote(remote)),
        nonce,
        None,
    ))?;
    for file in files {
        for command in file.commands(remote) {
            protocol::validate_wire_command(&protocol::wrap(&command, nonce, None))?;
        }
    }
    Ok(())
}

pub async fn test_device(device: &DeviceProfile) -> Result<String> {
    device.validate()?;
    let config = device
        .serial
        .as_ref()
        .ok_or_else(|| RunnerError::InvalidInput("serial configuration is required".into()))?;
    let _lease = transport::PortLease::acquire(&config.port)?;
    let mut session = ShellSession::new(transport::open(config)?, config.baud_rate);
    let (_tx, mut rx) = mpsc::unbounded_channel();
    let mut output = Vec::new();
    let result = session
        .execute(
            "command -v sh >/dev/null && command -v stty >/dev/null && command -v base64 >/dev/null && uname -a",
            None,
            Some(Duration::from_secs(5)),
            &mut rx,
            |data| {
                output.extend(
                    data.into_iter()
                        .take(64 * 1024 - output.len().min(64 * 1024)),
                )
            },
            |_| {},
        )
        .await?;
    if result.code != 0 || result.stopped.is_some() {
        return Err(RunnerError::Serial("serial shell probe failed".into()));
    }
    Ok(format!(
        "Serial shell ready ({} baud, 8N1)\n{}",
        config.baud_rate,
        String::from_utf8_lossy(&output)
    ))
}

/// Generic stream executor so the full protocol can be verified with a simulated device.
pub async fn execute<T: AsyncRead + AsyncWrite + Unpin>(
    io: T,
    baud_rate: u32,
    req: &RunRequest,
    remote: &str,
    files: Vec<filesync::UploadEntry>,
    controls: &mut mpsc::UnboundedReceiver<SessionControl>,
    events: impl Fn(Event),
) -> Result<Outcome> {
    let mut owned_request = req.clone();
    let req = &mut owned_request;
    preflight(req, remote, &files)?;
    let mut session = ShellSession::new(io, baud_rate);
    let runtime_probe = match &req.kind {
        ScriptKind::Python if req.workspace_context.is_some() => "",
        ScriptKind::Python => " && command -v python3 >/dev/null",
        ScriptKind::Shell => " && command -v bash >/dev/null",
        ScriptKind::Command => "",
    };
    let probe_command = format!(
        "command -v sh >/dev/null && command -v stty >/dev/null && command -v base64 >/dev/null{runtime_probe}"
    );
    let probe = session
        .execute(
            &probe_command,
            None,
            Some(Duration::from_secs(5)),
            controls,
            |_| {},
            |_| {},
        )
        .await?;
    if probe.stopped == Some(StopReason::Timeout) {
        return Err(RunnerError::Serial(
            "serial capability probe timed out".into(),
        ));
    }
    if probe.stopped.is_some() {
        return Ok(probe.into());
    }
    if probe.code != 0 {
        return Err(RunnerError::Serial(
            "serial shell is missing a required command (sh, stty, base64, or the selected runtime)".into(),
        ));
    }

    let resolved_remote = if req.workspace.is_some() && remote.starts_with("~/") {
        let mut home = Vec::new();
        let result = session
            .execute(
                "printf '%s' \"$HOME\"",
                None,
                Some(Duration::from_secs(5)),
                controls,
                |data| home.extend(data.into_iter().take(8193_usize.saturating_sub(home.len()))),
                |_| {},
            )
            .await?;
        if result.stopped == Some(StopReason::Timeout) {
            return Err(RunnerError::Serial("home directory probe timed out".into()));
        }
        if result.stopped.is_some() {
            return Ok(result.into());
        }
        if result.code != 0 || home.len() > 8192 {
            return Err(RunnerError::Serial("cannot resolve home directory".into()));
        }
        let home = String::from_utf8(home)
            .map_err(|_| RunnerError::Serial("home directory is not UTF-8".into()))?;
        crate::device::expand_home_path(remote, &home)?
    } else {
        remote.to_string()
    };
    let remote = resolved_remote.as_str();
    preflight(req, remote, &files)?;
    if req.workspace.is_some() {
        events(Event::State(RunState::Syncing));
        let mkdir = session
            .execute(
                &format!("mkdir -p {}", sh_quote(remote)),
                None,
                Some(Duration::from_secs(10)),
                controls,
                |_| {},
                |_| {},
            )
            .await?;
        if mkdir.stopped == Some(StopReason::Timeout) {
            return Err(RunnerError::Serial(
                "workspace preparation timed out".into(),
            ));
        }
        if mkdir.stopped.is_some() {
            return Ok(mkdir.into());
        }
        if mkdir.code != 0 {
            return Err(RunnerError::Serial("cannot create remote workspace".into()));
        }
        for file in files {
            for command in file.commands(remote) {
                let result = session
                    .execute(
                        &command,
                        None,
                        Some(Duration::from_secs(30)),
                        controls,
                        |_| {},
                        |_| {},
                    )
                    .await?;
                if result.stopped == Some(StopReason::Timeout) {
                    return Err(RunnerError::Serial(format!(
                        "upload timed out: {}",
                        file.path()
                    )));
                }
                if result.stopped.is_some() {
                    return Ok(result.into());
                }
                if result.code != 0 {
                    return Err(RunnerError::Serial(format!(
                        "upload failed: {}",
                        file.path()
                    )));
                }
            }
        }
    }
    if req.workspace_context.is_some() {
        let (program, version) = if req.kind == ScriptKind::Python {
            let nonce = format!("RR_PROBE_{}", uuid::Uuid::new_v4().simple());
            let hashes = req
                .project_inputs
                .as_ref()
                .map(|i| i.serial_hashes.clone())
                .unwrap_or_default();
            let hashes = hashes
                .into_iter()
                .map(|(path, hash)| (format!("{remote}/{path}"), hash))
                .collect::<Vec<_>>();
            let encoded = serde_json::to_string(&hashes)
                .map_err(|e| RunnerError::InvalidInput(e.to_string()))?;
            let checks=format!("import os,hashlib;assert all((hashlib.sha256(os.fdopen(os.open(p,os.O_RDONLY|os.O_NOFOLLOW),'rb').read(1048577)).hexdigest() if os.path.exists(p) else 'missing')==h for p,h in {encoded}), 'Project inputs changed';");
            let code = format!("{checks}{}", crate::workspace_probe::payload(&nonce));
            let variables = req
                .env
                .iter()
                .map(|(k, v)| format!("export {k}={};", sh_quote(v)))
                .collect::<Vec<_>>()
                .join(" ");
            let cwd = if req.cwd == "." {
                remote.to_string()
            } else {
                format!("{remote}/{}", req.cwd)
            };
            let command = format!("cd {} || exit $?; {variables} __rr_python=$(command -v python3 || command -v python) && \"$__rr_python\" -c {}", sh_quote(&cwd), sh_quote(&code));
            let mut output = Vec::new();
            let result = session
                .execute(
                    &command,
                    None,
                    Some(Duration::from_secs(10)),
                    controls,
                    |bytes| {
                        output.extend(
                            bytes
                                .into_iter()
                                .take(65537_usize.saturating_sub(output.len())),
                        )
                    },
                    |_| {},
                )
                .await?;
            if result.stopped.is_some() {
                return Ok(result.into());
            }
            if result.code != 0 || output.len() > 65536 {
                return Err(RunnerError::Serial(
                    "Python or project input probe failed".into(),
                ));
            }
            let probe = crate::workspace_probe::parse(&output, &nonce, false)?;
            req.managed_env_python = Some(probe.program.clone());
            req.env.extend(probe.env);
            (probe.program, Some(probe.version))
        } else {
            let mut output = Vec::new();
            let result = session
                .execute(
                    "command -v bash",
                    None,
                    Some(Duration::from_secs(5)),
                    controls,
                    |bytes| {
                        output.extend(
                            bytes
                                .into_iter()
                                .take(8193_usize.saturating_sub(output.len())),
                        )
                    },
                    |_| {},
                )
                .await?;
            if result.stopped.is_some() {
                return Ok(result.into());
            }
            let path = String::from_utf8(output)
                .map_err(|_| RunnerError::Serial("Invalid Bash path".into()))?
                .trim()
                .to_string();
            if result.code != 0 || !path.starts_with('/') || path.len() > 8192 {
                return Err(RunnerError::Serial("Bash is unavailable".into()));
            }
            req.bash = Some(path.clone());
            (path, None)
        };
        events(Event::Launch(crate::workspace_run::Launch {
            program,
            version,
            cwd: if req.cwd == "." {
                remote.into()
            } else {
                format!("{remote}/{}", req.cwd)
            },
            python_path: req
                .managed_pythonpath
                .iter()
                .map(|p| format!("{remote}/{p}"))
                .collect(),
            environment: if req.kind == ScriptKind::Python {
                "device_default"
            } else {
                "bash"
            }
            .into(),
        }));
    }
    events(Event::State(RunState::Starting));
    if req.kind == ScriptKind::Command {
        events(Event::Launch(crate::workspace_run::Launch {
            program: "sh".into(),
            version: None,
            cwd: if req.workspace.is_some() {
                remote.into()
            } else {
                ".".into()
            },
            python_path: vec![],
            environment: "command".into(),
        }));
    }
    let command = build_script(req, remote);
    session
        .execute(
            &command,
            Some((req.cols, req.rows)),
            (req.timeout_secs > 0).then(|| Duration::from_secs(req.timeout_secs)),
            controls,
            |data| {
                events(Event::Output {
                    stream: OutputStream::Stdout,
                    data,
                })
            },
            |state| events(Event::State(state)),
        )
        .await
        .map(Into::into)
}
