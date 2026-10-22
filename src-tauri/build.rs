fn main() {
    // Tauri watches its config, but the cached Windows resources must also
    // rebuild when an icon changes during an incremental build.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
