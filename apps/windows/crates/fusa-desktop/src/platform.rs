use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use fusa_wsl::{build_interactive_login_cmd, validate_local_app_data_dir};
use url::Url;

/// 解析当前用户本地应用数据目录（Windows 下为 `%LOCALAPPDATA%\Fusa`，校验禁止 UNC 网络路径）。
pub fn resolve_local_app_data_dir() -> Result<PathBuf, String> {
    if let Ok(override_dir) = std::env::var("FUSA_APP_DATA_DIR") {
        let p = PathBuf::from(override_dir.trim());
        if !p.as_os_str().is_empty() {
            validate_local_app_data_dir(&p).map_err(|e| e.to_string())?;
            return Ok(p);
        }
    }

    #[cfg(target_os = "windows")]
    {
        let local_app_data = std::env::var_os("LOCALAPPDATA")
            .ok_or_else(|| "无法读取环境变量 LOCALAPPDATA".to_string())?;
        let dir = PathBuf::from(local_app_data).join("Fusa");
        validate_local_app_data_dir(&dir).map_err(|e| e.to_string())?;
        return Ok(dir);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var_os("HOME")
            .ok_or_else(|| "无法读取环境变量 HOME".to_string())?;
        let dir = PathBuf::from(home).join(".local/share/fusa-desktop");
        validate_local_app_data_dir(&dir).map_err(|e| e.to_string())?;
        Ok(dir)
    }
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
        // ShellExecuteW 返回值 > 32 表示成功拉起
        if rc > 32 {
            Ok(())
        } else {
            Err(format!("ShellExecuteW({operation}) 执行失败（返回码 {rc}）"))
        }
    }
}

/// 使用系统默认浏览器打开经过协议白名单校验的外部链接（绝不拼接 `cmd /c` 或 `sh -c`）。
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

/// 打开宿主日志文件（若日志文件尚不存在则打开其所在日志目录）。
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

/// 为用户一键拉起交互式终端 `wsl.exe --distribution Fusa --user fusa --cd ~`，供用户本人完成厂商 CLI 登录。
/// 优先通过 Windows Terminal（`wt.exe`）打开新标签页，回退至直接弹出 `wsl.exe` 交互控制台窗口。
pub fn spawn_interactive_wsl_terminal(distro_name: &str, linux_user: &str) -> Result<(), String> {
    let wsl_cmd =
        build_interactive_login_cmd(distro_name, linux_user).map_err(|e| e.to_string())?;

    #[cfg(target_os = "windows")]
    {
        if let Some(local_app) = std::env::var_os("LOCALAPPDATA") {
            let wt_path = PathBuf::from(local_app).join(r"Microsoft\WindowsApps\wt.exe");
            if wt_path.is_file() {
                let mut wt = Command::new(&wt_path);
                wt.arg("--").arg(&wsl_cmd.program).args(&wsl_cmd.args);
                wt.env_remove("WSLENV");
                if wt.spawn().is_ok() {
                    return Ok(());
                }
            }
        }

        // 回退：直接拉起可见控制台窗口运行 wsl.exe -d Fusa -u fusa --cd ~（此处刻意不传 CREATE_NO_WINDOW）
        let mut direct = Command::new(&wsl_cmd.program);
        direct.args(&wsl_cmd.args);
        direct.env_remove("WSLENV");
        return direct.spawn().map(|_| ()).map_err(|e| e.to_string());
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = wsl_cmd;
        Err("交互式 WSL 终端仅在 Windows 宿主上可用".to_string())
    }
}

/// 在用户点击“Install WSL”时通过 Windows UAC 提权执行 `wsl.exe --install --no-distribution`。
pub fn request_elevated_wsl_install() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        return win32_shell::shell_execute(
            "runas",
            std::ffi::OsStr::new("wsl.exe"),
            Some(std::ffi::OsStr::new("--install --no-distribution")),
        );
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("WSL 组件安装仅在 Windows 宿主上可用".to_string())
    }
}
