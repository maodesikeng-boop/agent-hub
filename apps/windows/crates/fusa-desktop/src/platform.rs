use std::path::{Path, PathBuf};
#[cfg(not(target_os = "windows"))]
use std::process::{Command, Stdio};

use fusa_supervisor::NativeRuntimeConfig;
use url::Url;

/// 校验本地目录不为空且不位于 UNC 网络共享上（ACL、命名管道与 SQLite 锁要求本机卷）。
pub fn validate_local_dir(path: &Path) -> Result<(), String> {
    let s = path.to_string_lossy();
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return Err("目录路径不能为空".to_string());
    }
    if trimmed.starts_with(r"\\?\UNC\")
        || (trimmed.starts_with(r"\\") && !trimmed.starts_with(r"\\?\") && !trimmed.starts_with(r"\\.\"))
    {
        return Err(format!(
            "不支持将网络共享路径作为本地数据目录：{trimmed}"
        ));
    }
    Ok(())
}

/// 解析桌面外壳本地应用数据目录（Windows 下为 `%LOCALAPPDATA%\Fusa`）。
pub fn resolve_local_app_data_dir() -> Result<PathBuf, String> {
    if let Ok(override_dir) = std::env::var("FUSA_APP_DATA_DIR") {
        let p = PathBuf::from(override_dir.trim());
        if !p.as_os_str().is_empty() {
            validate_local_dir(&p)?;
            return Ok(p);
        }
    }

    #[cfg(target_os = "windows")]
    {
        let local_app_data = std::env::var_os("LOCALAPPDATA")
            .ok_or_else(|| "无法读取环境变量 LOCALAPPDATA".to_string())?;
        let dir = PathBuf::from(local_app_data).join("Fusa");
        validate_local_dir(&dir)?;
        return Ok(dir);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var_os("HOME")
            .ok_or_else(|| "无法读取环境变量 HOME".to_string())?;
        let dir = PathBuf::from(home).join(".local/share/fusa-desktop");
        validate_local_dir(&dir)?;
        Ok(dir)
    }
}

/// 将用户配置的 `AGENT_HUB_HOME` 按与 Node `src/shared/paths.ts` 一致的规则展开 `~` 并规范化末尾斜杠与相对路径。
pub fn normalize_hub_home_override(
    raw: &str,
    user_home: Option<&Path>,
    cwd: Option<&Path>,
) -> PathBuf {
    let trimmed = raw.trim();
    let expanded = if trimmed == "~" {
        user_home
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(trimmed))
    } else if let Some(rest) = trimmed
        .strip_prefix("~/")
        .or_else(|| trimmed.strip_prefix("~\\"))
    {
        match user_home {
            Some(home) => home.join(rest),
            None => PathBuf::from(trimmed),
        }
    } else {
        PathBuf::from(trimmed)
    };

    let exp_str = expanded.to_string_lossy();
    let bytes = exp_str.as_bytes();
    let is_win_drive_abs = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    let is_abs = expanded.is_absolute()
        || is_win_drive_abs
        || exp_str.starts_with("\\\\")
        || exp_str.starts_with('/');
    let resolved = if !is_abs {
        if let Some(base) = cwd {
            base.join(&expanded)
        } else {
            expanded
        }
    } else {
        expanded
    }
    .to_path_buf();

    let s = resolved.to_string_lossy();
    if s.len() > 3 && (s.ends_with('/') || s.ends_with('\\')) {
        let trimmed_sep = s.trim_end_matches(['/', '\\']);
        if trimmed_sep.len() == 2 && trimmed_sep.as_bytes()[1] == b':' {
            return PathBuf::from(format!("{trimmed_sep}\\"));
        }
        if trimmed_sep.is_empty() {
            return PathBuf::from("/");
        }
        return PathBuf::from(trimmed_sep);
    }
    resolved
}

/// 解析守护进程数据目录（优先 `AGENT_HUB_HOME`，默认 `%USERPROFILE%\.agent-hub` / `~/.agent-hub`）。
pub fn resolve_hub_home_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let base_home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    #[cfg(not(target_os = "windows"))]
    let base_home = std::env::var_os("HOME").map(PathBuf::from);

    if let Ok(override_home) = std::env::var("AGENT_HUB_HOME") {
        if !override_home.trim().is_empty() {
            let cwd = std::env::current_dir().ok();
            let p = normalize_hub_home_override(&override_home, base_home.as_deref(), cwd.as_deref());
            validate_local_dir(&p)?;
            return Ok(p);
        }
    }

    #[cfg(target_os = "windows")]
    {
        let profile = base_home
            .ok_or_else(|| "无法读取环境变量 USERPROFILE".to_string())?;
        let dir = PathBuf::from(profile).join(".agent-hub");
        validate_local_dir(&dir)?;
        return Ok(dir);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = base_home
            .ok_or_else(|| "无法读取环境变量 HOME".to_string())?;
        let dir = PathBuf::from(home).join(".agent-hub");
        validate_local_dir(&dir)?;
        Ok(dir)
    }
}

fn try_packaged_runtime_root(
    base: &Path,
    app_data_dir: &Path,
    hub_home_dir: &Path,
    extra_envs: &[(String, String)],
) -> Option<NativeRuntimeConfig> {
    let node_exe = {
        let win = base.join("node").join("node.exe");
        if win.is_file() {
            win
        } else {
            let unix = base.join("node").join("node");
            if unix.is_file() { unix } else { return None }
        }
    };
    let bin_dir = base.join("bin");
    let has_fusa_run = bin_dir.join("fusa-run.exe").is_file() || bin_dir.join("fusa-run").is_file();
    let has_hub = bin_dir.join("hub.exe").is_file() || bin_dir.join("hub").is_file();
    if !has_fusa_run || !has_hub {
        return None;
    }
    let daemon_dir = base.join("daemon");
    if !daemon_dir.join("src/daemon/main.ts").is_file() {
        return None;
    }
    let manifest_candidate = base.join("runtime-manifest.json");
    let manifest_path = manifest_candidate.is_file().then_some(manifest_candidate);
    Some(NativeRuntimeConfig {
        app_data_dir: app_data_dir.to_path_buf(),
        hub_home_dir: hub_home_dir.to_path_buf(),
        node_exe_path: node_exe,
        daemon_root_dir: daemon_dir,
        win_helpers_dir: bin_dir,
        manifest_path,
        extra_envs: extra_envs.to_vec(),
    })
}

fn find_system_node_binary() -> Option<PathBuf> {
    let path_os = std::env::var_os("PATH")?;
    let names: &[&str] = if cfg!(windows) {
        &["node.exe", "node"]
    } else {
        &["node"]
    };
    for dir in std::env::split_paths(&path_os) {
        for name in names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// 解析随包内置运行时目录（支持便携包、`FUSA_RUNTIME_DIR`、Tauri NSIS 安装目录以及源码开发回退）。
pub fn resolve_native_runtime_config(
    app_data_dir: PathBuf,
    hub_home_dir: PathBuf,
    resource_dir_hint: Option<&Path>,
    extra_envs: Vec<(String, String)>,
) -> Result<NativeRuntimeConfig, String> {
    let mut candidate_roots: Vec<PathBuf> = Vec::new();
    if let Ok(override_root) = std::env::var("FUSA_RUNTIME_DIR") {
        let p = PathBuf::from(override_root.trim());
        if !p.as_os_str().is_empty() {
            candidate_roots.push(p.clone());
            candidate_roots.push(p.join("resources"));
        }
    }
    if let Some(res_dir) = resource_dir_hint {
        candidate_roots.push(res_dir.to_path_buf());
        candidate_roots.push(res_dir.join("resources"));
        candidate_roots.push(res_dir.join("staged-runtime"));
    }
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidate_roots.push(exe_dir.to_path_buf());
            candidate_roots.push(exe_dir.join("resources"));
        }
    }

    for root in &candidate_roots {
        if let Some(cfg) = try_packaged_runtime_root(root, &app_data_dir, &hub_home_dir, &extra_envs)
        {
            return Ok(cfg);
        }
    }

    // 源码开发态回退（例如在仓库下直接执行 `cargo run -p fusa-desktop`）
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(repo_root) = manifest_dir
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .and_then(Path::parent)
    {
        if repo_root.join("src/daemon/main.ts").is_file() {
            if let Some(node_exe) = find_system_node_binary() {
                for profile in ["release", "debug"] {
                    let helper_dir = repo_root.join("apps/windows/target").join(profile);
                    let has_run = helper_dir.join("fusa-run.exe").is_file()
                        || helper_dir.join("fusa-run").is_file();
                    let has_hub =
                        helper_dir.join("hub.exe").is_file() || helper_dir.join("hub").is_file();
                    if has_run && has_hub {
                        return Ok(NativeRuntimeConfig {
                            app_data_dir,
                            hub_home_dir,
                            node_exe_path: node_exe,
                            daemon_root_dir: repo_root.to_path_buf(),
                            win_helpers_dir: helper_dir,
                            manifest_path: None,
                            extra_envs,
                        });
                    }
                }
            }
        }
    }

    Err(format!(
        "未找到随包 Windows 原生运行时（node/node.exe、bin/fusa-run.exe、bin/hub.exe、daemon/src/daemon/main.ts），已检查：{}",
        candidate_roots
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

#[cfg(target_os = "windows")]
mod win32_shell {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: isize,
            lp_operation: *const u16,
            lp_file: *const u16,
            lp_parameters: *const u16,
            lp_directory: *const u16,
            n_show_cmd: i32,
        ) -> isize;
    }

    const SW_SHOWNORMAL: i32 = 1;

    fn to_wide_null(s: &OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    pub fn shell_execute(
        operation: &str,
        file: &OsStr,
        parameters: Option<&OsStr>,
    ) -> Result<(), String> {
        let op_w = to_wide_null(OsStr::new(operation));
        let file_w = to_wide_null(file);
        let params_w = parameters.map(to_wide_null);
        let rc = unsafe {
            ShellExecuteW(
                0,
                op_w.as_ptr(),
                file_w.as_ptr(),
                params_w.as_ref().map_or(std::ptr::null(), |v| v.as_ptr()),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if rc > 32 {
            Ok(())
        } else {
            Err(format!("ShellExecuteW({operation}) 执行失败（返回码 {rc}）"))
        }
    }
}

/// 使用系统默认浏览器打开经过协议白名单校验的外部链接（严禁拼接 shell）。
pub fn open_external_url(url: &Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        return Err(format!("拒绝打开非安全协议链接：{}", url.scheme()));
    }

    #[cfg(target_os = "windows")]
    {
        return win32_shell::shell_execute("open", std::ffi::OsStr::new(url.as_str()), None);
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open")
            .arg(url.as_str())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(url.as_str())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

/// 打开宿主日志文件（若日志文件尚不存在则打开其所在目录）。
pub fn open_log_file_or_dir(log_path: &Path) -> Result<(), String> {
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let target = if log_path.exists() {
        log_path
    } else {
        log_path.parent().unwrap_or(log_path)
    };

    #[cfg(target_os = "windows")]
    {
        return win32_shell::shell_execute("open", target.as_os_str(), None);
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open")
            .arg(target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}
