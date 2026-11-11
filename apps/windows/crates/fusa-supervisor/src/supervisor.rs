use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use fusa_wsl::{
    build_read_ui_token_cmd, build_run_daemon_ctl_cmd, decode_wsl_output,
    install_daemon_ctl_script, CommandRunner, DistroRegistryInspector, ProvisionConfig,
    Provisioner, RootfsDownloader, StdCommandRunner, SystemCurlDownloader,
    SystemRegistryInspector, WslDistroState, WslHostStatus, EMBEDDED_DAEMON_CTL_SCRIPT,
    FUSA_AGENT_HUB_HOME_WSL_DIR, FUSA_CURRENT_RELEASE_WSL_DIR,
};
use serde::{Deserialize, Serialize};

use crate::contract::DesktopContract;
use crate::error::SupervisorError;
use crate::log::{RotatingLogWriter, StderrTailCollector};
use crate::probe::{
    diagnose_dual_probe, parse_wsl_ctl_probe_output, DaemonIdentity, DualProbeDiagnosis,
    HostHttpClient, ProbeOutcome, SecretUiToken, SessionCookie, UreqHostHttpClient,
};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 可注入时钟抽象（生产环境使用系统真实单调/墙钟，单测可注入虚拟时钟秒级推演 60s 冷启动与 40s 停机预算）。
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

/// 发往自有 Linux 守护进程的受控信号类型（仅限优雅 `TERM` 与 40s 超时后的自有进程组 `KILL`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum OwnedSignal {
    Term,
    Kill,
}

impl OwnedSignal {
    pub fn as_ctl_arg(self) -> &'static str {
        match self {
            Self::Term => "TERM",
            Self::Kill => "KILL",
        }
    }
}

/// `wsl-daemon-ctl.sh status` 返回的自有 Linux 进程与进程组存活快照。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnedLinuxStatus {
    pub found: bool,
    pub leader_alive: bool,
    pub group_alive: bool,
    pub pid: Option<u32>,
    pub pgid: Option<u32>,
}

impl OwnedLinuxStatus {
    pub fn dead() -> Self {
        Self {
            found: false,
            leader_alive: false,
            group_alive: false,
            pid: None,
            pgid: None,
        }
    }

    pub fn any_alive(&self) -> bool {
        self.leader_alive || self.group_alive
    }
}

/// 宿主侧 `wsl.exe` 代理子进程句柄抽象（注意：直接关闭代理进程不等于 Linux 后台退出，仅在 Linux 确认退出后回收）。
pub trait ChildProxyHandle: Send {
    fn try_reap(&mut self) -> Option<i32>;
    fn cleanup_after_linux_exit(&mut self);
}

struct StdChildProxyHandle {
    child: Arc<Mutex<Option<Child>>>,
}

impl ChildProxyHandle for StdChildProxyHandle {
    fn try_reap(&mut self) -> Option<i32> {
        let mut guard = self.child.lock().unwrap();
        let child = guard.as_mut()?;
        match child.try_wait() {
            Ok(Some(status)) => {
                let code = status.code().unwrap_or(-1);
                *guard = None;
                Some(code)
            }
            _ => None,
        }
    }

    fn cleanup_after_linux_exit(&mut self) {
        let mut guard = self.child.lock().unwrap();
        if let Some(mut child) = guard.take() {
            match child.try_wait() {
                Ok(Some(_)) => {}
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
    }
}

// Fixed-size reads also flush output that contains no newline.
fn drain_stdout(mut reader: impl Read, log: &Mutex<RotatingLogWriter>) -> std::io::Result<()> {
    let mut buf = [0u8; 4096];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            return Ok(());
        }
        log.lock().unwrap().write_chunk(&buf[..n])?;
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
        // The owned duplicate remains valid even if cleanup reaps the Child.
        unsafe {
            WaitForSingleObject(handle.as_raw_handle(), u32::MAX);
        }
    })
}

/// WSL 守护进程运行时抽象（隔离所有 `wsl.exe` 调用，使 macOS 单测可 100% 注入模拟所有异常与慢停机场景）。
pub trait DaemonRuntime: Send + Sync + 'static {
    /// 复核专用发行版归属（状态标记 + `ext4.vhdx` + Windows `HKCU\...\Lxss` `BasePath`）。
    fn verify_distro_ownership(&self) -> Result<(), SupervisorError>;

    /// 检测专用发行版当前是否处于 `Stopped` 冷启动态（决定采用 60s 还是 15s 启动预算）。
    fn is_distro_cold(&self) -> Result<bool, SupervisorError>;

    /// 幂等安装受控脚本 `/usr/local/libexec/fusa/wsl-daemon-ctl.sh` 并在配置了随包产物时同步版本包。
    fn prepare_runtime_assets(&self) -> Result<bool, SupervisorError>;

    /// 在 WSL `Fusa` 实例内部探活 `127.0.0.1:<port>/api/auth/status`（严禁跟随重定向）。
    fn probe_guest_status(&self, port: u16, contract: &DesktopContract) -> ProbeOutcome;

    /// 通过 `wsl.exe -d Fusa -u fusa --exec /usr/local/libexec/fusa/wsl-daemon-ctl.sh run ...` 启动自有后台。
    fn spawn_owned_daemon(
        &self,
        run_id: &str,
        port: u16,
        log_writer: Arc<Mutex<RotatingLogWriter>>,
        stderr_tail: Arc<Mutex<StderrTailCollector>>,
        on_proxy_exit: Box<dyn FnOnce(Option<i32>) + Send + 'static>,
    ) -> Result<Box<dyn ChildProxyHandle>, SupervisorError>;

    /// 查询本次 `run_id` 对应的 Linux 主进程与独立进程组存活状态。
    fn query_owned_status(&self, run_id: &str) -> Result<OwnedLinuxStatus, SupervisorError>;

    /// 向经身份核验的本次自有 Linux 进程/进程组发送 `TERM` 或 `KILL`。
    fn signal_owned_daemon(&self, run_id: &str, signal: OwnedSignal) -> Result<bool, SupervisorError>;

    /// 通过 `wsl.exe -d Fusa -u fusa --exec /bin/cat /home/fusa/.agent-hub/state/ui-token` 读取令牌至内存。
    fn read_ui_token(&self) -> Result<SecretUiToken, SupervisorError>;
}

/// 真实 WSL2 守护进程运行时配置。
#[derive(Debug, Clone)]
pub struct WslRuntimeConfig {
    pub provision_config: ProvisionConfig,
    /// WSL 发行版内守护进程代码根目录（默认 `/home/fusa/.local/share/fusa/releases/current`）。
    pub app_dir_in_wsl: String,
    /// WSL 发行版内守护进程数据目录（默认 `/home/fusa/.agent-hub`）。
    pub hub_home_in_wsl: String,
    /// 可选随安装包附带的后台发布包归档（`fusa-release.tar.gz`）及其版本标识。
    pub bundled_release: Option<(String, PathBuf)>,
}

impl WslRuntimeConfig {
    pub fn new(app_data_dir: impl Into<PathBuf>) -> Self {
        Self {
            provision_config: ProvisionConfig::new(app_data_dir),
            app_dir_in_wsl: FUSA_CURRENT_RELEASE_WSL_DIR.to_string(),
            hub_home_in_wsl: FUSA_AGENT_HUB_HOME_WSL_DIR.to_string(),
            bundled_release: None,
        }
    }
}

/// 基于 `fusa-wsl` 独立参数数组的真实 WSL2 运行时实现。
pub struct WslDaemonRuntime<
    R = StdCommandRunner,
    D = SystemCurlDownloader,
    G = SystemRegistryInspector,
> {
    config: WslRuntimeConfig,
    provisioner: Provisioner<R, D, G>,
}

impl WslDaemonRuntime<StdCommandRunner, SystemCurlDownloader, SystemRegistryInspector> {
    pub fn with_defaults(config: WslRuntimeConfig) -> Self {
        let provisioner = Provisioner::with_defaults(config.provision_config.clone());
        Self {
            config,
            provisioner,
        }
    }
}

impl<R, D, G> WslDaemonRuntime<R, D, G>
where
    R: CommandRunner + 'static,
    D: RootfsDownloader + 'static,
    G: DistroRegistryInspector + 'static,
{
    pub fn new(config: WslRuntimeConfig, provisioner: Provisioner<R, D, G>) -> Self {
        Self {
            config,
            provisioner,
        }
    }

    pub fn provisioner(&self) -> &Provisioner<R, D, G> {
        &self.provisioner
    }
}

impl<R, D, G> DaemonRuntime for WslDaemonRuntime<R, D, G>
where
    R: CommandRunner + 'static,
    D: RootfsDownloader + 'static,
    G: DistroRegistryInspector + 'static,
{
    fn verify_distro_ownership(&self) -> Result<(), SupervisorError> {
        Ok(self.provisioner.verify_distro_ownership()?)
    }

    fn is_distro_cold(&self) -> Result<bool, SupervisorError> {
        match self.provisioner.probe_wsl_host()? {
            WslHostStatus::Available { distros, .. } => {
                let found = distros.iter().find(|d| {
                    d.name
                        .eq_ignore_ascii_case(&self.config.provision_config.distro_name)
                });
                Ok(!matches!(
                    found.map(|d| &d.state),
                    Some(WslDistroState::Running)
                ))
            }
            _ => Ok(true),
        }
    }

    fn prepare_runtime_assets(&self) -> Result<bool, SupervisorError> {
        let distro = &self.config.provision_config.distro_name;
        let user = &self.config.provision_config.linux_user;
        install_daemon_ctl_script(self.provisioner.runner(), distro, EMBEDDED_DAEMON_CTL_SCRIPT)?;

        let Some((version_id, archive_path)) = &self.config.bundled_release else {
            return Ok(false);
        };
        if !archive_path.is_file() {
            return Ok(false);
        }
        let archive_bytes = fs::read(archive_path).map_err(|source| SupervisorError::Io {
            path: archive_path.clone(),
            source,
        })?;
        let deploy_cmd =
            build_run_daemon_ctl_cmd(distro, user, ["deploy-release", "--version", version_id])?;
        let out = self
            .provisioner
            .runner()
            .run(&deploy_cmd, Some(&archive_bytes))
            .map_err(|source| {
                SupervisorError::Wsl(fusa_wsl::ProvisionError::SpawnFailed {
                    program: deploy_cmd.program.to_string_lossy().into_owned(),
                    source,
                })
            })?;
        if out.exit_code != 0 {
            return Err(SupervisorError::Wsl(
                fusa_wsl::ProvisionError::CommandFailed {
                    stage: "deploy_release",
                    exit_code: out.exit_code,
                    stderr: decode_wsl_output(&out.stderr),
                },
            ));
        }
        Ok(true)
    }

    fn probe_guest_status(&self, port: u16, contract: &DesktopContract) -> ProbeOutcome {
        let distro = &self.config.provision_config.distro_name;
        let user = &self.config.provision_config.linux_user;
        let port_str = port.to_string();
        let timeout_str = contract.probe_timeout_ms.to_string();
        let Ok(cmd) = build_run_daemon_ctl_cmd(
            distro,
            user,
            [
                "probe",
                "--port",
                &port_str,
                "--status-path",
                &contract.status_path,
                "--timeout-ms",
                &timeout_str,
            ],
        ) else {
            return ProbeOutcome::Failed(crate::probe::ProbeFailureKind::Unreachable {
                reason: "command_build_error".to_string(),
            });
        };

        match self.provisioner.runner().run(&cmd, None) {
            Ok(out) => {
                let text = decode_wsl_output(&out.stdout);
                parse_wsl_ctl_probe_output(&text, contract)
            }
            Err(err) => ProbeOutcome::Failed(crate::probe::ProbeFailureKind::Unreachable {
                reason: err.to_string(),
            }),
        }
    }

    fn spawn_owned_daemon(
        &self,
        run_id: &str,
        port: u16,
        log_writer: Arc<Mutex<RotatingLogWriter>>,
        stderr_tail: Arc<Mutex<StderrTailCollector>>,
        on_proxy_exit: Box<dyn FnOnce(Option<i32>) + Send + 'static>,
    ) -> Result<Box<dyn ChildProxyHandle>, SupervisorError> {
        let distro = &self.config.provision_config.distro_name;
        let user = &self.config.provision_config.linux_user;
        let port_str = port.to_string();
        let wsl_cmd = build_run_daemon_ctl_cmd(
            distro,
            user,
            [
                "run",
                "--run-id",
                run_id,
                "--app-dir",
                &self.config.app_dir_in_wsl,
                "--port",
                &port_str,
                "--home",
                &self.config.hub_home_in_wsl,
            ],
        )?;

        let mut command = Command::new(&wsl_cmd.program);
        command.args(&wsl_cmd.args);
        command.env_remove("WSLENV");
        for (k, v) in &wsl_cmd.envs {
            command.env(k, v);
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command.spawn().map_err(|source| {
            SupervisorError::Wsl(fusa_wsl::ProvisionError::SpawnFailed {
                program: wsl_cmd.program.to_string_lossy().into_owned(),
                source,
            })
        })?;

        #[cfg(windows)]
        let wait_for_exit = process_exit_waiter(&child).map_err(|source| SupervisorError::Io {
            path: PathBuf::from("wsl.exe"),
            source,
        })?;

        let stdout_pipe = child.stdout.take();
        let stderr_pipe = child.stderr.take();
        let shared_child = Arc::new(Mutex::new(Some(child)));

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
        thread::spawn(move || {
            #[cfg(windows)]
            wait_for_exit();
            let exit_code = loop {
                let polled = {
                    let mut guard = wait_child.lock().unwrap();
                    match guard.as_mut() {
                        None => break None,
                        Some(c) => match c.try_wait() {
                            Ok(Some(st)) => {
                                let code = st.code();
                                *guard = None;
                                break code;
                            }
                            Ok(None) => None,
                            Err(_) => {
                                *guard = None;
                                break None;
                            }
                        },
                    }
                };
                if polled.is_some() {
                    break polled;
                }
                #[cfg(not(windows))]
                thread::sleep(Duration::from_millis(100));
                #[cfg(windows)]
                break None;
            };
            if let Some(j) = stderr_join {
                let _ = j.join();
            }
            on_proxy_exit(exit_code);
        });

        Ok(Box::new(StdChildProxyHandle {
            child: shared_child,
        }))
    }

    fn query_owned_status(&self, run_id: &str) -> Result<OwnedLinuxStatus, SupervisorError> {
        let distro = &self.config.provision_config.distro_name;
        let user = &self.config.provision_config.linux_user;
        let cmd = build_run_daemon_ctl_cmd(
            distro,
            user,
            [
                "status",
                "--run-id",
                run_id,
                "--home",
                &self.config.hub_home_in_wsl,
            ],
        )?;
        let out = self.provisioner.runner().run(&cmd, None).map_err(|source| {
            SupervisorError::Wsl(fusa_wsl::ProvisionError::SpawnFailed {
                program: cmd.program.to_string_lossy().into_owned(),
                source,
            })
        })?;
        if out.exit_code != 0 {
            return Ok(OwnedLinuxStatus::dead());
        }
        let text = decode_wsl_output(&out.stdout);
        let parsed: OwnedLinuxStatus =
            serde_json::from_str(text.trim()).unwrap_or_else(|_| OwnedLinuxStatus::dead());
        Ok(parsed)
    }

    fn signal_owned_daemon(
        &self,
        run_id: &str,
        signal: OwnedSignal,
    ) -> Result<bool, SupervisorError> {
        let distro = &self.config.provision_config.distro_name;
        let user = &self.config.provision_config.linux_user;
        let cmd = build_run_daemon_ctl_cmd(
            distro,
            user,
            [
                "signal",
                "--run-id",
                run_id,
                "--signal",
                signal.as_ctl_arg(),
                "--home",
                &self.config.hub_home_in_wsl,
            ],
        )?;
        let out = self.provisioner.runner().run(&cmd, None).map_err(|source| {
            SupervisorError::Wsl(fusa_wsl::ProvisionError::SpawnFailed {
                program: cmd.program.to_string_lossy().into_owned(),
                source,
            })
        })?;
        if out.exit_code != 0 {
            return Ok(false);
        }
        let text = decode_wsl_output(&out.stdout);
        let v: serde_json::Value = serde_json::from_str(text.trim()).unwrap_or_default();
        Ok(v.get("signaled").and_then(|b| b.as_bool()).unwrap_or(false))
    }

    fn read_ui_token(&self) -> Result<SecretUiToken, SupervisorError> {
        let distro = &self.config.provision_config.distro_name;
        let user = &self.config.provision_config.linux_user;
        let cmd = build_read_ui_token_cmd(distro, user)?;
        let out = self.provisioner.runner().run(&cmd, None).map_err(|source| {
            SupervisorError::Wsl(fusa_wsl::ProvisionError::SpawnFailed {
                program: cmd.program.to_string_lossy().into_owned(),
                source,
            })
        })?;
        if out.exit_code != 0 {
            return Err(SupervisorError::AuthExchangeFailed(format!(
                "读取 WSL ui-token 失败（退出码 {}）",
                out.exit_code
            )));
        }
        let raw = decode_wsl_output(&out.stdout);
        SecretUiToken::new(raw)
    }
}

/// 当前端口上守护进程的所有权分类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DaemonOwnership {
    None,
    Owned,
    ExternalManaged,
}

/// 启动推进阶段（供首次运行/启动准备页展示中性阶段文案）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum StartupPhase {
    CheckingPortAndEnvironment,
    ColdStartingWsl,
    SyncingReleaseBundle,
    LaunchingDaemon,
    WaitingForReady { elapsed_ms: u64, budget_ms: u64 },
    ExchangingSession,
}

/// 触发停止自有守护进程的原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    ManualRestart,
    AppQuit,
}

/// 单次守护进程异常退出记录（含托盘 `<= 60` 字原因与最多 `8` 行 stderr 摘要）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashRecord {
    pub occurred_at_epoch_ms: u64,
    pub exit_code: Option<i32>,
    pub menu_reason: String,
    pub stderr_tail_lines: Vec<String>,
}

/// 结构化故障分类（供引导页和托盘精准展示冲突、转发异常、超时或连续崩溃原因）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "fault", rename_all = "snake_case")]
pub enum SupervisorFault {
    PortConflict {
        port: u16,
        detail: String,
    },
    LocalhostForwardingBroken {
        port: u16,
        guest_instance_id: String,
        detail: String,
    },
    StartupTimedOut {
        budget_ms: u64,
        is_cold_start: bool,
        stderr_tail_lines: Vec<String>,
        detail: String,
    },
    CrashLimitExceeded {
        crashes_in_window: usize,
        window_ms: u64,
        last_crash: CrashRecord,
    },
    DistroOwnershipError {
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
            Self::LocalhostForwardingBroken {
                port,
                guest_instance_id,
                detail,
            } => format!(
                "WSL 内 Fusa 后台（实例 {guest_instance_id}）已运行，但 Windows 宿主无法连接 127.0.0.1:{port}（{detail}）。请检查 %USERPROFILE%\\.wslconfig 中 localhostForwarding=true 及本机防火墙。"
            ),
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
            Self::DistroOwnershipError { detail } => detail.clone(),
            Self::RuntimeFailed { detail } => detail.clone(),
        }
    }
}

/// 监管器对外可观测状态机。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SupervisorState {
    Idle,
    Starting {
        phase: StartupPhase,
        is_cold_start: bool,
        generation: u64,
    },
    Running {
        ownership: DaemonOwnership,
        identity: DaemonIdentity,
        port: u16,
        linux_pid: Option<u32>,
        linux_pgid: Option<u32>,
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

/// 不含任何敏感令牌的监管器完整只读快照（可直接发给引导页与托盘菜单）。
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
    linux_pid: Option<u32>,
    linux_pgid: Option<u32>,
    generation: u64,
    proxy_handle: Box<dyn ChildProxyHandle>,
}

struct SupervisorInner {
    state: SupervisorState,
    ownership: DaemonOwnership,
    restart_generation: u64,
    auto_restart_enabled: bool,
    shutdown_requested: bool,
    recent_crash_timestamps_ms: Vec<u64>,
    last_crash: Option<CrashRecord>,
    session_cookie: Option<SessionCookie>,
    owned: Option<OwnedDaemonEntry>,
    observer: Option<Arc<dyn Fn(SupervisorSnapshot) + Send + Sync>>,
}

/// 跨平台可单测的 Fusa 守护进程起停与探活监管器。
pub struct DaemonSupervisor<
    RT: DaemonRuntime = WslDaemonRuntime,
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
    /// 轻量状态锁：绝不跨网络/进程 I/O 或 sleep 持有，保证 GUI 与托盘毫秒级读取。
    inner: Mutex<SupervisorInner>,
    /// 生命周期串行锁：确保“先停旧实例（最多 40s）确认消失，再由最新 generation 拉起唯一新实例”，彻底根除连点重启双实例竞态。
    lifecycle_op_lock: Mutex<()>,
}

impl DaemonSupervisor<WslDaemonRuntime, UreqHostHttpClient, SystemClock> {
    pub fn with_wsl_defaults(
        app_data_dir: impl Into<PathBuf>,
        bundled_release: Option<(String, PathBuf)>,
    ) -> Result<Arc<Self>, SupervisorError> {
        let app_data_dir = app_data_dir.into();
        let contract = DesktopContract::embedded()?;
        let port = resolve_configured_port(&contract);
        let mut rt_cfg = WslRuntimeConfig::new(&app_data_dir);
        rt_cfg.bundled_release = bundled_release;
        let runtime = WslDaemonRuntime::with_defaults(rt_cfg);
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

    /// 获取内存中的会话 Cookie（仅供 WebView2 Cookie 注入，绝不落盘或打印）。
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

    fn update_state_and_notify(&self, mutate: impl FnOnce(&mut SupervisorInner)) -> SupervisorSnapshot {
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

    /// 确保后台处于运行态（若端口已有外部兼容 Fusa 则标记 `ExternalManaged` 复用；若冲突则报 `PortConflict`；否则按冷/热预算拉起自有实例）。
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

    /// 手动触发“重启后台服务”：
    /// 1. 若当前为 `ExternalManaged`，拒绝触碰外部实例并返回错误；
    /// 2. 立即递增 `restart_generation`、禁用旧进程自动重启、清零崩溃计数窗口；
    /// 3. 在串行生命周期锁内先对自有 Linux 进程发 `SIGTERM` 并在 40s 预算内确认旧 PID/进程组及旧 `instanceId` 消失（超时仅对自有进程树发 `SIGKILL`）；
    /// 4. 若等待期间用户又连点了更新一次重启，旧请求立即让位，仅由最新一次请求拉起唯一新实例。
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

    /// 彻底退出应用时的受控停机：
    /// - `ExternalManaged` 或无自有进程时绝不发送任何信号，立即返回 `Stopped`；
    /// - `Owned` 自有进程按契约执行最多 `stopGraceMs`（40s）优雅停机。
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
            entry.generation, entry.run_id, entry.linux_pid, entry.instance_id, self.contract.stop_grace_ms
        ));

        let _ = self
            .runtime
            .signal_owned_daemon(&entry.run_id, OwnedSignal::Term);

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
                Some(old_id) => match self.runtime.probe_guest_status(self.port, &self.contract) {
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
            self.clock.sleep(poll_dur);
        }

        if !cleanly_stopped {
            self.log_supervisor_event(&format!(
                "优雅停止超出 {}ms 预算，仅对本次自有进程树发送 SIGKILL run_id={}",
                grace_ms, entry.run_id
            ));
            let _ = self
                .runtime
                .signal_owned_daemon(&entry.run_id, OwnedSignal::Kill);
            // 给内核回收进程组留出短暂观察窗口
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

        entry.proxy_handle.cleanup_after_linux_exit();
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
                is_cold_start: false,
                generation,
            };
        });

        // 第 1 步：启动前检查宿主端口是否已被其他进程或外部兼容 Fusa 实例占用
        let pre_host = self.http_client.probe_status(self.port, &self.contract);
        match pre_host {
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
                // 宿主端口已有兼容 Fusa 实例：先在归属核验通过的前提下确认是否就是本专用 WSL 发行版内的实例。
                // 只有当 WSL 内实例核验通过且 instanceId 完全一致时才安全兑换 ui-token，防伪造实例窃取令牌！
                let mut exchanged_cookie = None;
                if self.runtime.verify_distro_ownership().is_ok() {
                    if let ProbeOutcome::Verified(guest_id) =
                        self.runtime.probe_guest_status(self.port, &self.contract)
                    {
                        if guest_id.instance_id == host_identity.instance_id {
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
                    }
                }
                let snap = self.update_state_and_notify(|g| {
                    g.ownership = DaemonOwnership::ExternalManaged;
                    g.session_cookie = exchanged_cookie;
                    g.state = SupervisorState::Running {
                        ownership: DaemonOwnership::ExternalManaged,
                        identity: host_identity,
                        port: self.port,
                        linux_pid: None,
                        linux_pgid: None,
                        generation,
                    };
                });
                return Ok(snap);
            }
            ProbeOutcome::Failed(_) => {}
        }

        // 第 2 步：核验专用 WSL 发行版三重归属（状态标记 + ext4.vhdx + Lxss 注册表 BasePath）
        if let Err(err) = self.runtime.verify_distro_ownership() {
            let detail = err.to_string();
            self.update_state_and_notify(|g| {
                g.state = SupervisorState::Faulted {
                    fault: SupervisorFault::DistroOwnershipError {
                        detail: detail.clone(),
                    },
                    generation,
                };
            });
            return Err(err);
        }

        let is_cold = self.runtime.is_distro_cold()?;
        if is_cold {
            self.update_state_and_notify(|g| {
                g.state = SupervisorState::Starting {
                    phase: StartupPhase::ColdStartingWsl,
                    is_cold_start: true,
                    generation,
                };
            });
        }

        if !self.is_generation_active(generation) {
            return Err(SupervisorError::CancelledByNewerGeneration);
        }

        // 第 3 步：唤醒/检查 WSL 内部端口是否已有兼容实例或端口冲突
        let pre_guest = self.runtime.probe_guest_status(self.port, &self.contract);
        match pre_guest {
            ProbeOutcome::Failed(failure) if failure.is_port_conflict() => {
                let detail = failure.describe_for_port(self.port);
                self.update_state_and_notify(|g| {
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
            ProbeOutcome::Verified(guest_id) => {
                // WSL 内已有运行中的外部兼容 Fusa：复查宿主侧转发
                match self.http_client.probe_status(self.port, &self.contract) {
                    ProbeOutcome::Verified(host_id)
                        if host_id.instance_id == guest_id.instance_id =>
                    {
                        let token = self.runtime.read_ui_token()?;
                        let cookie = self.http_client.exchange_session_cookie(
                            self.port,
                            &token,
                            self.contract.probe_timeout(),
                        )?;
                        let snap = self.update_state_and_notify(|g| {
                            g.ownership = DaemonOwnership::ExternalManaged;
                            g.session_cookie = Some(cookie);
                            g.state = SupervisorState::Running {
                                ownership: DaemonOwnership::ExternalManaged,
                                identity: host_id,
                                port: self.port,
                                linux_pid: None,
                                linux_pgid: None,
                                generation,
                            };
                        });
                        return Ok(snap);
                    }
                    ProbeOutcome::Failed(f) if f.is_port_conflict() => {
                        let detail = f.describe_for_port(self.port);
                        self.update_state_and_notify(|g| {
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
                    _ => {
                        let detail = "WSL 内部实例已监听但宿主回环不可达".to_string();
                        self.update_state_and_notify(|g| {
                            g.state = SupervisorState::Faulted {
                                fault: SupervisorFault::LocalhostForwardingBroken {
                                    port: self.port,
                                    guest_instance_id: guest_id.instance_id.clone(),
                                    detail: detail.clone(),
                                },
                                generation,
                            };
                        });
                        return Err(SupervisorError::LocalhostForwardingBroken {
                            port: self.port,
                            guest_instance_id: guest_id.instance_id,
                            detail,
                        });
                    }
                }
            }
            ProbeOutcome::Failed(_) => {}
        }

        // 第 4 步：准备受控脚本与可选版本包
        self.update_state_and_notify(|g| {
            g.state = SupervisorState::Starting {
                phase: StartupPhase::SyncingReleaseBundle,
                is_cold_start: is_cold,
                generation,
            };
        });
        if let Err(err) = self.runtime.prepare_runtime_assets() {
            let detail = err.to_string();
            self.update_state_and_notify(|g| {
                g.state = SupervisorState::Faulted {
                    fault: SupervisorFault::RuntimeFailed { detail },
                    generation,
                };
            });
            return Err(err);
        }

        if !self.is_generation_active(generation) {
            return Err(SupervisorError::CancelledByNewerGeneration);
        }

        // 第 5 步：拉起自有守护进程
        if let Ok(mut t) = self.stderr_tail.lock() {
            t.clear();
        }
        self.update_state_and_notify(|g| {
            g.state = SupervisorState::Starting {
                phase: StartupPhase::LaunchingDaemon,
                is_cold_start: is_cold,
                generation,
            };
        });

        let run_id = format!("fusa-{generation}-{}", self.clock.now_epoch_ms());
        let sup_weak = Arc::downgrade(self);
        let run_id_for_cb = run_id.clone();
        let proxy_exit_flag = Arc::new(Mutex::new(None::<Option<i32>>));
        let proxy_exit_flag_cb = Arc::clone(&proxy_exit_flag);

        let proxy_handle = match self.runtime.spawn_owned_daemon(
            &run_id,
            self.port,
            Arc::clone(&self.log_writer),
            Arc::clone(&self.stderr_tail),
            Box::new(move |exit_code| {
                *proxy_exit_flag_cb.lock().unwrap() = Some(exit_code);
                if let Some(sup) = sup_weak.upgrade() {
                    sup.on_owned_proxy_exited(generation, &run_id_for_cb, exit_code);
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
                linux_pid: None,
                linux_pgid: None,
                generation,
                proxy_handle,
            });
        }

        // 第 6 步：在预算（冷启动 60s / 热启动 15s）内推进双重探活，一旦就绪立即停止轮询！
        let budget_ms = self.contract.startup_budget_ms_for(is_cold);
        let start_ms = self.clock.now_epoch_ms();
        let poll_dur = self.contract.poll_interval();
        let mut saw_lease = false;

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
                        is_cold_start: is_cold,
                        generation,
                    };
                }
            });

            let linux_status = self
                .runtime
                .query_owned_status(&run_id)
                .unwrap_or_else(|_| OwnedLinuxStatus::dead());
            if linux_status.found {
                saw_lease = true;
                let mut g = self.inner.lock().unwrap();
                if let Some(owned) = g.owned.as_mut() {
                    if owned.run_id == run_id {
                        owned.linux_pid = linux_status.pid;
                        owned.linux_pgid = linux_status.pgid;
                    }
                }
            }

            let guest_out = self.runtime.probe_guest_status(self.port, &self.contract);
            let host_out = self.http_client.probe_status(self.port, &self.contract);

            let last_forwarding_broken = match diagnose_dual_probe(guest_out, host_out) {
                DualProbeDiagnosis::Ready(identity) => {
                    self.update_state_and_notify(|g| {
                        g.state = SupervisorState::Starting {
                            phase: StartupPhase::ExchangingSession,
                            is_cold_start: is_cold,
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
                        .unwrap_or(linux_status);

                    let snap = self.update_state_and_notify(|g| {
                        if let Some(owned) = g.owned.as_mut() {
                            owned.instance_id = Some(identity.instance_id.clone());
                            owned.linux_pid = latest_status.pid.or(owned.linux_pid);
                            owned.linux_pgid = latest_status.pgid.or(owned.linux_pgid);
                        }
                        g.ownership = DaemonOwnership::Owned;
                        g.session_cookie = Some(cookie);
                        g.state = SupervisorState::Running {
                            ownership: DaemonOwnership::Owned,
                            identity: identity.clone(),
                            port: self.port,
                            linux_pid: latest_status.pid,
                            linux_pgid: latest_status.pgid,
                            generation,
                        };
                    });
                    self.log_supervisor_event(&format!(
                        "自有守护进程已就绪并完成 Cookie 兑换 instance={} pid={:?}（已停止准备轮询，稳定态零空转）",
                        identity.instance_id, latest_status.pid
                    ));
                    return Ok(snap);
                }

                DualProbeDiagnosis::PortConflict { failure, .. } => {
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

                DualProbeDiagnosis::SplitBrainInstanceMismatch { host_identity, .. } => {
                    let detail = format!(
                        "宿主端口 {} 被另一个实例（instanceId={}）抢占，与 WSL 内受控后台不一致",
                        self.port, host_identity.instance_id
                    );
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

                DualProbeDiagnosis::LocalhostForwardingBroken {
                    guest_identity,
                    host_reason,
                } => Some((guest_identity, host_reason)),

                DualProbeDiagnosis::BothUnreachable => None,
            };

            // 检查自有进程是否已提前崩溃退出（同时核验宿主 wsl.exe 代理退出或租约进程消失）
            let proxy_exited = proxy_exit_flag.lock().unwrap().is_some();
            if (proxy_exited || saw_lease) && !linux_status.any_alive() {
                let exit_code = proxy_exit_flag.lock().unwrap().flatten();
                let orphan = self.inner.lock().unwrap().owned.take();
                if let Some(mut entry) = orphan {
                    entry.proxy_handle.cleanup_after_linux_exit();
                }
                let reason = self.record_crash_and_maybe_schedule_restart(generation, exit_code);
                return Err(SupervisorError::PrematureExit { detail: reason });
            }

            if elapsed_ms >= budget_ms {
                let orphan = self.inner.lock().unwrap().owned.take();
                if let Some(entry) = orphan {
                    self.stop_owned_entry(entry);
                }

                if let Some((guest_id, host_reason)) = last_forwarding_broken {
                    self.update_state_and_notify(|g| {
                        g.ownership = DaemonOwnership::None;
                        g.state = SupervisorState::Faulted {
                            fault: SupervisorFault::LocalhostForwardingBroken {
                                port: self.port,
                                guest_instance_id: guest_id.instance_id.clone(),
                                detail: host_reason.clone(),
                            },
                            generation,
                        };
                    });
                    return Err(SupervisorError::LocalhostForwardingBroken {
                        port: self.port,
                        guest_instance_id: guest_id.instance_id,
                        detail: host_reason,
                    });
                }

                let tail_lines = self
                    .stderr_tail
                    .lock()
                    .map(|t| t.summary_lines())
                    .unwrap_or_default();
                let detail = format!(
                    "等待后台守护进程就绪超时（{} 秒{}）",
                    budget_ms / 1000,
                    if is_cold { "，WSL 冷启动预算" } else { "" }
                );
                self.update_state_and_notify(|g| {
                    g.ownership = DaemonOwnership::None;
                    g.state = SupervisorState::Faulted {
                        fault: SupervisorFault::StartupTimedOut {
                            budget_ms,
                            is_cold_start: is_cold,
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

    /// 供宿主代理退出回调或测试主动通知：核验 Linux 真实退出状态后进入退避重启或连续崩溃熔断。
    pub fn on_owned_proxy_exited(
        self: &Arc<Self>,
        generation: u64,
        run_id: &str,
        proxy_exit_code: Option<i32>,
    ) {
        let _op_guard = self.lifecycle_op_lock.lock().unwrap();
        {
            let g = self.inner.lock().unwrap();
            if g.shutdown_requested
                || !g.auto_restart_enabled
                || g.restart_generation != generation
                || !matches!(g.state, SupervisorState::Running { ownership: DaemonOwnership::Owned, .. })
            {
                return;
            }
        }

        // 关键保护：`wsl.exe` 只是宿主代理进程！若 Linux 内受控主进程仍然存活且端口身份一致，绝不误判为崩溃！
        if let Ok(st) = self.runtime.query_owned_status(run_id) {
            if st.leader_alive {
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
        if let Some(entry) = taken {
            self.stop_owned_entry(entry);
        }

        // 守护进程空闲排空后主动请求热重启（hub self-reload）：立即拉起新进程，不记崩溃、不退避、不计入熔断窗口
        if proxy_exit_code == Some(self.contract.reload_exit_code) {
            self.relaunch_after_reload(generation);
            return;
        }

        let _ = self.record_crash_and_maybe_schedule_restart(generation, proxy_exit_code);
    }

    fn relaunch_after_reload(self: &Arc<Self>, expected_gen: u64) {
        let next_gen = {
            let mut g = self.inner.lock().unwrap();
            if g.shutdown_requested || !g.auto_restart_enabled || g.restart_generation != expected_gen
            {
                return;
            }
            g.ownership = DaemonOwnership::None;
            g.session_cookie = None;
            g.restart_generation = g.restart_generation.wrapping_add(1);
            g.restart_generation
        };
        self.log_supervisor_event("自有守护进程空闲排空后请求热重启，立即拉起新进程");
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
            if g.shutdown_requested || !g.auto_restart_enabled || g.restart_generation != expected_gen
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

#[cfg(test)]
mod review_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Runtime(Arc<AtomicUsize>);
    impl DaemonRuntime for Runtime {
        fn verify_distro_ownership(&self) -> Result<(), SupervisorError> {
            Ok(())
        }
        fn is_distro_cold(&self) -> Result<bool, SupervisorError> {
            Ok(false)
        }
        fn prepare_runtime_assets(&self) -> Result<bool, SupervisorError> {
            Ok(false)
        }
        fn probe_guest_status(&self, _: u16, _: &DesktopContract) -> ProbeOutcome {
            unreachable!()
        }
        fn spawn_owned_daemon(
            &self,
            _: &str,
            _: u16,
            _: Arc<Mutex<RotatingLogWriter>>,
            _: Arc<Mutex<StderrTailCollector>>,
            _: Box<dyn FnOnce(Option<i32>) + Send>,
        ) -> Result<Box<dyn ChildProxyHandle>, SupervisorError> {
            unreachable!()
        }
        fn query_owned_status(&self, _: &str) -> Result<OwnedLinuxStatus, SupervisorError> {
            Ok(OwnedLinuxStatus::dead())
        }
        fn signal_owned_daemon(&self, _: &str, _: OwnedSignal) -> Result<bool, SupervisorError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(true)
        }
        fn read_ui_token(&self) -> Result<SecretUiToken, SupervisorError> {
            unreachable!()
        }
    }
    struct Proxy;
    impl ChildProxyHandle for Proxy {
        fn try_reap(&mut self) -> Option<i32> {
            None
        }
        fn cleanup_after_linux_exit(&mut self) {}
    }

    #[test]
    fn shutdown_during_start_preserves_lease_and_notifies_without_lock() {
        let dir = tempfile::tempdir().unwrap();
        let signals = Arc::new(AtomicUsize::new(0));
        let sup = DaemonSupervisor::new(
            DesktopContract::embedded().unwrap(),
            4317,
            dir.path(),
            Runtime(signals.clone()),
            UreqHostHttpClient,
            SystemClock,
        )
        .unwrap();
        {
            let mut g = sup.inner.lock().unwrap();
            g.owned = Some(OwnedDaemonEntry {
                run_id: "starting".into(),
                instance_id: None,
                linux_pid: None,
                linux_pgid: None,
                generation: 1,
                proxy_handle: Box::new(Proxy),
            });
            // Starting has not yet acquired public Owned status.
            g.ownership = DaemonOwnership::None;
        }
        let weak = Arc::downgrade(&sup);
        sup.set_observer(Arc::new(move |_| {
            assert!(
                weak.upgrade().unwrap().inner.try_lock().is_ok(),
                "observer invoked under supervisor lock"
            );
        }));
        sup.shutdown();
        assert_eq!(
            signals.load(Ordering::SeqCst),
            1,
            "starting lease must receive TERM"
        );
    }

    #[test]
    fn proxy_exit_cleans_owned_group_before_crash_transition() {
        let dir = tempfile::tempdir().unwrap();
        let signals = Arc::new(AtomicUsize::new(0));
        let mut contract = DesktopContract::embedded().unwrap();
        contract.max_crashes_in_window = 1;
        let sup = DaemonSupervisor::new(
            contract,
            4317,
            dir.path(),
            Runtime(signals.clone()),
            UreqHostHttpClient,
            SystemClock,
        )
        .unwrap();
        {
            let mut g = sup.inner.lock().unwrap();
            let generation = g.restart_generation;
            g.auto_restart_enabled = true;
            g.owned = Some(OwnedDaemonEntry {
                run_id: "crashed".into(),
                instance_id: None,
                linux_pid: None,
                linux_pgid: None,
                generation,
                proxy_handle: Box::new(Proxy),
            });
            g.state = SupervisorState::Running {
                ownership: DaemonOwnership::Owned,
                identity: DaemonIdentity {
                    product: "fusa".into(),
                    protocol_version: 1,
                    instance_id: "old".into(),
                    status: None,
                },
                port: 4317,
                linux_pid: None,
                linux_pgid: None,
                generation,
            };
        }
        let generation = sup.inner.lock().unwrap().restart_generation;
        sup.on_owned_proxy_exited(generation, "crashed", Some(1));
        assert_eq!(signals.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn newline_free_stdout_is_flushed_before_next_read_and_rotated() {
        struct Output {
            path: PathBuf,
            reads: usize,
        }
        impl Read for Output {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.reads > 0 {
                    assert!(std::fs::metadata(&self.path).unwrap().len() <= 4096);
                    assert!(self.path.with_extension("log.1").exists());
                }
                self.reads += 1;
                if self.reads > 3 {
                    return Ok(0);
                }
                buf.fill(b'x');
                Ok(buf.len())
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stdout.log");
        let log = Mutex::new(RotatingLogWriter::open(&path, 1024, 1).unwrap());
        drain_stdout(
            Output {
                path: path.clone(),
                reads: 0,
            },
            &log,
        )
        .unwrap();
        assert_eq!(std::fs::metadata(path).unwrap().len(), 1024);
    }

    #[cfg(windows)]
    #[test]
    fn windows_exit_waiter_wakes_when_child_exits() {
        let mut child = Command::new("cmd.exe")
            .args(["/c", "exit", "7"])
            .spawn()
            .unwrap();
        process_exit_waiter(&child).unwrap()();
        assert_eq!(child.try_wait().unwrap().unwrap().code(), Some(7));
    }

    #[test]
    fn bundled_contract_is_byte_identical() {
        assert_eq!(
            include_str!("../../fusa-desktop/resources/contract.json"),
            crate::contract::EMBEDDED_DESKTOP_CONTRACT_JSON
        );
    }
}
