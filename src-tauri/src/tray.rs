//! System tray icon/menu and autostart-aware launch handling.
//!
//! The tray owns window visibility; real quitting always goes through the
//! frontend guard flow (`tray://quit-requested`) so unsaved documents and
//! terminal sessions are confirmed and torn down exactly like a window close.
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Listener, Manager};
use tauri_plugin_autostart::ManagerExt;

pub const MAIN_WINDOW_LABEL: &str = "main";
pub const TRAY_QUIT_EVENT: &str = "tray://quit-requested";
pub const AUTOSTART_CHANGED_EVENT: &str = "autostart-changed";

const MENU_SHOW: &str = "tray-show";
const MENU_AUTOSTART: &str = "tray-autostart";
const MENU_QUIT: &str = "tray-quit";

/// True when the process was launched by the autostart entry, which carries
/// the `--minimized` argument to stay hidden in the tray.
pub fn start_minimized(args: &[String]) -> bool {
    args.iter().skip(1).any(|arg| arg == "--minimized")
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id(MENU_SHOW, "显示主窗口").build(app)?;
    let autostart = CheckMenuItemBuilder::with_id(MENU_AUTOSTART, "开机自启动")
        .checked(app.autolaunch().is_enabled().unwrap_or(false))
        .build(app)?;
    let quit = MenuItemBuilder::with_id(MENU_QUIT, "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&show)
        .item(&autostart)
        .separator()
        .item(&quit)
        .build()?;

    let autostart_item = autostart.clone();
    TrayIconBuilder::with_id("main")
        // Embed the small icon directly, rather than resampling a bundle-sized image.
        .icon(tauri::include_image!("icons/32x32.png"))
        .tooltip("DevPort")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            MENU_SHOW => show_main_window(app),
            MENU_AUTOSTART => {
                let launcher = app.autolaunch();
                let enabled = launcher.is_enabled().unwrap_or(false);
                let result = if enabled {
                    launcher.disable()
                } else {
                    launcher.enable()
                };
                match result {
                    Ok(()) => {
                        let _ = autostart_item.set_checked(!enabled);
                    }
                    Err(error) => {
                        tracing::warn!("toggle autostart failed: {error}");
                        let _ = autostart_item.set_checked(enabled);
                    }
                }
            }
            MENU_QUIT => {
                if let Err(error) = app.emit(TRAY_QUIT_EVENT, ()) {
                    tracing::warn!("emit quit request failed: {error}");
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    let autostart_item = autostart.clone();
    app.listen(AUTOSTART_CHANGED_EVENT, move |event| {
        if let Ok(enabled) = serde_json::from_str::<bool>(event.payload()) {
            let _ = autostart_item.set_checked(enabled);
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::start_minimized;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn detects_minimized_flag() {
        assert!(start_minimized(&args(&[
            "remote-runner.exe",
            "--minimized"
        ])));
    }

    #[test]
    fn normal_launch_is_not_minimized() {
        assert!(!start_minimized(&args(&["remote-runner.exe"])));
        assert!(!start_minimized(&args(&[])));
    }

    #[test]
    fn ignores_similar_arguments() {
        assert!(!start_minimized(&args(&[
            "remote-runner.exe",
            "--minimizedx",
            "--MINIMIZED"
        ])));
    }
}
