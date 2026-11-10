use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use fusa_supervisor::{
    DaemonOwnership, DaemonSupervisor, DesktopContract, HostHttpClient, StartupPhase,
    SupervisorSnapshot, SupervisorState,
};
use fusa_wsl::{
    ProvisionConfig, ProvisionError, ProvisionStage, ProvisionState, Provisioner, VendorGuideEntry,
    FUSA_CURRENT_RELEASE_WSL_DIR, FUSA_DISTRO_NAME, FUSA_LINUX_USER,
};
use serde::{Deserialize, Serialize};

const FIRST_RUN_MARKER_FILE: &str = "desktop-onboarding.json";

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

/// 发往内嵌本地引导页（`ui/app.js`）的无敏感信息视图状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapViewModel {
    /// `"working"` | `"ready"` | `"error"` | `"muted"`
    pub tone: String,
    pub title: String,
    pub detail: String,
    pub error: Option<String>,
    pub can_install_wsl: bool,
    pub can_retry: bool,
    pub can_open_logs: bool,
    pub show_vendor_guide: bool,
    pub can_enter_workspace: bool,
    pub vendors: Vec<VendorGuideEntry>,
}

impl Default for BootstrapViewModel {
    fn default() -> Self {
        Self {
            tone: "working".to_string(),
            title: "Checking environment…".to_string(),
            detail: "Verifying WSL2 runtime and local port".to_string(),
            error: None,
            can_install_wsl: false,
            can_retry: false,
            can_open_logs: true,
            show_vendor_guide: false,
            can_enter_workspace: false,
            vendors: Vec::new(),
        }
    }
}

/// 根据准备阶段与监管快照计算纯前端展示状态（单测可直接验证所有状态分支）。
pub fn derive_view_from_supervisor(
    snap: &SupervisorSnapshot,
    vendors: &[VendorGuideEntry],
    onboarding_completed: bool,
) -> BootstrapViewModel {
    match &snap.state {
        SupervisorState::Idle => BootstrapViewModel::default(),
        SupervisorState::Starting {
            phase,
            is_cold_start,
            ..
        } => {
            let (title, detail) = match phase {
                StartupPhase::CheckingPortAndEnvironment => (
                    "Checking environment…".to_string(),
                    format!("Verifying 127.0.0.1:{}", snap.port),
                ),
                StartupPhase::ColdStartingWsl => (
                    "Starting WSL environment…".to_string(),
                    "Waking dedicated Fusa Linux instance (up to 60s on cold boot)".to_string(),
                ),
                StartupPhase::SyncingReleaseBundle => (
                    "Updating runtime files…".to_string(),
                    "Syncing Fusa backend bundle inside WSL".to_string(),
                ),
                StartupPhase::LaunchingDaemon => (
                    "Starting Fusa daemon…".to_string(),
                    "Launching isolated Linux background service".to_string(),
                ),
                StartupPhase::WaitingForReady {
                    elapsed_ms,
                    budget_ms,
                } => (
                    "Waiting for Fusa daemon…".to_string(),
                    format!(
                        "{}s / {}s{}",
                        elapsed_ms / 1000,
                        budget_ms / 1000,
                        if *is_cold_start { " (cold start)" } else { "" }
                    ),
                ),
                StartupPhase::ExchangingSession => (
                    "Signing in to local workspace…".to_string(),
                    "Establishing local session cookie".to_string(),
                ),
            };
            BootstrapViewModel {
                tone: "working".to_string(),
                title,
                detail,
                error: None,
                can_install_wsl: false,
                can_retry: false,
                can_open_logs: true,
                show_vendor_guide: false,
                can_enter_workspace: false,
                vendors: Vec::new(),
            }
        }
        SupervisorState::Running { ownership, .. } => {
            let any_vendor_installed = vendors.iter().any(|v| v.installed);
            let should_pause_for_guide = *ownership == DaemonOwnership::Owned
                && (!onboarding_completed || (!vendors.is_empty() && !any_vendor_installed));
            BootstrapViewModel {
                tone: "ready".to_string(),
                title: "Fusa daemon is running".to_string(),
                detail: if *ownership == DaemonOwnership::ExternalManaged {
                    format!("Connected to external Fusa instance on 127.0.0.1:{}", snap.port)
                } else {
                    format!("Listening on 127.0.0.1:{}", snap.port)
                },
                error: None,
                can_install_wsl: false,
                can_retry: false,
                can_open_logs: true,
                show_vendor_guide: should_pause_for_guide,
                can_enter_workspace: true,
                vendors: vendors.to_vec(),
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
            title: format!("Restarting daemon ({attempt}/{max_attempts})…"),
            detail: format!("Retrying in {}s", (*delay_ms).div_ceil(1000).max(1)),
            error: Some(last_crash.menu_reason.clone()),
            can_install_wsl: false,
            can_retry: true,
            can_open_logs: true,
            show_vendor_guide: false,
            can_enter_workspace: false,
            vendors: Vec::new(),
        },
        SupervisorState::Stopping { .. } => BootstrapViewModel {
            tone: "working".to_string(),
            title: "Stopping Fusa daemon…".to_string(),
            detail: "Waiting for active tasks to close cleanly".to_string(),
            error: None,
            can_install_wsl: false,
            can_retry: false,
            can_open_logs: true,
            show_vendor_guide: false,
            can_enter_workspace: false,
            vendors: Vec::new(),
        },
        SupervisorState::Stopped => BootstrapViewModel {
            tone: "muted".to_string(),
            title: "Fusa daemon stopped".to_string(),
            detail: "Click Retry to start the background service".to_string(),
            error: None,
            can_install_wsl: false,
            can_retry: true,
            can_open_logs: true,
            show_vendor_guide: false,
            can_enter_workspace: false,
            vendors: Vec::new(),
        },
        SupervisorState::Faulted { fault, .. } => BootstrapViewModel {
            tone: "error".to_string(),
            title: "Unable to start Fusa daemon".to_string(),
            detail: "Resolve the issue below and click Retry".to_string(),
            error: Some(fault.user_message()),
            can_install_wsl: false,
            can_retry: true,
            can_open_logs: true,
            show_vendor_guide: false,
            can_enter_workspace: false,
            vendors: Vec::new(),
        },
    }
}

/// 将 `fusa-wsl` 准备器错误映射为引导页展示状态。
pub fn derive_view_from_provision_error(err: &ProvisionError) -> BootstrapViewModel {
    match err {
        ProvisionError::WslNotInstalled => BootstrapViewModel {
            tone: "error".to_string(),
            title: "WSL2 is not installed".to_string(),
            detail: "Install Windows Subsystem for Linux (no default distribution) and restart Windows".to_string(),
            error: Some(err.to_string()),
            can_install_wsl: true,
            can_retry: true,
            can_open_logs: true,
            show_vendor_guide: false,
            can_enter_workspace: false,
            vendors: Vec::new(),
        },
        ProvisionError::RebootRequired | ProvisionError::KernelOrVirtualizationNotReady { .. } => {
            BootstrapViewModel {
                tone: "error".to_string(),
                title: "Windows restart required".to_string(),
                detail: "Restart Windows to finish enabling WSL2 virtualization, then reopen Fusa"
                    .to_string(),
                error: Some(err.to_string()),
                can_install_wsl: false,
                can_retry: true,
                can_open_logs: true,
                show_vendor_guide: false,
                can_enter_workspace: false,
                vendors: Vec::new(),
            }
        }
        other => BootstrapViewModel {
            tone: "error".to_string(),
            title: "Environment setup failed".to_string(),
            detail: "Review logs for details, then click Retry".to_string(),
            error: Some(other.to_string()),
            can_install_wsl: false,
            can_retry: true,
            can_open_logs: true,
            show_vendor_guide: false,
            can_enter_workspace: false,
            vendors: Vec::new(),
        },
    }
}

/// 桌面端应用全局协调器（连接 `Provisioner`、`DaemonSupervisor`、引导页与托盘）。
pub struct DesktopController {
    pub app_data_dir: PathBuf,
    pub contract: DesktopContract,
    pub supervisor: Arc<DaemonSupervisor>,
    view: Mutex<BootstrapViewModel>,
    vendors_cache: Mutex<Vec<VendorGuideEntry>>,
    workflow_running: AtomicBool,
    suppress_auto_nav: AtomicBool,
    navigated_to_daemon: AtomicBool,
    on_view_changed: Mutex<Option<Arc<dyn Fn(BootstrapViewModel) + Send + Sync>>>,
    on_ready_to_navigate: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl DesktopController {
    pub fn new(
        app_data_dir: PathBuf,
        bundled_release: Option<(String, PathBuf)>,
    ) -> Result<Arc<Self>, String> {
        let contract = DesktopContract::embedded().map_err(|e| e.to_string())?;
        let supervisor = DaemonSupervisor::with_wsl_defaults(&app_data_dir, bundled_release)
            .map_err(|e| e.to_string())?;

        let ctrl = Arc::new(Self {
            app_data_dir,
            contract,
            supervisor,
            view: Mutex::new(BootstrapViewModel::default()),
            vendors_cache: Mutex::new(Vec::new()),
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

    pub fn distro_name(&self) -> &'static str {
        FUSA_DISTRO_NAME
    }

    pub fn linux_user(&self) -> &'static str {
        FUSA_LINUX_USER
    }

    fn set_view(&self, next: BootstrapViewModel) {
        *self.view.lock().unwrap() = next.clone();
        if let Some(cb) = self.on_view_changed.lock().unwrap().clone() {
            cb(next);
        }
    }

    fn on_supervisor_snapshot(&self, snap: SupervisorSnapshot) {
        let vendors = self.vendors_cache.lock().unwrap().clone();
        let onboarding = OnboardingState::load(&self.app_data_dir);
        let next = derive_view_from_supervisor(&snap, &vendors, onboarding.completed);
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

    /// 在后台工作线程异步推进：`端口外部实例快检 -> WSL2 专用实例准备与自检 -> 动态查询厂商 CLI 状态 -> 守护进程启动与 Cookie 兑换`。
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
        // 先做一次宿主侧探活：若端口冲突或已有外部兼容 Fusa，无需先下载/导入 WSL 即可立即响应！
        let host_probe = fusa_supervisor::UreqHostHttpClient.probe_status(
            self.supervisor.port(),
            &self.contract,
        );
        if host_probe.is_port_conflict() || matches!(host_probe, fusa_supervisor::ProbeOutcome::Verified(_)) {
            let _ = self.supervisor.ensure_running();
            return;
        }

        // 推进专用 WSL2 发行版准备与沙箱隔离自检
        let prov_cfg = ProvisionConfig::new(&self.app_data_dir);
        let provisioner = Provisioner::with_defaults(prov_cfg);
        let current_stage = provisioner
            .load_state()
            .map(|s| s.stage)
            .unwrap_or(ProvisionStage::CheckWsl);
        self.set_view(BootstrapViewModel {
            tone: "working".to_string(),
            title: match current_stage {
                ProvisionStage::DownloadRootfs | ProvisionStage::ImportDistro => {
                    "Importing Fusa WSL environment…".to_string()
                }
                ProvisionStage::InitRoot
                | ProvisionStage::RestartDistro
                | ProvisionStage::InitUserAndSelfTest => {
                    "Configuring sandbox isolation…".to_string()
                }
                _ => "Checking WSL environment…".to_string(),
            },
            detail: "Preparing dedicated Ubuntu 24.04 WSL2 instance".to_string(),
            error: None,
            can_install_wsl: false,
            can_retry: false,
            can_open_logs: true,
            show_vendor_guide: false,
            can_enter_workspace: false,
            vendors: Vec::new(),
        });

        if let Err(err) = provisioner.provision_until_ready() {
            self.set_view(derive_view_from_provision_error(&err));
            return;
        }

        // 启动或复用受监管后台（内部会自动部署随包版本并兑换内存 Cookie）；
        // 在查询完 `--vendors-json` 前暂停自动跳转，避免厂商全未安装时跳过首次/登录引导。
        self.suppress_auto_nav.store(true, Ordering::SeqCst);
        let ensure_res = self.supervisor.ensure_running();
        if ensure_res.is_ok() {
            if let Ok(guides) = provisioner.query_vendor_guides(FUSA_CURRENT_RELEASE_WSL_DIR) {
                *self.vendors_cache.lock().unwrap() = guides;
            }
        }
        self.suppress_auto_nav.store(false, Ordering::SeqCst);
        if ensure_res.is_ok() {
            self.on_supervisor_snapshot(self.supervisor.snapshot());
        }
    }

    /// 记录 `InstallWslPendingReboot` 状态标记并在 Windows 上拉起提权 `wsl.exe --install --no-distribution`。
    pub fn trigger_wsl_install(&self) -> Result<BootstrapViewModel, String> {
        crate::platform::request_elevated_wsl_install()?;
        let mut st = ProvisionState::load_or_default(&self.app_data_dir, FUSA_DISTRO_NAME)
            .map_err(|e| e.to_string())?;
        st.stage = ProvisionStage::InstallWslPendingReboot;
        st.last_error = None;
        st.save_atomic(&self.app_data_dir)
            .map_err(|e| e.to_string())?;

        let view = BootstrapViewModel {
            tone: "working".to_string(),
            title: "Restart Windows after WSL finishes installing".to_string(),
            detail: "Complete the administrator prompt, restart Windows, then reopen Fusa"
                .to_string(),
            error: None,
            can_install_wsl: false,
            can_retry: true,
            can_open_logs: true,
            show_vendor_guide: false,
            can_enter_workspace: false,
            vendors: Vec::new(),
        };
        self.set_view(view.clone());
        Ok(view)
    }
}
