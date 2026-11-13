#[cfg(not(target_os = "windows"))]
fn ensure_cross_check_rc_fallback() {
    use std::env;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::process::Command;

    let target = env::var("TARGET").unwrap_or_default();
    if !target.contains("windows") {
        return;
    }
    let target_rc_key = format!("RC_{}", target.replace('-', "_"));
    if env::var_os("RC").is_some()
        || env::var_os(format!("RC_{target}")).is_some()
        || env::var_os(&target_rc_key).is_some()
    {
        return;
    }
    if Command::new("llvm-rc").arg("/?").output().is_ok() {
        return;
    }
    let Ok(out_dir) = env::var("OUT_DIR") else {
        return;
    };
    let stub_path = PathBuf::from(out_dir).join("fusa-cross-check-windres-stub.sh");
    let script = concat!(
        "#!/bin/sh\n",
        "if [ \"$1\" = \"-V\" ]; then echo \"GNU windres (cross-check stub)\"; exit 0; fi\n",
        "while [ \"$#\" -gt 0 ]; do\n",
        "  if [ \"$1\" = \"--output\" ] && [ -n \"$2\" ]; then : > \"$2\"; exit 0; fi\n",
        "  shift\n",
        "done\n",
        "exit 0\n",
    );
    if fs::write(&stub_path, script).is_ok() {
        let _ = fs::set_permissions(&stub_path, fs::Permissions::from_mode(0o755));
        env::set_var("RC", &stub_path);
    }
}

fn main() {
    #[cfg(not(target_os = "windows"))]
    ensure_cross_check_rc_fallback();

    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(&[
            "get_bootstrap_state",
            "retry_bootstrap",
            "open_logs",
        ]))
        .windows_attributes(
            tauri_build::WindowsAttributes::new().window_icon_path("icons/icon.ico"),
        );
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
