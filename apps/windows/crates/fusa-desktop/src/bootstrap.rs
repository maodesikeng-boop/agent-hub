use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use fusa_supervisor::{
    build_refreshed_path_env, DaemonOwnership, DaemonSupervisor, DesktopContract, HostHttpClient,
    NativeRuntimeConfig, ProbeOutcome, StartupPhase, SupervisorSnapshot, SupervisorState,
    UreqHostHttpClient,
};
use serde::{Deserialize, Serialize};

const FIRST_RUN_MARKER_FILE: &str = "desktop-onboarding.json";
const DEFAULT_GIT_WINDOWS_INSTALL_CMD: &str = "winget install --id Git.Git -e --source winget";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnboardingState {
    completed: bool,
}

impl OnboardingState {
    fn load(app_data_dir: &Path) -> Self {
        let p = app_data_dir.join(FIRST_RUN_MARKER_FILE);
        fs::read_to_string(p)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save(&self, app_data_dir: &Path) -> std::io::Result<()> {
        fs::create_dir_all(app_data_dir)?;
        let p = app_data_dir.join(FIRST_RUN_MARKER_FILE);
        let json = serde_json::to_vec_pretty(self)?;
        fs::write(p, json)
    }
}

/// 来自统一厂商注册表（`src/daemon/desktop-preflight.ts`）的单家 CLI 引导元数据（Rust 侧零硬编码厂商名）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VendorGuideEntry {
    pub id: String,
    pub label: String,
    pub command: String,
    pub install_command: String,
    pub login_command: String,
    pub installed: bool,
    #[serde(default)]
    pub binary_path: Option<String>,
}

/// 原生前置环境快照（`git` + 动态厂商清单）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPreflightSummary {
    pub git_installed: bool,
    #[serde(default)]
    pub git_path: Option<String>,
    pub git_install_command: String,
    pub vendors: Vec<VendorGuideEntry>,
}

impl Default for DesktopPreflightSummary {
    fn default() -> Self {
        Self {
            git_installed: true,
            git_path: None,
            git_install_command: DEFAULT_GIT_WINDOWS_INSTALL_CMD.to_string(),
            vendors: Vec::new(),
        }
    }
}

/// 发往内嵌本地引导页（`ui/app.js`）的无敏感信息视图状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapViewModel {
    /// `"working"` | `"ready"` | `"error"` | `"muted"`
    pub tone: String,
    pub title: String,
    pub detail: String,
    pub error: Option<String>,
    pub can_retry: bool,
    pub can_open_logs: bool,
    pub show_git_guide: bool,
    pub git_install_command: String,
    pub show_vendor_guide: bool,
    pub can_enter_workspace: bool,
    pub vendors: Vec<VendorGuideEntry>,
}

impl Default for BootstrapViewModel {
    fn default() -> Self {
        Self {
            tone: "working".to_string(),
            title: "Starting Fusa…".to_string(),
            detail: String::new(),
            error: None,
            can_retry: false,
            can_open_logs: true,
            show_git_guide: false,
            git_install_command: DEFAULT_GIT_WINDOWS_INSTALL_CMD.to_string(),
            show_vendor_guide: false,
            can_enter_workspace: false,
            vendors: Vec::new(),
        }
    }
}

/// 根据监管快照与前置检查结果生成纯前端展示状态：
/// - 缺少 `git.exe` 时仅在首次引导页友好展示安装命令，绝不阻断 `Continue`（纯聊天场景随时可进）；
/// - 所有状态词与计时单位使用简洁英文，不输出灰色解释性废话（遵守 `docs/ui-standard.md` 与 `frontend-rules`）。
pub fn derive_view_from_supervisor(
    snap: &SupervisorSnapshot,
    preflight: &DesktopPreflightSummary,
    onboarding_completed: bool,
) -> BootstrapViewModel {
    match &snap.state {
        SupervisorState::Idle => BootstrapViewModel::default(),
        SupervisorState::Starting { phase, .. } => {
            let (title, detail) = match phase {
                StartupPhase::CheckingPortAndEnvironment | StartupPhase::LaunchingDaemon => {
                    ("Starting Fusa…".to_string(), format!("127.0.0.1:{}", snap.port))
                }
                StartupPhase::WaitingForReady {
                    elapsed_ms,
                    budget_ms,
                } => (
                    "Starting Fusa…".to_string(),
                    if *elapsed_ms >= 1_000 {
                        format!("{}s / {}s", elapsed_ms / 1000, budget_ms / 1000)
                    } else {
                        format!("127.0.0.1:{}", snap.port)
                    },
                ),
                StartupPhase::ExchangingSession => {
                    ("Signing in…".to_string(), format!("127.0.0.1:{}", snap.port))
                }
            };
            BootstrapViewModel {
                tone: "working".to_string(),
                title,
                detail,
                error: None,
                can_retry: false,
                can_open_logs: true,
                show_git_guide: false,
                git_install_command: preflight.git_install_command.clone(),
                show_vendor_guide: false,
                can_enter_workspace: false,
                vendors: Vec::new(),
            }
        }
        SupervisorState::Running { ownership, .. } => {
            let any_vendor_installed = preflight.vendors.iter().any(|v| v.installed);
            let should_pause_for_guide = *ownership == DaemonOwnership::Owned
                && !onboarding_completed
                && (!preflight.git_installed || !any_vendor_installed);
            BootstrapViewModel {
                tone: "ready".to_string(),
                title: "Running".to_string(),
                detail: if *ownership == DaemonOwnership::ExternalManaged {
                    format!("127.0.0.1:{} (external)", snap.port)
                } else {
                    format!("127.0.0.1:{}", snap.port)
                },
                error: None,
                can_retry: false,
                can_open_logs: true,
                show_git_guide: should_pause_for_guide && !preflight.git_installed,
                git_install_command: preflight.git_install_command.clone(),
                show_vendor_guide: should_pause_for_guide,
                can_enter_workspace: true,
                vendors: preflight.vendors.clone(),
            }
        }
        SupervisorState::BackingOff {
            attempt,
            max_attempts,
            delay_ms,
            last_crash,
            ..
        } => BootstrapViewModel {
            tone: "working".to_string(),
            title: format!("Restarting ({attempt}/{max_attempts})…"),
            detail: format!("Retrying in {}s", (*delay_ms).div_ceil(1000).max(1)),
            error: Some(last_crash.menu_reason.clone()),
            can_retry: true,
            can_open_logs: true,
            show_git_guide: false,
            git_install_command: preflight.git_install_command.clone(),
            show_vendor_guide: false,
            can_enter_workspace: false,
            vendors: Vec::new(),
        },
        SupervisorState::Stopping { .. } => BootstrapViewModel {
            tone: "working".to_string(),
            title: "Stopping…".to_string(),
            detail: String::new(),
            error: None,
            can_retry: false,
            can_open_logs: true,
            show_git_guide: false,
            git_install_command: preflight.git_install_command.clone(),
            show_vendor_guide: false,
            can_enter_workspace: false,
            vendors: Vec::new(),
        },
        SupervisorState::Stopped => BootstrapViewModel {
            tone: "muted".to_string(),
            title: "Stopped".to_string(),
            detail: String::new(),
            error: None,
            can_retry: true,
            can_open_logs: true,
            show_git_guide: false,
            git_install_command: preflight.git_install_command.clone(),
            show_vendor_guide: false,
            can_enter_workspace: false,
            vendors: Vec::new(),
        },
        SupervisorState::Faulted { fault, .. } => BootstrapViewModel {
            tone: "error".to_string(),
            title: "Unable to start".to_string(),
            detail: String::new(),
            error: Some(fault.user_message()),
            can_retry: true,
            can_open_logs: true,
            show_git_guide: false,
            git_install_command: preflight.git_install_command.clone(),
            show_vendor_guide: false,
            can_enter_workspace: false,
            vendors: Vec::new(),
        },
    }
}

/// 通过随包 `node.exe` 执行 `src/daemon/desktop-preflight.ts`，按最新注册表 `PATH` 动态读取 `git` 与厂商 CLI 状态。
pub fn run_desktop_preflight_probe(runtime_cfg: &NativeRuntimeConfig) -> Result<DesktopPreflightSummary, String> {
    let script = runtime_cfg
        .daemon_root_dir
        .join("src/daemon/desktop-preflight.ts");
    if !script.is_file() {
        return Err(format!("缺少前置检查脚本：{}", script.display()));
    }
    let mut prepend = vec![runtime_cfg.win_helpers_dir.clone()];
    if let Some(node_dir) = runtime_cfg.node_exe_path.parent() {
        prepend.push(node_dir.to_path_buf());
    }
    let refreshed_path = build_refreshed_path_env(&prepend);

    let mut cmd = Command::new(&runtime_cfg.node_exe_path);
    cmd.current_dir(&runtime_cfg.daemon_root_dir)
        .arg(&script)
        .env("PATH", &refreshed_path)
        .env("AGENT_HUB_HOME", &runtime_cfg.hub_home_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let out = cmd
        .output()
        .map_err(|e| format!("执行 desktop-preflight.ts 失败：{e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "desktop-preflight.ts 非零退出（{:?}）：{}",
            out.status.code(),
            stderr.trim()
        ));
    }
    serde_json::from_slice::<DesktopPreflightSummary>(&out.stdout)
        .map_err(|e| format!("解析 desktop-preflight.ts JSON 失败：{e}"))
}

/// 桌面端应用全局协调器（连接 `DaemonSupervisor`、前置环境检查、引导页与托盘）。
pub struct DesktopController {
    pub app_data_dir: PathBuf,
    pub contract: DesktopContract,
    pub supervisor: Arc<DaemonSupervisor>,
    view: Mutex<BootstrapViewModel>,
    preflight_cache: Mutex<DesktopPreflightSummary>,
    workflow_running: AtomicBool,
    suppress_auto_nav: AtomicBool,
    navigated_to_daemon: AtomicBool,
    on_view_changed: Mutex<Option<Arc<dyn Fn(BootstrapViewModel) + Send + Sync>>>,
    on_ready_to_navigate: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl DesktopController {
    pub fn new(runtime_config: NativeRuntimeConfig) -> Result<Arc<Self>, String> {
        let app_data_dir = runtime_config.app_data_dir.clone();
        let contract = DesktopContract::embedded().map_err(|e| e.to_string())?;
        let supervisor =
            DaemonSupervisor::with_native_defaults(runtime_config).map_err(|e| e.to_string())?;

        let ctrl = Arc::new(Self {
            app_data_dir,
            contract,
            supervisor,
            view: Mutex::new(BootstrapViewModel::default()),
            preflight_cache: Mutex::new(DesktopPreflightSummary::default()),
            workflow_running: AtomicBool::new(false),
            suppress_auto_nav: AtomicBool::new(false),
            navigated_to_daemon: AtomicBool::new(false),
            on_view_changed: Mutex::new(None),
            on_ready_to_navigate: Mutex::new(None),
        });

        let weak_ctrl = Arc::downgrade(&ctrl);
        ctrl.supervisor.set_observer(Arc::new(move |snap| {
            if let Some(c) = weak_ctrl.upgrade() {
                c.on_supervisor_snapshot(snap);
            }
        }));

        Ok(ctrl)
    }

    pub fn set_callbacks(
        &self,
        on_view: Arc<dyn Fn(BootstrapViewModel) + Send + Sync>,
        on_navigate: Arc<dyn Fn() + Send + Sync>,
    ) {
        *self.on_view_changed.lock().unwrap() = Some(on_view);
        *self.on_ready_to_navigate.lock().unwrap() = Some(on_navigate);
    }

    pub fn current_view(&self) -> BootstrapViewModel {
        self.view.lock().unwrap().clone()
    }

    fn set_view(&self, next: BootstrapViewModel) {
        *self.view.lock().unwrap() = next.clone();
        if let Some(cb) = self.on_view_changed.lock().unwrap().clone() {
            cb(next);
        }
    }

    fn on_supervisor_snapshot(&self, snap: SupervisorSnapshot) {
        let preflight = self.preflight_cache.lock().unwrap().clone();
        let onboarding = OnboardingState::load(&self.app_data_dir);
        let next = derive_view_from_supervisor(&snap, &preflight, onboarding.completed);
        let auto_nav = matches!(snap.state, SupervisorState::Running { .. })
            && !self.suppress_auto_nav.load(Ordering::SeqCst)
            && !next.show_vendor_guide
            && !self.navigated_to_daemon.load(Ordering::SeqCst);
        self.set_view(next);
        if auto_nav {
            self.trigger_navigate_to_workspace();
        }
    }

    pub fn trigger_navigate_to_workspace(&self) {
        let mut onboarding = OnboardingState::load(&self.app_data_dir);
        if !onboarding.completed {
            onboarding.completed = true;
            let _ = onboarding.save(&self.app_data_dir);
        }
        self.navigated_to_daemon.store(true, Ordering::SeqCst);
        if let Some(cb) = self.on_ready_to_navigate.lock().unwrap().clone() {
            cb();
        }
    }

    pub fn reset_navigation_flag(&self) {
        self.navigated_to_daemon.store(false, Ordering::SeqCst);
    }

    pub fn spawn_bootstrap_workflow(self: &Arc<Self>) {
        if self
            .workflow_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        let this = Arc::clone(self);
        thread::spawn(move || {
            struct Guard<'a>(&'a AtomicBool);
            impl Drop for Guard<'_> {
                fn drop(&mut self) {
                    self.0.store(false, Ordering::SeqCst);
                }
            }
            let _guard = Guard(&this.workflow_running);
            this.run_bootstrap_blocking();
        });
    }

    fn run_bootstrap_blocking(self: &Arc<Self>) {
        fusa_supervisor::refresh_current_process_path(&[]);

        let host_probe = UreqHostHttpClient.probe_status(self.supervisor.port(), &self.contract);
        if host_probe.is_port_conflict() || matches!(host_probe, ProbeOutcome::Verified(_)) {
            let _ = self.supervisor.ensure_running();
            return;
        }

        self.suppress_auto_nav.store(true, Ordering::SeqCst);
        if let Ok(report) = run_desktop_preflight_probe(self.supervisor.runtime().config()) {
            *self.preflight_cache.lock().unwrap() = report;
        }
        let ensure_res = self.supervisor.ensure_running();
        self.suppress_auto_nav.store(false, Ordering::SeqCst);
        if ensure_res.is_ok() {
            self.on_supervisor_snapshot(self.supervisor.snapshot());
        }
    }
}
