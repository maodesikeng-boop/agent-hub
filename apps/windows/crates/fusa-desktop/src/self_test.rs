use std::fs;
use std::net::TcpListener;
use std::path::Path;
#[cfg(windows)]
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use fusa_supervisor::admin_named_pipe_path;
use fusa_supervisor::{
    refresh_current_process_path, DaemonHealthReport, DaemonOwnership, DaemonRuntime,
    DaemonSupervisor, DesktopContract, HostHttpClient, NativeDaemonRuntime, ProbeOutcome,
    SecretUiToken, SupervisorState, SystemClock, UreqHostHttpClient,
};

use crate::bootstrap::run_desktop_preflight_probe;
use crate::platform::resolve_native_runtime_config;

#[cfg(windows)]
fn is_windows_named_pipe_absent(pipe_path: &str) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_FILE_NOT_FOUND, GENERIC_READ, GENERIC_WRITE,
        INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{CreateFileW, OPEN_EXISTING};

    let wide: Vec<u16> = std::ffi::OsStr::new(pipe_path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let handle = CreateFileW(
            wide.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        );
        if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
            let _ = CloseHandle(handle);
            return false;
        }
        GetLastError() == ERROR_FILE_NOT_FOUND
    }
}

fn remove_dir_with_bounded_retry(dir: &Path) -> Result<(), String> {
    let delays_ms = [100u64, 250, 500, 1000];
    let mut last_err = None;
    for (attempt, delay) in std::iter::once(0u64).chain(delays_ms).enumerate() {
        if delay > 0 {
            std::thread::sleep(Duration::from_millis(delay));
        }
        match fs::remove_dir_all(dir) {
            Ok(()) => return Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(err) => {
                last_err = Some(format!("第 {} 次清理临时目录失败：{err}", attempt + 1));
            }
        }
    }
    Err(last_err.unwrap_or_else(|| "清理自检临时目录失败".to_string()))
}

/// 无窗口端到端自检（`fusa-desktop.exe --self-test`）。
pub fn run_headless_self_test() -> Result<String, String> {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let pid = std::process::id();
    let temp_root = std::env::temp_dir().join(format!("fusa-st-{pid}-{ts}"));
    let app_data_dir = temp_root.join("app");
    let hub_home_dir = temp_root.join("hub");
    fs::create_dir_all(&app_data_dir).map_err(|e| format!("创建临时 app 目录失败：{e}"))?;
    fs::create_dir_all(&hub_home_dir).map_err(|e| format!("创建临时 hub 目录失败：{e}"))?;

    let result = run_self_test_inner(&app_data_dir, &hub_home_dir);
    let cleanup_res = remove_dir_with_bounded_retry(&temp_root);
    match (result, cleanup_res) {
        (Ok(summary), Ok(())) => Ok(summary),
        (Err(err), _) => Err(err),
        (Ok(_), Err(clean_err)) => Err(format!(
            "守护进程关机后临时目录仍存在文件句柄锁残留：{clean_err}"
        )),
    }
}

fn run_self_test_inner(app_data_dir: &Path, hub_home_dir: &Path) -> Result<String, String> {
    refresh_current_process_path(&[]);

    let runtime_cfg = resolve_native_runtime_config(
        app_data_dir.to_path_buf(),
        hub_home_dir.to_path_buf(),
        None,
        Vec::new(),
    )?;

    let contract = DesktopContract::embedded().map_err(|e| e.to_string())?;
    let runtime = NativeDaemonRuntime::new(runtime_cfg.clone());
    runtime
        .verify_runtime_integrity()
        .map_err(|e| format!("运行时完整性校验失败：{e}"))?;

    #[cfg(windows)]
    {
        let fusa_run = runtime_cfg.fusa_run_path();
        let probe_state = hub_home_dir.join("state");
        fs::create_dir_all(&probe_state).map_err(|e| e.to_string())?;
        let out = Command::new(&fusa_run)
            .args(["probe", "--state-dir"])
            .arg(&probe_state)
            .output()
            .map_err(|e| format!("执行 fusa-run.exe probe 失败：{e}"))?;
        if !out.status.success() {
            return Err(format!(
                "fusa-run.exe probe 失败（{:?}）：{}",
                out.status.code(),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
    }

    let preflight = run_desktop_preflight_probe(&runtime_cfg)?;
    if preflight.vendors.is_empty() {
        return Err("desktop-preflight.ts 返回了空的厂商清单".to_string());
    }

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("分配空闲端口失败：{e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("读取空闲端口失败：{e}"))?
        .port();
    drop(listener);

    let supervisor = DaemonSupervisor::new(
        contract.clone(),
        port,
        app_data_dir,
        runtime,
        UreqHostHttpClient,
        SystemClock,
    )
    .map_err(|e| format!("初始化 DaemonSupervisor 失败：{e}"))?;

    let snap = match supervisor.ensure_running() {
        Ok(s) => s,
        Err(err) => {
            let log_tail = fs::read_to_string(supervisor.host_log_path()).unwrap_or_default();
            return Err(format!(
                "拉起原生守护进程失败：{err}\n--- desktop-daemon.log ---\n{log_tail}"
            ));
        }
    };

    let (instance_id, daemon_pid) = match &snap.state {
        SupervisorState::Running {
            ownership: DaemonOwnership::Owned,
            identity,
            pid,
            ..
        } => (identity.instance_id.clone(), *pid),
        other => {
            let _ = supervisor.shutdown();
            return Err(format!("守护进程未进入 Owned Running 状态：{other:?}"));
        }
    };

    let Some(session_cookie) = supervisor.session_cookie() else {
        let _ = supervisor.shutdown();
        return Err("守护进程就绪但未成功兑换 SessionCookie".to_string());
    };

    let verify_result = (|| -> Result<(), String> {
        let client = UreqHostHttpClient;
        let (unauth_status, _) = client
            .request_health(port, None, &contract, Duration::from_secs(3))
            .map_err(|e| format!("请求未鉴权 GET /api/health 失败：{e}"))?;
        if unauth_status != 401 {
            return Err(format!(
                "未携带 Cookie 的 GET /api/health 应返回 401，实际返回 {unauth_status}"
            ));
        }

        let wrong_token =
            SecretUiToken::new("wrong_self_test_token_0000000000").map_err(|e| e.to_string())?;
        if client
            .exchange_session_cookie(port, &wrong_token, Duration::from_secs(3))
            .is_ok()
        {
            return Err("错误 ui-token 请求 POST /auth 竟被接受".to_string());
        }

        let (ok_status, health_report) = client
            .request_health(
                port,
                Some(&session_cookie),
                &contract,
                Duration::from_secs(3),
            )
            .map_err(|e| format!("请求已鉴权 GET /api/health 失败：{e}"))?;
        if ok_status != 200 {
            return Err(format!(
                "携带合法 Cookie 的 GET /api/health 应返回 200，实际返回 {ok_status}"
            ));
        }
        let expected = DaemonHealthReport {
            ok: true,
            product: contract.product.clone(),
            protocol_version: contract.protocol_version,
            instance_id: instance_id.clone(),
        };
        if health_report.as_ref() != Some(&expected) {
            return Err(format!(
                "GET /api/health 响应内容不匹配：实际 {health_report:?}，期望 {expected:?}"
            ));
        }
        Ok(())
    })();

    let shutdown_started = Instant::now();
    let stop_snap = supervisor.shutdown();
    let shutdown_ms = shutdown_started.elapsed().as_millis();

    verify_result?;

    if stop_snap.state != SupervisorState::Stopped {
        return Err(format!("关机后状态应为 Stopped，实际为 {:?}", stop_snap.state));
    }
    if shutdown_ms >= 15_000 {
        return Err(format!(
            "守护进程优雅关机耗时过长（{shutdown_ms} ms），疑似未响应 admin 管道关机"
        ));
    }

    if let Some(pid) = daemon_pid {
        let wait_dead = Instant::now() + Duration::from_secs(3);
        while Instant::now() < wait_dead && NativeDaemonRuntime::is_pid_probably_alive(pid) {
            std::thread::sleep(Duration::from_millis(50));
        }
        if NativeDaemonRuntime::is_pid_probably_alive(pid) {
            return Err(format!("关机后守护进程 PID {pid} 仍然存活"));
        }
    }

    if matches!(
        UreqHostHttpClient.probe_status(port, &contract),
        ProbeOutcome::Verified(_)
    ) {
        return Err(format!("关机后端口 127.0.0.1:{port} 仍在响应"));
    }

    #[cfg(windows)]
    {
        let admin_pipe = admin_named_pipe_path(hub_home_dir);
        let pipe_deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < pipe_deadline && !is_windows_named_pipe_absent(&admin_pipe) {
            std::thread::sleep(Duration::from_millis(50));
        }
        if !is_windows_named_pipe_absent(&admin_pipe) {
            return Err(format!("关机后管理命名管道仍未释放：{admin_pipe}"));
        }
    }

    Ok(format!(
        "[fusa-self-test] PASS port={port} pid={daemon_pid:?} instance={instance_id} shutdownMs={shutdown_ms} vendors={}",
        preflight.vendors.len()
    ))
}
