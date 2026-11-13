use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fusa_win_helper::pipe_http::{format_http_post, read_http_response};
use serde::{Deserialize, Serialize};

use crate::contract::DesktopContract;
use crate::env_path::build_refreshed_path_env;
use crate::error::SupervisorError;
use crate::log::{RotatingLogWriter, StderrTailCollector};
#[cfg(windows)]
use crate::manifest::admin_named_pipe_path;
use crate::manifest::{compute_file_sha256_hex, RuntimeManifest};
use crate::probe::{
    DaemonIdentity, HostHttpClient, ProbeOutcome, SecretUiToken, SessionCookie, UreqHostHttpClient,
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 可注入时钟抽象（生产环境使用系统真实墙钟，单测可注入虚拟时钟毫秒级推演 40s 停机预算与 60s 崩溃窗口）。
pub trait Clock: Send + Sync + 'static {
    fn now_epoch_ms(&self) -> u64;
    fn sleep(&self, duration: Duration);
}

/// 真实系统时钟。
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_epoch_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn sleep(&self, duration: Duration) {
        thread::sleep(duration);
    }
}

/// 发往自有守护进程的受控停机动作：优雅 `Term`（经 admin 命名管道 `POST /admin/shutdown`）与超时后的 `Kill`（Job + 进程终止）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum OwnedSignal {
    Term,
    Kill,
}

/// 自有原生守护进程存活状态快照。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnedProcessStatus {
    pub found: bool,
    pub alive: bool,
    pub pid: Option<u32>,
}

impl OwnedProcessStatus {
    pub fn dead() -> Self {
        Self {
            found: false,
            alive: false,
            pid: None,
        }
    }

    pub fn any_alive(&self) -> bool {
        self.alive
    }
}

/// 自有守护进程子进程与关联 Job Object 生命周期句柄抽象。
pub trait OwnedProcessHandle: Send {
    fn try_reap(&mut self) -> Option<i32>;
    fn cleanup_owned_resources(&mut self);
}

struct NativeOwnedSlot {
    pid: u32,
    child: Arc<Mutex<Option<Child>>>,
    exit_code: Arc<Mutex<Option<Option<i32>>>>,
    #[cfg(windows)]
    job: Arc<Mutex<Option<fusa_win_helper::win::job::SessionJob>>>,
}

struct StdOwnedProcessHandle {
    run_id: String,
    slots: Arc<Mutex<HashMap<String, NativeOwnedSlot>>>,
    child: Arc<Mutex<Option<Child>>>,
    exit_code: Arc<Mutex<Option<Option<i32>>>>,
    #[cfg(windows)]
    job: Arc<Mutex<Option<fusa_win_helper::win::job::SessionJob>>>,
}

impl OwnedProcessHandle for StdOwnedProcessHandle {
    fn try_reap(&mut self) -> Option<i32> {
        if let Some(done) = *self.exit_code.lock().unwrap() {
            return Some(done.unwrap_or(-1));
        }
        let mut guard = self.child.lock().unwrap();
        let child = guard.as_mut()?;
        match child.try_wait() {
            Ok(Some(status)) => {
                let code = status.code();
                *guard = None;
                *self.exit_code.lock().unwrap() = Some(code);
                Some(code.unwrap_or(-1))
            }
            _ => None,
        }
    }

    fn cleanup_owned_resources(&mut self) {
        #[cfg(windows)]
        {
            if let Some(job) = self.job.lock().unwrap().take() {
                job.terminate(1);
            }
        }
        if let Some(mut child) = self.child.lock().unwrap().take() {
            match child.try_wait() {
                Ok(Some(_)) => {}
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
        self.slots.lock().unwrap().remove(&self.run_id);
    }
}

pub(crate) fn drain_stdout(
    mut reader: impl Read,
    log: &Mutex<RotatingLogWriter>,
) -> std::io::Result<()> {
    let mut buf = [0u8; 4096];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            return Ok(());
        }
        if let Ok(mut w) = log.lock() {
            let _ = w.write_chunk(&buf[..n]);
        }
    }
}

#[cfg(windows)]
fn process_exit_waiter(child: &Child) -> std::io::Result<impl FnOnce() + Send> {
    use std::os::windows::io::{AsHandle, AsRawHandle};
    let handle = child.as_handle().try_clone_to_owned()?;
    Ok(move || {
        #[link(name = "kernel32")]
        extern "system" {
            fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
        }
        unsafe {
            WaitForSingleObject(handle.as_raw_handle(), u32::MAX);
        }
    })
}

/// 原生守护进程运行时抽象。
pub trait DaemonRuntime: Send + Sync + 'static {
    fn verify_runtime_integrity(&self) -> Result<(), SupervisorError>;
    fn matches_local_hub_home(&self, identity: &DaemonIdentity) -> bool;
    fn spawn_owned_daemon(
        &self,
        run_id: &str,
        port: u16,
        contract: &DesktopContract,
        log_writer: Arc<Mutex<RotatingLogWriter>>,
        stderr_tail: Arc<Mutex<StderrTailCollector>>,
        on_process_exit: Box<dyn FnOnce(Option<i32>) + Send + 'static>,
    ) -> Result<Box<dyn OwnedProcessHandle>, SupervisorError>;
    fn query_owned_status(&self, run_id: &str) -> Result<OwnedProcessStatus, SupervisorError>;
    fn signal_owned_daemon(
        &self,
        run_id: &str,
        signal: OwnedSignal,
        contract: &DesktopContract,
    ) -> Result<bool, SupervisorError>;
    fn read_ui_token(&self) -> Result<SecretUiToken, SupervisorError>;
}

/// Windows 原生守护进程运行时配置。
#[derive(Debug, Clone)]
pub struct NativeRuntimeConfig {
    pub app_data_dir: PathBuf,
    pub hub_home_dir: PathBuf,
    pub node_exe_path: PathBuf,
    pub daemon_root_dir: PathBuf,
    pub win_helpers_dir: PathBuf,
    pub manifest_path: Option<PathBuf>,
    pub extra_envs: Vec<(String, String)>,
}

impl NativeRuntimeConfig {
    pub fn fusa_run_path(&self) -> PathBuf {
        let exe = self.win_helpers_dir.join("fusa-run.exe");
        if exe.is_file() || cfg!(windows) {
            exe
        } else {
            let plain = self.win_helpers_dir.join("fusa-run");
            if plain.is_file() { plain } else { exe }
        }
    }

    pub fn hub_bin_path(&self) -> PathBuf {
        let exe = self.win_helpers_dir.join("hub.exe");
        if exe.is_file() || cfg!(windows) {
            exe
        } else {
            let plain = self.win_helpers_dir.join("hub");
            if plain.is_file() { plain } else { exe }
        }
    }
}

#[derive(Clone)]
struct CachedFileDigest {
    len: u64,
    modified: Option<SystemTime>,
    sha256: String,
}

/// 直接监管本机随包 `node.exe` 的 Windows 原生运行时实现。
pub struct NativeDaemonRuntime {
    config: NativeRuntimeConfig,
    slots: Arc<Mutex<HashMap<String, NativeOwnedSlot>>>,
    digest_cache: Mutex<HashMap<PathBuf, CachedFileDigest>>,
}

impl NativeDaemonRuntime {
    pub fn new(config: NativeRuntimeConfig) -> Self {
        Self {
            config,
            slots: Arc::new(Mutex::new(HashMap::new())),
            digest_cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn config(&self) -> &NativeRuntimeConfig {
        &self.config
    }

    fn verify_single_file_sha256(
        &self,
        label: &str,
        path: &Path,
        expected_hex: &str,
    ) -> Result<(), SupervisorError> {
        let meta = fs::metadata(path).map_err(|source| SupervisorError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        if !meta.is_file() {
            return Err(SupervisorError::RuntimeIntegrityFailed(format!(
                "{label} 不是普通文件：{}",
                path.display()
            )));
        }
        let len = meta.len();
        let modified = meta.modified().ok();
        if let Some(cached) = self.digest_cache.lock().unwrap().get(path).cloned() {
            if cached.len == len && cached.modified == modified {
                if cached.sha256.eq_ignore_ascii_case(expected_hex) {
                    return Ok(());
                }
                return Err(SupervisorError::RuntimeIntegrityFailed(format!(
                    "{label} SHA-256 校验不匹配（期望 {expected_hex}，实际 {}）",
                    cached.sha256
                )));
            }
        }

        let actual = compute_file_sha256_hex(path)?;
        self.digest_cache.lock().unwrap().insert(
            path.to_path_buf(),
            CachedFileDigest {
                len,
                modified,
                sha256: actual.clone(),
            },
        );
        if !actual.eq_ignore_ascii_case(expected_hex) {
            return Err(SupervisorError::RuntimeIntegrityFailed(format!(
                "{label} SHA-256 校验不匹配（期望 {expected_hex}，实际 {actual}）"
            )));
        }
        Ok(())
    }

    fn send_admin_shutdown(&self, shutdown_path: &str, token: &str) -> bool {
        let Ok(wire) = format_http_post(shutdown_path, token, b"{}") else {
            return false;
        };

        #[cfg(windows)]
        {
            use std::io::Write as _;
            let pipe_path = admin_named_pipe_path(&self.config.hub_home_dir);
            let Ok(mut stream) = fusa_win_helper::win::pipe::connect_named_pipe(
                &pipe_path,
                Duration::from_millis(800),
                Duration::from_secs(5),
            ) else {
                return false;
            };
            if stream.write_all(&wire).is_err() || stream.flush().is_err() {
                return false;
            }
            return matches!(read_http_response(stream), Ok((200, _)));
        }

        #[cfg(unix)]
        {
            use std::io::Write as _;
            use std::os::unix::net::UnixStream;
            let sock_path = self.config.hub_home_dir.join("run").join("admin.sock");
            let Ok(mut stream) = UnixStream::connect(&sock_path) else {
                return false;
            };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
            if stream.write_all(&wire).is_err() || stream.flush().is_err() {
                return false;
            }
            matches!(read_http_response(stream), Ok((200, _)))
        }

        #[cfg(all(not(windows), not(unix)))]
        {
            let _ = wire;
            false
        }
    }

    pub fn is_pid_probably_alive(pid: u32) -> bool {
        if pid == 0 {
            return false;
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
            use windows_sys::Win32::System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            };
            unsafe {
                let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if h.is_null() {
                    return false;
                }
                let mut code = 0u32;
                let ok = GetExitCodeProcess(h, &mut code);
                let _ = CloseHandle(h);
                ok != 0 && code == (STILL_ACTIVE as u32)
            }
        }
        #[cfg(unix)]
        {
            Command::new("/bin/kill")
                .args(["-0", &pid.to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        }
        #[cfg(all(not(windows), not(unix)))]
        {
            false
        }
    }
}

impl DaemonRuntime for NativeDaemonRuntime {
    fn verify_runtime_integrity(&self) -> Result<(), SupervisorError> {
        let entry_path = self.config.daemon_root_dir.join("src/daemon/main.ts");
        let fusa_run = self.config.fusa_run_path();
        let hub_bin = self.config.hub_bin_path();

        for (label, p) in [
            ("随包 node.exe", self.config.node_exe_path.as_path()),
            ("守护进程入口 src/daemon/main.ts", entry_path.as_path()),
            ("辅助程序 fusa-run", fusa_run.as_path()),
            ("辅助程序 hub", hub_bin.as_path()),
        ] {
            if !p.is_file() {
                return Err(SupervisorError::RuntimeIntegrityFailed(format!(
                    "缺少必需文件 {label}：{}",
                    p.display()
                )));
            }
        }

        if let Some(manifest_path) = &self.config.manifest_path {
            let manifest = RuntimeManifest::load_from_path(manifest_path)?;
            self.verify_single_file_sha256(
                "node.exe",
                &self.config.node_exe_path,
                &manifest.node_sha256,
            )?;
            self.verify_single_file_sha256("fusa-run.exe", &fusa_run, &manifest.fusa_run_sha256)?;
            self.verify_single_file_sha256("hub.exe", &hub_bin, &manifest.hub_sha256)?;
        }
        Ok(())
    }

    fn matches_local_hub_home(&self, _identity: &DaemonIdentity) -> bool {
        let lock_path = self.config.hub_home_dir.join("state").join("lock");
        let Ok(raw) = fs::read_to_string(lock_path) else {
            return false;
        };
        let Some(pid) = raw
            .lines()
            .next()
            .and_then(|line| line.trim().parse::<u32>().ok())
        else {
            return false;
        };
        Self::is_pid_probably_alive(pid)
    }

    fn spawn_owned_daemon(
        &self,
        run_id: &str,
        port: u16,
        contract: &DesktopContract,
        log_writer: Arc<Mutex<RotatingLogWriter>>,
        stderr_tail: Arc<Mutex<StderrTailCollector>>,
        on_process_exit: Box<dyn FnOnce(Option<i32>) + Send + 'static>,
    ) -> Result<Box<dyn OwnedProcessHandle>, SupervisorError> {
        let mut prepend_dirs = vec![self.config.win_helpers_dir.clone()];
        if let Some(node_dir) = self.config.node_exe_path.parent() {
            prepend_dirs.push(node_dir.to_path_buf());
        }
        let refreshed_path = build_refreshed_path_env(&prepend_dirs);

        let entry_script = self
            .config
            .daemon_root_dir
            .join(&contract.daemon_entry_relative_path);
        let mut command = Command::new(&self.config.node_exe_path);
        command
            .current_dir(&self.config.daemon_root_dir)
            .arg(&entry_script)
            .env_remove("WSLENV")
            .env_remove("ELECTRON_RUN_AS_NODE")
            .env("PATH", &refreshed_path)
            .env(&contract.supervised_env, "fusa-windows")
            .env("AGENT_HUB_HOME", &self.config.hub_home_dir)
            .env("AGENT_HUB_PORT", port.to_string())
            .env("AGENT_HUB_WIN_HELPERS", &self.config.win_helpers_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        for (k, v) in &self.config.extra_envs {
            command.env(k, v);
        }

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .map_err(|source| SupervisorError::SpawnFailed {
                program: self.config.node_exe_path.to_string_lossy().into_owned(),
                source,
            })?;
        let pid = child.id();

        #[cfg(windows)]
        let job_arc = {
            use std::os::windows::io::AsRawHandle;
            let maybe_job = fusa_win_helper::win::job::SessionJob::create(false)
                .ok()
                .and_then(|job| job.assign(child.as_raw_handle()).ok().map(|()| job));
            Arc::new(Mutex::new(maybe_job))
        };

        #[cfg(windows)]
        let wait_for_exit = process_exit_waiter(&child).map_err(|source| SupervisorError::Io {
            path: self.config.node_exe_path.clone(),
            source,
        })?;

        let stdout_pipe = child.stdout.take();
        let stderr_pipe = child.stderr.take();
        let shared_child = Arc::new(Mutex::new(Some(child)));
        let exit_code_slot = Arc::new(Mutex::new(None::<Option<i32>>));

        self.slots.lock().unwrap().insert(
            run_id.to_string(),
            NativeOwnedSlot {
                pid,
                child: Arc::clone(&shared_child),
                exit_code: Arc::clone(&exit_code_slot),
                #[cfg(windows)]
                job: Arc::clone(&job_arc),
            },
        );

        if let Some(stdout) = stdout_pipe {
            let log_clone = Arc::clone(&log_writer);
            thread::spawn(move || {
                let _ = drain_stdout(stdout, &log_clone);
            });
        }

        let stderr_join = stderr_pipe.map(|stderr| {
            let log_clone = Arc::clone(&log_writer);
            let tail_clone = Arc::clone(&stderr_tail);
            thread::spawn(move || {
                let mut reader = stderr;
                let mut chunk = [0u8; 2048];
                loop {
                    match reader.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if let Ok(mut t) = tail_clone.lock() {
                                t.append(&chunk[..n]);
                            }
                            if let Ok(mut w) = log_clone.lock() {
                                let _ = w.write_chunk(&chunk[..n]);
                            }
                        }
                    }
                }
            })
        });

        let wait_child = Arc::clone(&shared_child);
        let wait_exit_slot = Arc::clone(&exit_code_slot);
        thread::spawn(move || {
            #[cfg(windows)]
            wait_for_exit();
            let exit_code = loop {
                if let Some(already) = *wait_exit_slot.lock().unwrap() {
                    break already;
                }
                let polled = {
                    let mut guard = wait_child.lock().unwrap();
                    match guard.as_mut() {
                        None => break (*wait_exit_slot.lock().unwrap()).flatten(),
                        Some(c) => match c.try_wait() {
                            Ok(Some(st)) => {
                                let code = st.code();
                                *guard = None;
                                *wait_exit_slot.lock().unwrap() = Some(code);
                                break code;
                            }
                            Ok(None) => None,
                            Err(_) => {
                                *guard = None;
                                *wait_exit_slot.lock().unwrap() = Some(None);
                                break None;
                            }
                        },
                    }
                };
                if polled.is_some() {
                    break polled;
                }
                #[cfg(not(windows))]
                thread::sleep(Duration::from_millis(40));
                #[cfg(windows)]
                break None;
            };
            if let Some(j) = stderr_join {
                let _ = j.join();
            }
            on_process_exit(exit_code);
        });

        Ok(Box::new(StdOwnedProcessHandle {
            run_id: run_id.to_string(),
            slots: Arc::clone(&self.slots),
            child: shared_child,
            exit_code: exit_code_slot,
            #[cfg(windows)]
            job: job_arc,
        }))
    }

    fn query_owned_status(&self, run_id: &str) -> Result<OwnedProcessStatus, SupervisorError> {
        let slots = self.slots.lock().unwrap();
        let Some(slot) = slots.get(run_id) else {
            return Ok(OwnedProcessStatus::dead());
        };
        if slot.exit_code.lock().unwrap().is_some() {
            return Ok(OwnedProcessStatus {
                found: true,
                alive: false,
                pid: Some(slot.pid),
            });
        }
        let mut child_guard = slot.child.lock().unwrap();
        let alive = match child_guard.as_mut() {
            None => false,
            Some(child) => match child.try_wait() {
                Ok(Some(st)) => {
                    let code = st.code();
                    *child_guard = None;
                    *slot.exit_code.lock().unwrap() = Some(code);
                    false
                }
                Ok(None) => true,
                Err(_) => false,
            },
        };
        Ok(OwnedProcessStatus {
            found: true,
            alive,
            pid: Some(slot.pid),
        })
    }

    fn signal_owned_daemon(
        &self,
        run_id: &str,
        signal: OwnedSignal,
        contract: &DesktopContract,
    ) -> Result<bool, SupervisorError> {
        let slot_pid = {
            let slots = self.slots.lock().unwrap();
            let Some(slot) = slots.get(run_id) else {
                return Ok(false);
            };
            if slot.exit_code.lock().unwrap().is_some() {
                return Ok(false);
            }
            slot.pid
        };

        match signal {
            OwnedSignal::Term => {
                if let Ok(token) = self.read_ui_token() {
                    if self.send_admin_shutdown(&contract.shutdown_path, token.expose_secret()) {
                        return Ok(true);
                    }
                }
                #[cfg(unix)]
                {
                    let ok = Command::new("/bin/kill")
                        .args(["-s", "TERM", &slot_pid.to_string()])
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .map(|s| s.success())
                        .unwrap_or(false);
                    return Ok(ok);
                }
                #[cfg(not(unix))]
                {
                    let _ = slot_pid;
                    Ok(false)
                }
            }
            OwnedSignal::Kill => {
                let slots = self.slots.lock().unwrap();
                let Some(slot) = slots.get(run_id) else {
                    return Ok(false);
                };
                #[cfg(windows)]
                {
                    if let Some(job) = slot.job.lock().unwrap().take() {
                        job.terminate(1);
                    }
                }
                if let Some(mut child) = slot.child.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                Ok(true)
            }
        }
    }

    fn read_ui_token(&self) -> Result<SecretUiToken, SupervisorError> {
        let token_path = self.config.hub_home_dir.join("state").join("ui-token");
        let raw = fs::read_to_string(&token_path).map_err(|source| {
            SupervisorError::AuthExchangeFailed(format!(
                "读取本机 ui-token 失败（{}）：{source}",
                token_path.display()
            ))
        })?;
        SecretUiToken::new(raw)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DaemonOwnership {
    None,
    Owned,
    ExternalManaged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum StartupPhase {
    CheckingPortAndEnvironment,
    LaunchingDaemon,
    WaitingForReady { elapsed_ms: u64, budget_ms: u64 },
    ExchangingSession,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    ManualRestart,
    AppQuit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashRecord {
    pub occurred_at_epoch_ms: u64,
    pub exit_code: Option<i32>,
    pub menu_reason: String,
    pub stderr_tail_lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "fault", rename_all = "snake_case")]
pub enum SupervisorFault {
    PortConflict {
        port: u16,
        detail: String,
    },
    StartupTimedOut {
        budget_ms: u64,
        stderr_tail_lines: Vec<String>,
        detail: String,
    },
    CrashLimitExceeded {
        crashes_in_window: usize,
        window_ms: u64,
        last_crash: CrashRecord,
    },
    RuntimeIntegrityError {
        detail: String,
    },
    RuntimeFailed {
        detail: String,
    },
}

impl SupervisorFault {
    pub fn user_message(&self) -> String {
        match self {
            Self::PortConflict { detail, .. } => detail.clone(),
            Self::StartupTimedOut { detail, .. } => detail.clone(),
            Self::CrashLimitExceeded {
                crashes_in_window,
                window_ms,
                last_crash,
            } => format!(
                "后台守护进程在 {} 秒内连续异常退出 {} 次，已暂停自动重启：{}",
                window_ms / 1000,
                crashes_in_window,
                last_crash.menu_reason
            ),
            Self::RuntimeIntegrityError { detail } => detail.clone(),
            Self::RuntimeFailed { detail } => detail.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SupervisorState {
    Idle,
    Starting {
        phase: StartupPhase,
        generation: u64,
    },
    Running {
        ownership: DaemonOwnership,
        identity: DaemonIdentity,
        port: u16,
        pid: Option<u32>,
        generation: u64,
    },
    BackingOff {
        attempt: usize,
        max_attempts: usize,
        delay_ms: u64,
        last_crash: CrashRecord,
        generation: u64,
    },
    Stopping {
        reason: StopReason,
        generation: u64,
    },
    Stopped,
    Faulted {
        fault: SupervisorFault,
        generation: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorSnapshot {
    pub state: SupervisorState,
    pub ownership: DaemonOwnership,
    pub port: u16,
    pub last_crash: Option<CrashRecord>,
    pub has_session_cookie: bool,
    pub host_log_path: PathBuf,
}

struct OwnedDaemonEntry {
    run_id: String,
    instance_id: Option<String>,
    pid: Option<u32>,
    generation: u64,
    process_handle: Box<dyn OwnedProcessHandle>,
}

struct SupervisorInner {
    state: SupervisorState,
    ownership: DaemonOwnership,
    restart_generation: u64,
    auto_restart_enabled: bool,
    shutdown_requested: bool,
    recent_crash_timestamps_ms: Vec<u64>,
    recent_reload_timestamps_ms: Vec<u64>,
    last_crash: Option<CrashRecord>,
    session_cookie: Option<SessionCookie>,
    owned: Option<OwnedDaemonEntry>,
    observer: Option<Arc<dyn Fn(SupervisorSnapshot) + Send + Sync>>,
}

pub struct DaemonSupervisor<
    RT: DaemonRuntime = NativeDaemonRuntime,
    HC: HostHttpClient = UreqHostHttpClient,
    CK: Clock = SystemClock,
> {
    contract: DesktopContract,
    port: u16,
    host_log_path: PathBuf,
    runtime: RT,
    http_client: HC,
    clock: CK,
    log_writer: Arc<Mutex<RotatingLogWriter>>,
    stderr_tail: Arc<Mutex<StderrTailCollector>>,
    inner: Mutex<SupervisorInner>,
    lifecycle_op_lock: Mutex<()>,
}

impl DaemonSupervisor<NativeDaemonRuntime, UreqHostHttpClient, SystemClock> {
    pub fn with_native_defaults(config: NativeRuntimeConfig) -> Result<Arc<Self>, SupervisorError> {
        let contract = DesktopContract::embedded()?;
        let port = resolve_configured_port(&contract);
        let app_data_dir = config.app_data_dir.clone();
        let runtime = NativeDaemonRuntime::new(config);
        Self::new(
            contract,
            port,
            &app_data_dir,
            runtime,
            UreqHostHttpClient,
            SystemClock,
        )
    }
}

pub fn resolve_configured_port(contract: &DesktopContract) -> u16 {
    std::env::var("AGENT_HUB_PORT")
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
        .filter(|&p| p > 0)
        .unwrap_or(contract.default_port)
}

impl<RT, HC, CK> DaemonSupervisor<RT, HC, CK>
where
    RT: DaemonRuntime,
    HC: HostHttpClient + 'static,
    CK: Clock,
{
    pub fn new(
        contract: DesktopContract,
        port: u16,
        app_data_dir: &Path,
        runtime: RT,
        http_client: HC,
        clock: CK,
    ) -> Result<Arc<Self>, SupervisorError> {
        let host_log_path = app_data_dir.join(&contract.log_relative_path);
        let writer = RotatingLogWriter::open(
            &host_log_path,
            contract.log_max_bytes,
            contract.log_rotated_files,
        )
        .map_err(|source| SupervisorError::Io {
            path: host_log_path.clone(),
            source,
        })?;
        let collector = StderrTailCollector::from_contract(&contract);

        Ok(Arc::new(Self {
            port,
            host_log_path,
            runtime,
            http_client,
            clock,
            log_writer: Arc::new(Mutex::new(writer)),
            stderr_tail: Arc::new(Mutex::new(collector)),
            inner: Mutex::new(SupervisorInner {
                state: SupervisorState::Idle,
                ownership: DaemonOwnership::None,
                restart_generation: 0,
                auto_restart_enabled: true,
                shutdown_requested: false,
                recent_crash_timestamps_ms: Vec::new(),
                recent_reload_timestamps_ms: Vec::new(),
                last_crash: None,
                session_cookie: None,
                owned: None,
                observer: None,
            }),
            lifecycle_op_lock: Mutex::new(()),
            contract,
        }))
    }

    pub fn contract(&self) -> &DesktopContract {
        &self.contract
    }

    pub fn runtime(&self) -> &RT {
        &self.runtime
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn host_log_path(&self) -> &Path {
        &self.host_log_path
    }

    pub fn set_observer(&self, observer: Arc<dyn Fn(SupervisorSnapshot) + Send + Sync>) {
        let snap = {
            let mut g = self.inner.lock().unwrap();
            g.observer = Some(Arc::clone(&observer));
            self.build_snapshot_locked(&g)
        };
        observer(snap);
    }

    pub fn snapshot(&self) -> SupervisorSnapshot {
        let g = self.inner.lock().unwrap();
        self.build_snapshot_locked(&g)
    }

    pub fn session_cookie(&self) -> Option<SessionCookie> {
        self.inner.lock().unwrap().session_cookie.clone()
    }

    fn build_snapshot_locked(&self, g: &SupervisorInner) -> SupervisorSnapshot {
        SupervisorSnapshot {
            state: g.state.clone(),
            ownership: g.ownership,
            port: self.port,
            last_crash: g.last_crash.clone(),
            has_session_cookie: g.session_cookie.is_some(),
            host_log_path: self.host_log_path.clone(),
        }
    }

    fn update_state_and_notify(
        &self,
        mutate: impl FnOnce(&mut SupervisorInner),
    ) -> SupervisorSnapshot {
        let (snap, obs) = {
            let mut g = self.inner.lock().unwrap();
            mutate(&mut g);
            (self.build_snapshot_locked(&g), g.observer.clone())
        };
        if let Some(cb) = obs {
            cb(snap.clone());
        }
        snap
    }

    fn log_supervisor_event(&self, message: &str) {
        if let Ok(mut w) = self.log_writer.lock() {
            let ts = self.clock.now_epoch_ms();
            let _ = w.write_line(&format!("[supervisor ts={ts}] {message}"));
        }
    }

    fn is_generation_active(&self, expected_gen: u64) -> bool {
        let g = self.inner.lock().unwrap();
        !g.shutdown_requested && g.restart_generation == expected_gen
    }

    pub fn ensure_running(self: &Arc<Self>) -> Result<SupervisorSnapshot, SupervisorError> {
        {
            let g = self.inner.lock().unwrap();
            if matches!(g.state, SupervisorState::Running { .. }) {
                return Ok(self.build_snapshot_locked(&g));
            }
        }

        let target_gen = {
            let mut g = self.inner.lock().unwrap();
            if g.shutdown_requested {
                return Err(SupervisorError::CancelledByNewerGeneration);
            }
            g.auto_restart_enabled = true;
            g.restart_generation = g.restart_generation.wrapping_add(1);
            g.restart_generation
        };

        let _op_guard = self.lifecycle_op_lock.lock().unwrap();
        if !self.is_generation_active(target_gen) {
            return Err(SupervisorError::CancelledByNewerGeneration);
        }
        self.start_for_generation_locked(target_gen)
    }

    pub fn restart_manual(self: &Arc<Self>) -> Result<SupervisorSnapshot, SupervisorError> {
        let (my_gen, had_owned) = {
            let mut g = self.inner.lock().unwrap();
            if g.shutdown_requested {
                return Err(SupervisorError::CancelledByNewerGeneration);
            }
            if g.ownership == DaemonOwnership::ExternalManaged {
                return Err(SupervisorError::ExternalManagedCannotRestart);
            }
            g.auto_restart_enabled = false;
            g.recent_crash_timestamps_ms.clear();
            g.recent_reload_timestamps_ms.clear();
            g.restart_generation = g.restart_generation.wrapping_add(1);
            let gen = g.restart_generation;
            let has_owned = g.owned.is_some();
            if has_owned {
                g.ownership = DaemonOwnership::None;
                g.session_cookie = None;
                g.state = SupervisorState::Stopping {
                    reason: StopReason::ManualRestart,
                    generation: gen,
                };
            }
            (gen, has_owned)
        };

        if had_owned {
            let snap = self.snapshot();
            let observer = self.inner.lock().unwrap().observer.clone();
            if let Some(obs) = observer {
                obs(snap);
            }
        }

        let _op_guard = self.lifecycle_op_lock.lock().unwrap();
        let outgoing_owned = self.inner.lock().unwrap().owned.take();
        if let Some(owned) = outgoing_owned {
            self.stop_owned_entry(owned);
        }

        if !self.is_generation_active(my_gen) {
            return Err(SupervisorError::CancelledByNewerGeneration);
        }
        {
            let mut g = self.inner.lock().unwrap();
            g.auto_restart_enabled = true;
        }
        self.start_for_generation_locked(my_gen)
    }

    pub fn shutdown(self: &Arc<Self>) -> SupervisorSnapshot {
        {
            let mut g = self.inner.lock().unwrap();
            g.shutdown_requested = true;
            g.auto_restart_enabled = false;
            g.restart_generation = g.restart_generation.wrapping_add(1);
            let gen = g.restart_generation;
            g.session_cookie = None;
            if g.owned.is_some() {
                g.state = SupervisorState::Stopping {
                    reason: StopReason::AppQuit,
                    generation: gen,
                };
            } else {
                g.owned = None;
                g.ownership = DaemonOwnership::None;
                g.state = SupervisorState::Stopped;
            }
        }

        let mid_snap = self.snapshot();
        let observer = self.inner.lock().unwrap().observer.clone();
        if let Some(obs) = observer {
            obs(mid_snap);
        }

        let _op_guard = self.lifecycle_op_lock.lock().unwrap();
        let outgoing_owned = self.inner.lock().unwrap().owned.take();
        if let Some(owned) = outgoing_owned {
            self.stop_owned_entry(owned);
        }

        self.update_state_and_notify(|g| {
            g.ownership = DaemonOwnership::None;
            g.state = SupervisorState::Stopped;
        })
    }

    fn stop_owned_entry(&self, mut entry: OwnedDaemonEntry) {
        self.log_supervisor_event(&format!(
            "开始优雅停止自有守护进程 gen={} run_id={} pid={:?} instance={:?} 预算={}ms",
            entry.generation,
            entry.run_id,
            entry.pid,
            entry.instance_id,
            self.contract.stop_grace_ms
        ));

        let mut term_delivered = self
            .runtime
            .signal_owned_daemon(&entry.run_id, OwnedSignal::Term, &self.contract)
            .unwrap_or(false);

        let start_ms = self.clock.now_epoch_ms();
        let grace_ms = self.contract.stop_grace_ms;
        let poll_dur = self.contract.poll_interval();

        let mut cleanly_stopped = false;
        loop {
            let proc_gone = match self.runtime.query_owned_status(&entry.run_id) {
                Ok(st) => !st.any_alive(),
                Err(_) => false,
            };
            let instance_gone = match &entry.instance_id {
                None => true,
                Some(old_id) => match self.http_client.probe_status(self.port, &self.contract) {
                    ProbeOutcome::Verified(id) => id.instance_id != *old_id,
                    ProbeOutcome::Failed(_) => true,
                },
            };

            if proc_gone && instance_gone {
                cleanly_stopped = true;
                break;
            }

            let elapsed = self.clock.now_epoch_ms().saturating_sub(start_ms);
            if elapsed >= grace_ms {
                break;
            }
            if !term_delivered && entry.instance_id.is_none() && elapsed >= 1_500 {
                break;
            }
            self.clock.sleep(poll_dur);
            if !term_delivered {
                term_delivered = self
                    .runtime
                    .signal_owned_daemon(&entry.run_id, OwnedSignal::Term, &self.contract)
                    .unwrap_or(false);
            }
        }

        if !cleanly_stopped {
            self.log_supervisor_event(&format!(
                "优雅停止未在预算内完成，对本次自有进程树执行 Job + Kill 兜底回收 run_id={}",
                entry.run_id
            ));
            let _ = self.runtime.signal_owned_daemon(
                &entry.run_id,
                OwnedSignal::Kill,
                &self.contract,
            );
            for _ in 0..5 {
                if let Ok(st) = self.runtime.query_owned_status(&entry.run_id) {
                    if !st.any_alive() {
                        break;
                    }
                }
                self.clock.sleep(Duration::from_millis(50));
            }
        } else {
            self.log_supervisor_event(&format!(
                "自有守护进程已在预算内优雅退出 run_id={}",
                entry.run_id
            ));
        }

        entry.process_handle.cleanup_owned_resources();
    }

    fn start_for_generation_locked(
        self: &Arc<Self>,
        generation: u64,
    ) -> Result<SupervisorSnapshot, SupervisorError> {
        self.update_state_and_notify(|g| {
            g.ownership = DaemonOwnership::None;
            g.session_cookie = None;
            g.state = SupervisorState::Starting {
                phase: StartupPhase::CheckingPortAndEnvironment,
                generation,
            };
        });

        match self.http_client.probe_status(self.port, &self.contract) {
            ProbeOutcome::Failed(failure) if failure.is_port_conflict() => {
                let detail = failure.describe_for_port(self.port);
                self.update_state_and_notify(|g| {
                    g.ownership = DaemonOwnership::None;
                    g.state = SupervisorState::Faulted {
                        fault: SupervisorFault::PortConflict {
                            port: self.port,
                            detail: detail.clone(),
                        },
                        generation,
                    };
                });
                return Err(SupervisorError::PortConflict {
                    port: self.port,
                    detail,
                });
            }
            ProbeOutcome::Verified(host_identity) => {
                let mut exchanged_cookie = None;
                if self.runtime.matches_local_hub_home(&host_identity) {
                    if let Ok(token) = self.runtime.read_ui_token() {
                        exchanged_cookie = self
                            .http_client
                            .exchange_session_cookie(
                                self.port,
                                &token,
                                self.contract.probe_timeout(),
                            )
                            .ok();
                    }
                }
                let snap = self.update_state_and_notify(|g| {
                    g.ownership = DaemonOwnership::ExternalManaged;
                    g.session_cookie = exchanged_cookie;
                    g.state = SupervisorState::Running {
                        ownership: DaemonOwnership::ExternalManaged,
                        identity: host_identity,
                        port: self.port,
                        pid: None,
                        generation,
                    };
                });
                return Ok(snap);
            }
            ProbeOutcome::Failed(_) => {}
        }

        if let Err(err) = self.runtime.verify_runtime_integrity() {
            let detail = err.to_string();
            self.update_state_and_notify(|g| {
                g.state = SupervisorState::Faulted {
                    fault: SupervisorFault::RuntimeIntegrityError {
                        detail: detail.clone(),
                    },
                    generation,
                };
            });
            return Err(err);
        }

        if !self.is_generation_active(generation) {
            return Err(SupervisorError::CancelledByNewerGeneration);
        }

        if let Ok(mut t) = self.stderr_tail.lock() {
            t.clear();
        }
        self.update_state_and_notify(|g| {
            g.state = SupervisorState::Starting {
                phase: StartupPhase::LaunchingDaemon,
                generation,
            };
        });

        let run_id = format!("fusa-{generation}-{}", self.clock.now_epoch_ms());
        let sup_weak = Arc::downgrade(self);
        let run_id_for_cb = run_id.clone();
        let exit_flag = Arc::new(Mutex::new(None::<Option<i32>>));
        let exit_flag_cb = Arc::clone(&exit_flag);

        let process_handle = match self.runtime.spawn_owned_daemon(
            &run_id,
            self.port,
            &self.contract,
            Arc::clone(&self.log_writer),
            Arc::clone(&self.stderr_tail),
            Box::new(move |exit_code| {
                *exit_flag_cb.lock().unwrap() = Some(exit_code);
                if let Some(sup) = sup_weak.upgrade() {
                    sup.on_owned_process_exited(generation, &run_id_for_cb, exit_code);
                }
            }),
        ) {
            Ok(h) => h,
            Err(err) => {
                let detail = err.to_string();
                self.update_state_and_notify(|g| {
                    g.state = SupervisorState::Faulted {
                        fault: SupervisorFault::RuntimeFailed { detail },
                        generation,
                    };
                });
                return Err(err);
            }
        };

        {
            let mut g = self.inner.lock().unwrap();
            g.owned = Some(OwnedDaemonEntry {
                run_id: run_id.clone(),
                instance_id: None,
                pid: None,
                generation,
                process_handle,
            });
        }

        let budget_ms = self.contract.startup_budget_ms;
        let start_ms = self.clock.now_epoch_ms();
        let poll_dur = self.contract.poll_interval();
        let mut saw_process = false;

        loop {
            if !self.is_generation_active(generation) {
                let orphan = self.inner.lock().unwrap().owned.take();
                if let Some(entry) = orphan {
                    self.stop_owned_entry(entry);
                }
                return Err(SupervisorError::CancelledByNewerGeneration);
            }

            let elapsed_ms = self.clock.now_epoch_ms().saturating_sub(start_ms);
            self.update_state_and_notify(|g| {
                if matches!(g.state, SupervisorState::Starting { .. }) {
                    g.state = SupervisorState::Starting {
                        phase: StartupPhase::WaitingForReady {
                            elapsed_ms,
                            budget_ms,
                        },
                        generation,
                    };
                }
            });

            let proc_status = self
                .runtime
                .query_owned_status(&run_id)
                .unwrap_or_else(|_| OwnedProcessStatus::dead());
            if proc_status.found {
                saw_process = true;
                let mut g = self.inner.lock().unwrap();
                if let Some(owned) = g.owned.as_mut() {
                    if owned.run_id == run_id {
                        owned.pid = proc_status.pid;
                    }
                }
            }

            match self.http_client.probe_status(self.port, &self.contract) {
                ProbeOutcome::Verified(identity) => {
                    self.update_state_and_notify(|g| {
                        g.state = SupervisorState::Starting {
                            phase: StartupPhase::ExchangingSession,
                            generation,
                        };
                    });

                    let token = match self.runtime.read_ui_token() {
                        Ok(t) => t,
                        Err(err) => {
                            let orphan = self.inner.lock().unwrap().owned.take();
                            if let Some(entry) = orphan {
                                self.stop_owned_entry(entry);
                            }
                            let detail = err.to_string();
                            self.update_state_and_notify(|g| {
                                g.state = SupervisorState::Faulted {
                                    fault: SupervisorFault::RuntimeFailed { detail },
                                    generation,
                                };
                            });
                            return Err(err);
                        }
                    };

                    let cookie = match self.http_client.exchange_session_cookie(
                        self.port,
                        &token,
                        self.contract.probe_timeout(),
                    ) {
                        Ok(c) => c,
                        Err(err) => {
                            let orphan = self.inner.lock().unwrap().owned.take();
                            if let Some(entry) = orphan {
                                self.stop_owned_entry(entry);
                            }
                            let detail = err.to_string();
                            self.update_state_and_notify(|g| {
                                g.state = SupervisorState::Faulted {
                                    fault: SupervisorFault::RuntimeFailed { detail },
                                    generation,
                                };
                            });
                            return Err(err);
                        }
                    };

                    let latest_status = self
                        .runtime
                        .query_owned_status(&run_id)
                        .unwrap_or(proc_status);

                    let snap = self.update_state_and_notify(|g| {
                        if let Some(owned) = g.owned.as_mut() {
                            owned.instance_id = Some(identity.instance_id.clone());
                            owned.pid = latest_status.pid.or(owned.pid);
                        }
                        g.ownership = DaemonOwnership::Owned;
                        g.session_cookie = Some(cookie);
                        g.state = SupervisorState::Running {
                            ownership: DaemonOwnership::Owned,
                            identity: identity.clone(),
                            port: self.port,
                            pid: latest_status.pid,
                            generation,
                        };
                    });
                    self.log_supervisor_event(&format!(
                        "自有原生守护进程已就绪并完成 Cookie 兑换 instance={} pid={:?}",
                        identity.instance_id, latest_status.pid
                    ));
                    return Ok(snap);
                }
                ProbeOutcome::Failed(failure) if failure.is_port_conflict() => {
                    let detail = failure.describe_for_port(self.port);
                    let orphan = self.inner.lock().unwrap().owned.take();
                    if let Some(entry) = orphan {
                        self.stop_owned_entry(entry);
                    }
                    self.update_state_and_notify(|g| {
                        g.ownership = DaemonOwnership::None;
                        g.state = SupervisorState::Faulted {
                            fault: SupervisorFault::PortConflict {
                                port: self.port,
                                detail: detail.clone(),
                            },
                            generation,
                        };
                    });
                    return Err(SupervisorError::PortConflict {
                        port: self.port,
                        detail,
                    });
                }
                ProbeOutcome::Failed(_) => {}
            }

            let exited_now = exit_flag.lock().unwrap().is_some();
            if (exited_now || saw_process) && !proc_status.any_alive() {
                let exit_code = exit_flag.lock().unwrap().flatten();
                let orphan = self.inner.lock().unwrap().owned.take();
                if let Some(mut entry) = orphan {
                    entry.process_handle.cleanup_owned_resources();
                }
                let reason = self.record_crash_and_maybe_schedule_restart(generation, exit_code);
                return Err(SupervisorError::PrematureExit { detail: reason });
            }

            if elapsed_ms >= budget_ms {
                let orphan = self.inner.lock().unwrap().owned.take();
                if let Some(entry) = orphan {
                    self.stop_owned_entry(entry);
                }

                let tail_lines = self
                    .stderr_tail
                    .lock()
                    .map(|t| t.summary_lines())
                    .unwrap_or_default();
                let detail = format!("等待后台守护进程就绪超时（{} 秒）", budget_ms / 1000);
                self.update_state_and_notify(|g| {
                    g.ownership = DaemonOwnership::None;
                    g.state = SupervisorState::Faulted {
                        fault: SupervisorFault::StartupTimedOut {
                            budget_ms,
                            stderr_tail_lines: tail_lines,
                            detail: detail.clone(),
                        },
                        generation,
                    };
                });
                return Err(SupervisorError::StartupTimedOut { budget_ms, detail });
            }

            self.clock.sleep(poll_dur);
        }
    }

    pub fn on_owned_process_exited(
        self: &Arc<Self>,
        generation: u64,
        _run_id: &str,
        exit_code: Option<i32>,
    ) {
        let _op_guard = self.lifecycle_op_lock.lock().unwrap();
        {
            let g = self.inner.lock().unwrap();
            if g.shutdown_requested
                || !g.auto_restart_enabled
                || g.restart_generation != generation
                || !matches!(
                    g.state,
                    SupervisorState::Running {
                        ownership: DaemonOwnership::Owned,
                        ..
                    }
                )
            {
                return;
            }
        }

        let taken = {
            let mut g = self.inner.lock().unwrap();
            if g.shutdown_requested
                || !g.auto_restart_enabled
                || g.restart_generation != generation
            {
                return;
            }
            g.owned.take()
        };
        if let Some(mut entry) = taken {
            entry.process_handle.cleanup_owned_resources();
        }

        if exit_code == Some(self.contract.reload_exit_code) && self.allow_immediate_reload() {
            self.relaunch_after_reload(generation);
            return;
        }

        let _ = self.record_crash_and_maybe_schedule_restart(generation, exit_code);
    }

    pub fn allow_immediate_reload(&self) -> bool {
        let now = self.clock.now_epoch_ms();
        let mut g = self.inner.lock().unwrap();
        g.recent_reload_timestamps_ms
            .retain(|&ts| now.saturating_sub(ts) <= self.contract.crash_window_ms);
        if g.recent_reload_timestamps_ms.len() >= self.contract.max_crashes_in_window {
            return false;
        }
        g.recent_reload_timestamps_ms.push(now);
        true
    }

    fn relaunch_after_reload(self: &Arc<Self>, expected_gen: u64) {
        let next_gen = {
            let mut g = self.inner.lock().unwrap();
            if g.shutdown_requested
                || !g.auto_restart_enabled
                || g.restart_generation != expected_gen
            {
                return;
            }
            g.ownership = DaemonOwnership::None;
            g.session_cookie = None;
            g.restart_generation = g.restart_generation.wrapping_add(1);
            g.restart_generation
        };
        self.log_supervisor_event("自有守护进程空闲排空后请求热重启（退出码 75），立即拉起新进程");
        let sup = Arc::clone(self);
        thread::spawn(move || {
            if !sup.is_generation_active(next_gen) {
                return;
            }
            let _op_guard = sup.lifecycle_op_lock.lock().unwrap();
            if !sup.is_generation_active(next_gen) {
                return;
            }
            let _ = sup.start_for_generation_locked(next_gen);
        });
    }

    fn record_crash_and_maybe_schedule_restart(
        self: &Arc<Self>,
        expected_gen: u64,
        exit_code: Option<i32>,
    ) -> String {
        let now_ms = self.clock.now_epoch_ms();
        let fallback_desc = match exit_code {
            Some(c) => format!("进程异常退出（退出码 {c}）"),
            None => "进程异常终止".to_string(),
        };
        let (tail_lines, menu_reason) = {
            let t = self.stderr_tail.lock().unwrap();
            (
                t.summary_lines(),
                t.format_menu_crash_reason(&fallback_desc),
            )
        };

        let crash = CrashRecord {
            occurred_at_epoch_ms: now_ms,
            exit_code,
            menu_reason: menu_reason.clone(),
            stderr_tail_lines: tail_lines,
        };

        let window_ms = self.contract.crash_window_ms;
        let max_crashes = self.contract.max_crashes_in_window;

        let schedule_backoff: Option<(u64, u64)> = {
            let mut g = self.inner.lock().unwrap();
            if g.shutdown_requested
                || !g.auto_restart_enabled
                || g.restart_generation != expected_gen
            {
                return menu_reason;
            }

            g.recent_crash_timestamps_ms
                .retain(|&ts| now_ms.saturating_sub(ts) <= window_ms);
            g.recent_crash_timestamps_ms.push(now_ms);
            let crash_count = g.recent_crash_timestamps_ms.len();

            g.last_crash = Some(crash.clone());
            g.ownership = DaemonOwnership::None;
            g.session_cookie = None;
            g.restart_generation = g.restart_generation.wrapping_add(1);
            let next_gen = g.restart_generation;

            if crash_count >= max_crashes {
                g.state = SupervisorState::Faulted {
                    fault: SupervisorFault::CrashLimitExceeded {
                        crashes_in_window: crash_count,
                        window_ms,
                        last_crash: crash.clone(),
                    },
                    generation: next_gen,
                };
                None
            } else {
                let delay_ms = self.contract.backoff_delay_ms_for_crash_count(crash_count);
                g.state = SupervisorState::BackingOff {
                    attempt: crash_count,
                    max_attempts: max_crashes,
                    delay_ms,
                    last_crash: crash.clone(),
                    generation: next_gen,
                };
                Some((next_gen, delay_ms))
            }
        };

        self.log_supervisor_event(&format!("检测到自有守护进程崩溃：{menu_reason}"));
        let snap = self.snapshot();
        let observer = self.inner.lock().unwrap().observer.clone();
        if let Some(obs) = observer {
            obs(snap);
        }

        if let Some((backoff_gen, delay_ms)) = schedule_backoff {
            let sup = Arc::clone(self);
            thread::spawn(move || {
                sup.clock.sleep(Duration::from_millis(delay_ms));
                if !sup.is_generation_active(backoff_gen) {
                    return;
                }
                let _op_guard = sup.lifecycle_op_lock.lock().unwrap();
                if !sup.is_generation_active(backoff_gen) {
                    return;
                }
                let _ = sup.start_for_generation_locked(backoff_gen);
            });
        }

        menu_reason
    }
}
