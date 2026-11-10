fn main() {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(&[
            "get_bootstrap_state",
            "install_wsl_component",
            "retry_bootstrap",
            "open_vendor_terminal",
            "open_logs",
            "enter_workspace",
        ]))
        .windows_attributes(
            tauri_build::WindowsAttributes::new().window_icon_path("icons/icon.ico"),
        );
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
