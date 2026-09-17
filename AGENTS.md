# Remote Runner agent guide

## Project scope

Remote Runner is a Tauri desktop application for running Python, Shell, and command workloads on remote devices. Any device reachable through one of the supported transports (SSH, serial, etc.) can be used — it is not limited to embedded Linux devices; Linux servers, dev boards, VMs, and local WSL distributions all work. The frontend is React/TypeScript; the backend is Rust with Tokio.

The supported transports are:

- **SSH**: SFTP workspace upload, PTY or pipe execution, interactive input, resize, stop escalation, and run history.
- **Serial Shell V1**: `tokio-serial`, 8N1, shell marker framing, UTF-8 text workspace upload, stdin, Ctrl+C, and timeout handling. It assumes the device is already logged into a Linux shell; it does not automate login credentials.
- **WSL**: Windows `wsl.exe` directly starts a bundled Python helper in a selected local distribution, without SSH. Supports binary workspace snapshots, Linux PTY or separate pipes, stdin, resize, process-group stop escalation, and history. Requires Python 3.8+ inside the distribution.
- **Local Shell**: runs workloads directly on this machine with a detected shell (Windows: pwsh, powershell, cmd, msys2, Git Bash; macOS/Linux: bash, zsh, sh), no SSH or helper. The workspace runs **in place** (no upload/copy; artifacts land in the workspace). PTY via `portable-pty` (ConPTY/openpty) or separate pipes, stdin, resize, and INT → TERM → KILL stop escalation (Windows pipe mode has no graceful interrupt; kills use `taskkill /T /F`). ConPTY startup requires the backend reader thread to answer the `\x1b[6n` DSR query itself. See `docs/00023_20260913_local-shell.md` and `docs/00024_20260913_local-shell-implementation.md`.

The workspace itself has two sources (`WorkspaceRef`): a local directory, or a directory on an SSH/WSL device. A device workspace is browsed and edited over SFTP (SSH) or the WSL helper's `fs_*` file-service messages; running **on that same device** happens in place (no copy), while running **on any other device** first stages the workspace into a local temp directory and then reuses the existing upload pipeline. Serial cannot host a workspace (no file-operation channel) but remains a valid cross-device run target. See `docs/00029_20260917_remote-workspace.md`.

There is no hardware available in the development environment. Serial behavior is verified with Tokio duplex streams and a local POSIX/Git Bash shell.

## Repository map

- `src/`: React UI, API bindings, Zustand state, and xterm console.
- `src/panels/`: panel registry (`registry.tsx` metadata + `components.ts` lazy component map). Sidebar and center-area panels are registered here; adding a panel = one registry entry + one component map entry (design: `docs/00022_20260913_modular-layout.md`).
- `src/i18n/`: frontend i18n (`i18next` + `react-i18next`, zh/en, inline resources; design: `docs/00020_20260913_i18n.md`). `zh.ts` is the key source of truth; `en.ts` is type-constrained to the same keys. UI strings must go through `t()` — components use `useTranslation()`, logic modules import the `i18n` instance directly. Language follows the persisted preference (`zh` / `en` / `system`, default `system` = system locale), switchable via View → Language.
- `tests/`: frontend tests, bundled by esbuild and run via `node --test`.
- `src-tauri/src/runner.rs`: request validation, run lifecycle, status/history, per-run output log persistence (`run_logs/`, 2 MiB cap, pruned with history), and transport dispatch.
- `src-tauri/src/ssh/`: SSH client, SFTP synchronization, and SSH process sessions.
- `src-tauri/src/serial/`: serial port leasing, shell framing, session control, and text workspace upload.
- `src-tauri/src/wsl/`: direct WSL process bridge, bounded workspace snapshots, Python helper, and opt-in WSL integration tests.
- `src-tauri/src/local/`: local shell registry and detection, portable-pty/pipe session layer with thread-based IO, per-flavor argv construction (posix/powershell/cmd), stop escalation, and real local-process integration tests (shells auto-skip when missing).
- `src-tauri/src/workspace_ref.rs`: `WorkspaceRef` (local directory vs. device directory), device path validation, and workspace-host capability.
- `src-tauri/src/remote_workspace/`: device workspace access — SFTP (`ssh.rs`), WSL helper file service (`wsl.rs`), the single-slot long-lived editing session (`SessionStore` in `mod.rs`), and cross-device staging into a local temp directory (`stage.rs`).
- `src-tauri/src/process.rs`: transport-independent console and session control types.
- `src-tauri/src/tray.rs`: system tray icon/menu, close-to-tray semantics, and autostart (`tauri-plugin-autostart`, `--minimized` silent launch; design: `docs/00018_20260912_tray-autostart.md`). Single instance is enforced via `tauri-plugin-single-instance` (registered first in `lib.rs`; a manual relaunch focuses the existing window, `--minimized` relaunches exit silently; design: `docs/00019_20260912_single-instance.md`).
- `src-tauri/src/update.rs`: app self-update — update check against the GitHub `latest.json` manifest, Tauri updater install with minisign verification, installed-vs-portable detection with manual-download fallback (design: `docs/00011_20260912_app-upgrade.md`).
- `docs/`: design, implementation progress, review notes, and serial-shell behavior.
- `scripts/test.mjs`: frontend tests.

## Development commands

Run from the repository root unless noted otherwise:

```powershell
npm install
npm test
npm run build
```

Rust formatting and tests:

```powershell
cd src-tauri
cargo fmt --all -- --check
cargo test --offline --all-targets
```

Start the Tauri application with:

```powershell
npm run tauri dev
```

The `rr-cli` binary is an SSH-only smoke-test tool. It is useful only when an accessible SSH device is available; do not add a hardware dependency to the normal test suite.

WSL integration tests are opt-in and skipped by default. From `src-tauri`:

```powershell
$env:REMOTE_RUNNER_TEST_WSL = 'Ubuntu-24.04' # actual installed distribution name
cargo test --offline --lib wsl::tests -- --include-ignored
```

## Implementation rules

- Do not use Computer Use for this project. Verify changes with code inspection, automated tests, and command-line tools.
- Validate all device and run input at the Rust boundary. Do not rely on frontend validation for safety or path containment.
- Preserve raw output bytes through the backend event boundary. Output events are base64 encoded before reaching the frontend.
- Keep SSH and serial control semantics aligned at the `RunManager` level, while keeping transport-specific protocol code in its own module.
- Serial shell completion must use the nonce marker protocol. Shell prompts, command echo, EOF, or a disconnected port are not successful completion signals.
- Serial V1 uploads UTF-8 text only. Preserve the existing limits and reject symlinks, special files, redirected paths, NUL bytes, and oversized workspaces.
- A serial port is leased before opening and must be released on every success and failure path. Serial uses one combined output stream and cannot resize after launch.
- Do not add tests that require a physical serial device. Extend the duplex-stream simulator and local-shell smoke tests instead.
- Keep documentation in `docs/` synchronized when transport behavior, limits, or unsupported capabilities change.
- WSL must use structured process arguments and a separate control protocol; never interpolate distribution names, users, file contents, or paths into shell commands. Only an explicit helper exit message confirms completion; EOF is a failure. Do not terminate a whole WSL distribution to stop a run.
- Never put the WSL helper source on the command line: Windows caps command lines at 32767 characters, so a growing helper makes `CreateProcess` fail with `os error 206` (surfacing as a bogus "no distribution installed"). The helper is delivered base64-encoded on stdin before the handshake; keep the bootstrap tiny, and keep the regression test that pins the command-line length.
- A device workspace must never escape its canonical root: reject symlinks below the root (SSH: per-component `symlink_metadata`; WSL: dirfd + `O_NOFOLLOW` inside the helper) and validate every relative path component at the Rust boundary. Device workspace paths must be absolute and free of `.` / `..` components.
- The workspace editing session is one long-lived connection, invalidated on connection errors; runs never share it. Cross-device staging must mirror the SSH upload limits (64 MiB per file, 256 MiB total, 4096 entries, skip symlinks and `.git`) and must remove its temp directory on every exit path.

## Change verification

Before handing off a change, run the relevant Rust tests and frontend tests/build. For serial or runner changes, run the full commands above and check the working tree with `git diff --check`. Report any unavailable hardware validation explicitly.
