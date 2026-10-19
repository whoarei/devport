//! Bounded interpreter discovery in the selected shell's profile context.
mod process_tree;
#[cfg(test)]
mod tests;
use crate::{
    device::{DeviceProfile, TransportKind},
    error::{Result, RunnerError},
    runtime::host::RuntimeHost,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{atomic::AtomicBool, Arc},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Probe {
    pub program: String,
    pub version: String,
    pub env: BTreeMap<String, String>,
}
fn fail(message: impl Into<String>) -> RunnerError {
    RunnerError::InvalidInput(message.into())
}
struct ProbeScript(std::path::PathBuf);
impl ProbeScript {
    fn new(body: &str, powershell: bool) -> Result<Self> {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!(
            "remote-runner-python-probe-{}.{}",
            uuid::Uuid::new_v4(),
            if powershell { "ps1" } else { "sh" }
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path)?;
        let script = Self(path);
        // Windows PowerShell 5.1 needs a BOM for non-ASCII UTF-8 scripts.
        if powershell {
            file.write_all(b"\xef\xbb\xbf")?;
        }
        file.write_all(body.as_bytes())?;
        Ok(script)
    }
    fn argument(&self, posix: bool) -> String {
        let path = crate::verbatim::simplify(&self.0);
        #[cfg(windows)]
        if posix {
            return crate::local::to_msys_path(&path);
        }
        let _ = posix;
        path.to_string_lossy().into_owned()
    }
}
impl Drop for ProbeScript {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
pub(crate) fn payload(nonce: &str) -> String {
    format!("import sys,os,json,platform;print('\\x1e{nonce}'+json.dumps(dict(program=sys.executable,version=platform.python_version(),env={{k:os.environ[k] for k in ('PATH','VIRTUAL_ENV','PYTHONHOME') if k in os.environ}}))+'\\x1f')")
}
pub(crate) fn parse(output: &[u8], nonce: &str, local: bool) -> Result<Probe> {
    let output = String::from_utf8_lossy(output);
    let start = format!("\u{1e}{nonce}");
    let (_, tail) = output
        .rsplit_once(&start)
        .ok_or_else(|| fail("Python was not found in the device shell context"))?;
    let (json, _) = tail
        .split_once('\u{1f}')
        .ok_or_else(|| fail("Incomplete Python probe"))?;
    let probe: Probe =
        serde_json::from_str(json).map_err(|e| fail(format!("Invalid Python probe: {e}")))?;
    if probe.program.is_empty()
        || probe.program.contains(['\0', '\r', '\n'])
        || !if local {
            std::path::Path::new(&probe.program).is_absolute()
        } else {
            probe.program.starts_with('/')
        }
    {
        return Err(fail("Python did not report an absolute executable path"));
    }
    Ok(probe)
}
pub async fn serial_python(device: &DeviceProfile) -> Result<Probe> {
    let config = device
        .serial
        .as_ref()
        .ok_or_else(|| fail("Missing serial config"))?;
    let _lease = crate::serial::transport::PortLease::acquire(&config.port)?;
    let mut session = crate::serial::session::ShellSession::new(
        crate::serial::transport::open(config)?,
        config.baud_rate,
    );
    let (_tx, mut controls) = tokio::sync::mpsc::unbounded_channel();
    let nonce = format!("RR_PROBE_{}", uuid::Uuid::new_v4().simple());
    let command = format!(
        "__rr_python=$(command -v python3 || command -v python) && \"$__rr_python\" -c {}",
        crate::runner::sh_quote(&payload(&nonce))
    );
    let mut output = Vec::new();
    let result = session
        .execute(
            &command,
            None,
            Some(std::time::Duration::from_secs(10)),
            &mut controls,
            |bytes| {
                output.extend(
                    bytes
                        .into_iter()
                        .take(65537_usize.saturating_sub(output.len())),
                );
            },
            |_| {},
        )
        .await?;
    if result.code != 0 || result.stopped.is_some() || output.len() > 65536 {
        return Err(fail("Serial Python probe failed"));
    }
    parse(&output, &nonce, false)
}

pub async fn python(
    device: &DeviceProfile,
    config: &std::path::Path,
    host: Option<Arc<dyn RuntimeHost + Send + Sync>>,
    program: Option<&str>,
    env: &std::collections::HashMap<String, String>,
    cwd: Option<&str>,
    cancel: &AtomicBool,
) -> Result<Probe> {
    python_with_timeout(
        device,
        config,
        host,
        program,
        env,
        cwd,
        cancel,
        std::time::Duration::from_secs(15),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn python_with_timeout(
    device: &DeviceProfile,
    config: &std::path::Path,
    host: Option<Arc<dyn RuntimeHost + Send + Sync>>,
    program: Option<&str>,
    env: &std::collections::HashMap<String, String>,
    cwd: Option<&str>,
    cancel: &AtomicBool,
    timeout: std::time::Duration,
) -> Result<Probe> {
    let nonce = format!("RR_PROBE_{}", uuid::Uuid::new_v4().simple());
    let local = device.transport == TransportKind::Local;
    let code = if local {
        format!("import sys,os,json,platform;print('\\x1e{nonce}'+json.dumps(dict(program=sys.executable,version=platform.python_version(),env=dict(os.environ)))+'\\x1f')")
    } else {
        payload(&nonce)
    };
    let quote = crate::runner::sh_quote;
    let posix_program = program
        .map(quote)
        .unwrap_or_else(|| "\"$__rr_python\"".into());
    let lookup = if program.is_none() {
        "__rr_python=$(command -v python3 || command -v python) || exit 127; "
    } else {
        ""
    };
    let clean_home = if program.is_some() {
        "unset PYTHONHOME; "
    } else {
        ""
    };
    let script = format!(
        "{clean_home}{lookup}exec {posix_program} -c {}",
        quote(&code)
    );
    let output = if device.transport == TransportKind::Local {
        let shell = crate::local::shells::resolve(
            device
                .local
                .as_ref()
                .ok_or_else(|| fail("Missing local shell"))?,
        )?;
        let mut args = crate::local::profile_args(&shell);
        let mut script_file = None;
        // Profiles run first; explicit run variables take precedence over them.
        let exports = env
            .iter()
            .map(|(key, value)| {
                #[cfg(windows)]
                let key = key.to_ascii_uppercase();
                #[cfg(windows)]
                let value = if key.eq_ignore_ascii_case("PATH")
                    && (value.contains(';') || value.as_bytes().get(1) == Some(&b':'))
                {
                    std::env::split_paths(value)
                        .map(|path| crate::local::to_msys_path(&path))
                        .collect::<Vec<_>>()
                        .join(":")
                } else {
                    value.clone()
                };
                // MSYS opens shell files in text mode. Encode CR as a shell
                // expression so CRLF inside a literal value cannot become LF.
                let value = value
                    .split('\r')
                    .map(quote)
                    .collect::<Vec<_>>()
                    .join("\"$(printf '\\r')\"");
                format!("export {key}={value}; ")
            })
            .collect::<String>();
        match shell.flavor {
            crate::local::shells::Flavor::Posix => {
                if shell.login {
                    args.push("-l".into());
                }
                let file = ProbeScript::new(&format!("{exports}{script}"), false)?;
                args.push(file.argument(true));
                script_file = Some(file);
            }
            crate::local::shells::Flavor::PowerShell => {
                let executable = program
                    .map(|p| format!("'{}'", p.replace('\'', "''")))
                    .unwrap_or_else(|| "$rrPython.Source".into());
                let lookup = if program.is_none() {
                    "$rrPython = Get-Command python,python3 -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if (!$rrPython) { exit 127 }; "
                } else {
                    ""
                };
                // Windows PowerShell 5.1's .NET setter deletes empty values.
                // Use the native API before launching Python, including startup hooks.
                #[cfg(windows)]
                let empty_setter = if env.values().any(String::is_empty) {
                    format!(
                        "Add-Type -ErrorAction Stop -TypeDefinition 'using System.Runtime.InteropServices; public static class {nonce} {{ [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool SetEnvironmentVariableW(string name, string value); }}'; "
                    )
                } else {
                    String::new()
                };
                #[cfg(not(windows))]
                let empty_setter = String::new();
                let exports = env.iter().map(|(key, value)| {
                    let key = key.replace('\'', "''");
                    #[cfg(windows)]
                    if value.is_empty() {
                        return format!(
                            "if (![{nonce}]::SetEnvironmentVariableW('{key}', '')) {{ throw 'Cannot set an empty probe environment variable' }}; "
                        );
                    }
                    format!(
                        "[Environment]::SetEnvironmentVariable('{key}','{}','Process'); ",
                        value.replace('\'', "''")
                    )
                }).collect::<String>();
                let file = ProbeScript::new(
                    &format!(
                        "{empty_setter}{exports}{}{lookup}& {executable} -c '{}'",
                        if program.is_some() {
                            "Remove-Item Env:PYTHONHOME -ErrorAction SilentlyContinue; "
                        } else {
                            ""
                        },
                        code.replace('\'', "''")
                    ),
                    true,
                )?;
                // Keep the original -Command execution-policy semantics. Only
                // the controlled file path travels on the command line.
                args.extend([
                    "-Command".into(),
                    format!(
                        "& ([scriptblock]::Create([IO.File]::ReadAllText('{}')))",
                        file.argument(false).replace('\'', "''")
                    ),
                ]);
                script_file = Some(file);
            }
            crate::local::shells::Flavor::Cmd => {
                // The payload is ASCII and contains no cmd expansion characters.
                let executable = if program.is_some() {
                    "%REMOTE_RUNNER_PROBE_PYTHON%"
                } else {
                    "python"
                };
                args.extend([
                    "/D".into(),
                    "/S".into(),
                    "/C".into(),
                    format!("\"\"{executable}\" -c \"{code}\"\""),
                ]);
            }
        }
        use tokio::io::AsyncReadExt;
        let mut command = tokio::process::Command::new(&shell.path);
        #[cfg(windows)]
        if matches!(shell.flavor, crate::local::shells::Flavor::Cmd) {
            use std::os::windows::process::CommandExt;
            command.args(&args[..3]);
            command.as_std_mut().raw_arg(&args[3]);
            if let Some(program) = program {
                command.env("REMOTE_RUNNER_PROBE_PYTHON", program);
            }
        } else {
            command.args(args);
        }
        #[cfg(not(windows))]
        command.args(args);
        command
            .envs(env)
            .env("CHERE_INVOKING", "1")
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if program.is_some() {
            command.env("PYTHONHOME", "");
        }
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        let mut tree = process_tree::ProcessTree::new()?;
        tree.configure(&mut command);
        let mut child = command.spawn()?;
        if let Err(error) = tree.attach(&child) {
            let _ = child.kill().await;
            return Err(error.into());
        }
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let work = async {
            let mut out = Vec::new();
            let mut err = Vec::new();
            let a = async { stdout.take(1048577).read_to_end(&mut out).await };
            let b = async { stderr.take(65537).read_to_end(&mut err).await };
            tokio::try_join!(a, b, child.wait())?;
            if out.len() > 1048576 || err.len() > 65536 {
                return Err(fail("Python probe output too large"));
            }
            parse(&out, &nonce, true)
        };
        let result = tokio::select! {
            result=tokio::time::timeout(timeout,work)=>result.unwrap_or_else(|_|Err(fail("Python probe timed out"))),
            _=crate::runtime::host::cancelled(cancel) => Err(crate::runtime::host::canceled_error()),
        };
        let result = match result {
            Ok(probe) => {
                tree.complete()?;
                Ok(probe)
            }
            Err(error) => {
                let cleanup = tree.stop().await;
                if cleanup.is_err() {
                    let _ = child.kill().await;
                }
                let reaped = child.wait().await;
                cleanup?;
                reaped?;
                Err(error)
            }
        };
        drop(script_file);
        return result;
    } else {
        let host = match host {
            Some(host) => host,
            None => crate::runtime::manage::open_host(device, config).await?,
        };
        let variables = env
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect::<Vec<_>>();
        let result = host
            .exec(
                &["/bin/sh".into(), "-lc".into(), script],
                &variables,
                cwd,
                None,
                cancel,
            )
            .await?;
        if result.stdout.len() > 65536 {
            return Err(fail("Python probe output too large"));
        }
        result.stdout
    };
    parse(&output, &nonce, device.transport == TransportKind::Local)
}
