pub mod commands;
pub mod device;
pub mod error;
pub mod events;
pub mod local;
pub mod process;
pub mod remote_workspace;
pub mod runner;
pub mod runtime;
pub mod serial;
pub mod ssh;
pub mod terminal;
pub mod tray;
pub mod update;
pub mod usb;
pub mod verbatim;
pub mod workspace;
pub mod workspace_ref;
pub mod workspace_upload;
pub mod wsl;

use commands::AppState;
use device::DeviceStore;
use runner::RunManager;
use tauri::Manager;

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    tauri::Builder::default()
        // Single instance must be registered first: a second launch exits
        // immediately and its callback runs in the already-running instance.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // An autostart relaunch (`--minimized`) must not pop the window;
            // a manual launch activates the existing main window instead.
            if !tray::start_minimized(&args) {
                tray::show_main_window(app);
            }
        }))
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args(["--minimized"])
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(update::UpdateState::default())
        .setup(|app| {
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| dirs::config_dir().unwrap_or_default().join("remote-runner"));
            std::fs::create_dir_all(&config_dir).ok();
            tracing::info!("config dir: {}", config_dir.display());

            let (event_tx, event_rx) = events::channel();

            // RunManager 与管理命令共享同一个 Environment LeaseSet（00027 §16）
            let leases = std::sync::Arc::new(crate::runtime::manager::LeaseSet::default());
            let mut run_manager = RunManager::new(&config_dir, event_tx);
            run_manager.attach_leases(leases.clone());

            let state = AppState {
                terminal_manager: terminal::TerminalManager::default(),
                run_manager,
                device_store: DeviceStore::new(&config_dir),
                config_dir,
                event_rx: parking_lot::Mutex::new(event_rx),
                leases,
                workspace_sessions: remote_workspace::SessionStore::default(),
            };
            app.manage(state);

            tray::setup(app)?;

            // Windows are created hidden; only a manual launch reveals the main
            // window. Autostart launches carry `--minimized` and stay in the tray.
            if let Some(window) = app.get_webview_window(tray::MAIN_WINDOW_LABEL) {
                if !tray::start_minimized(&std::env::args().collect::<Vec<_>>()) {
                    window.show()?;
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_devices,
            commands::save_device,
            commands::delete_device,
            commands::test_device,
            commands::list_serial_ports,
            commands::list_wsl_distributions,
            commands::usb_snapshot,
            commands::usb_connect,
            commands::usb_disconnect,
            commands::usb_unshare,
            commands::usb_verify,
            commands::list_local_shells,
            commands::list_workspace_dir,
            commands::read_workspace_file,
            commands::write_workspace_file,
            commands::create_workspace_entry,
            commands::rename_workspace_entry,
            commands::delete_workspace_entry,
            commands::generate_workspace_config,
            commands::close_workspace_session,
            commands::run_script,
            commands::stop_run,
            commands::send_run_input,
            commands::resize_run_console,
            commands::get_run_status,
            commands::list_running_runs,
            commands::get_run_history,
            commands::export_run_record,
            commands::export_run_output,
            commands::clear_run_history,
            commands::drain_run_events,
            commands::inspect_python_project,
            commands::list_managed_runtimes,
            commands::list_project_environments,
            commands::rebuild_project_environment,
            commands::delete_project_environment,
            commands::clean_runtime_cache,
            commands::open_terminal,
            commands::open_workspace_terminal,
            commands::read_terminal,
            commands::send_terminal_input,
            commands::resize_terminal,
            commands::close_terminal,
            commands::close_all_terminals,
            update::check_app_update,
            update::install_app_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
