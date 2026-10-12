// Hide the Windows console in release builds; keep it for development logs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = remote_runner::usb::elevated_entry(&std::env::args().collect::<Vec<_>>()) {
        std::process::exit(code);
    }
    remote_runner::run();
}
