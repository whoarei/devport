# Windows installation migration

DevPort 1.0 uses Tauri's default NSIS template with `migration.nsh` hooks.
The CLI is pinned to 2.11.4; review and smoke-test hooks when upgrading it.

The pre-install hook recognizes the published current-user Remote Runner registry
identity only when the install directory, quoted uninstall command and main binary
agree. It closes the old app through the standard NSIS process check and invokes
the old uninstaller with `/S /UPDATE`, which retains data and lets the post-install
hook migrate owned shortcuts and autostart. New installs use `DevPort`, `devport.exe`
and `com.devport.app`. Unknown files in an old install directory are never removed
recursively. Explicit user install-directory choices remain respected.

Before the WebView starts, Rust imports configuration and the WebView2 Local Storage
to the new app directories. Existing new directories win; originals remain backups.
The old `runtime-v1` cache is excluded: uv creates Python alias junctions, and venv
scripts/manifests contain absolute paths. Managed environments are prepared again
under the new root when needed. Portable `uv-assets` downloads are still imported.
Other user-data links are rejected with their path, and only busy-storage errors
advise closing the old process.
The frontend imports legacy preference keys before its other modules initialize.
Windows autostart approval state is carried forward without enabling disabled items.
The signing public key remains unchanged. New and legacy clients use separate
updater manifests, described in `docs/00008-development-and-release.md`.

Build and run the isolated install/upgrade/uninstall check:

```powershell
npm run tauri -- build --bundles nsis --no-sign -- --locked
./scripts/test-installer-migration.ps1
```

The smoke test namespaces registry values and shortcut names with a fresh UUID,
installs only into its artifact directory, and never launches the app or modifies
real application data. Test definitions override legacy identifiers only in the
fixture, including process names, so it cannot close a user's running application.
CI runs this check before publishing. Artifacts remain for audit; fixture registry
entries and links are cleaned. This is not a real-user-profile migration test.

The post-install hook registers current-user Explorer verbs for directories and
directory backgrounds under `Software\Classes`: “使用 DevPort 打开” on Chinese
Windows, “Open with DevPort” otherwise. Windows 11 exposes these classic verbs in
“Show more options”. Both invoke the quoted executable with
`--open-workspace "<directory>\."`; the dot protects trailing backslashes at drive
roots. Relaunches forward the request to the existing instance, which waits for
work-environment recovery and uses the normal unsaved-file guard. Only directories
accepted by the Rust workspace validator can be opened. Portable builds support
the argument but do not register Explorer menus automatically.

Install/update rewrites both verbs to the current installation. Uninstall removes
only verbs whose complete command still matches that installation. The smoke test
redirects all menu keys below its UUID namespace, validates commands, icons, update
reinstallation and cleanup, and checks that another installation's verb is kept.
