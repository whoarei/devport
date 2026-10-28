// Hide the Windows console in release builds; keep it for development logs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = devport::usb::elevated_entry(&std::env::args().collect::<Vec<_>>()) {
        std::process::exit(code);
    }
    devport::run();
}
