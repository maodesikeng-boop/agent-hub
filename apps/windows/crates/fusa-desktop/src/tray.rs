use fusa_supervisor::{
    truncate_chars_clean, CrashRecord, DaemonOwnership, DesktopContract, StopReason,
    SupervisorFault, SupervisorSnapshot, SupervisorState,
};

pub const MENU_ACTION_OPEN_MAIN_WINDOW: &str = "open_main_window";
pub const MENU_ACTION_RESTART_DAEMON: &str = "restart_daemon";
pub const MENU_ACTION_OPEN_LOGS: &str = "open_logs";
pub const MENU_ACTION_QUIT_APP: &str = "quit_app";

/// 可跨平台 100% 单测的系统托盘菜单纯数据视图（对齐 `apps/desktop/contract.json` 与 Mac `StatusBarController.swift`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayMenuModel {
    pub summary_title: String,
    pub fault_reason_title: Option<String>,
    pub last_crash_title: Option<String>,
    pub open_window_title: String,
    pub restart_title: String,
    pub restart_enabled: bool,
    pub open_logs_title: String,
    pub open_logs_enabled: bool,
    pub quit_title: String,
    pub quit_enabled: bool,
    pub tooltip: String,
}

impl TrayMenuModel {
    pub fn from_snapshot(snapshot: &SupervisorSnapshot, contract: &DesktopContract) -> Self {
        let max_chars = contract.menu_reason_max_chars;
        let is_external = snapshot.ownership == DaemonOwnership::ExternalManaged;
        let is_quitting = matches!(
            snapshot.state,
            SupervisorState::Stopping {
                reason: StopReason::AppQuit,
                ..
            }
        );
        let is_stopping = matches!(snapshot.state, SupervisorState::Stopping { .. });

        let mut fault_reason_title = None;

        let (summary_title, restart_title, restart_enabled) = match &snapshot.state {
            SupervisorState::Idle => ("正在准备 Fusa 环境…".to_string(), "重启后台服务".to_string(), false),
            SupervisorState::Starting { is_cold_start, .. } => {
                let text = if *is_cold_start {
                    "正在冷启动 WSL 与后台服务…"
                } else {
                    "正在启动后台服务…"
                };
                (text.to_string(), "重启后台服务".to_string(), false)
            }
            SupervisorState::Running { ownership, .. } => {
                if *ownership == DaemonOwnership::ExternalManaged {
                    (
                        "后台服务运行中（外部管理）".to_string(),
                        "重启后台服务（外部管理）".to_string(),
                        false,
                    )
                } else {
                    (
                        "后台服务运行中".to_string(),
                        "重启后台服务".to_string(),
                        true,
                    )
                }
            }
            SupervisorState::BackingOff {
                attempt,
                max_attempts,
                delay_ms,
                ..
            } => {
                let delay_sec = (*delay_ms).div_ceil(1000).max(1);
                (
                    format!("后台意外退出，{delay_sec} 秒后自动重启（{attempt}/{max_attempts}）…"),
                    "重启后台服务".to_string(),
                    true,
                )
            }
            SupervisorState::Stopping { reason, .. } => {
                let summary = match reason {
                    StopReason::ManualRestart => "正在优雅重启后台服务…",
                    StopReason::AppQuit => "正在优雅停止后台服务（最多 40 秒）…",
                };
                (summary.to_string(), "重启后台服务".to_string(), false)
            }
            SupervisorState::Stopped => (
                "后台服务已停止".to_string(),
                "启动后台服务".to_string(),
                !is_quitting,
            ),
            SupervisorState::Faulted { fault, .. } => match fault {
                SupervisorFault::PortConflict { detail, .. } => {
                    fault_reason_title = Some(truncate_chars_clean(detail, max_chars));
                    (
                        "后台端口冲突或协议不兼容".to_string(),
                        "重新检测后台服务".to_string(),
                        true,
                    )
                }
                SupervisorFault::CrashLimitExceeded {
                    crashes_in_window, ..
                } => (
                    format!("后台服务异常停止（连续崩溃 {crashes_in_window} 次，已停止重试）"),
                    "重启后台服务".to_string(),
                    true,
                ),
                other => {
                    fault_reason_title =
                        Some(truncate_chars_clean(&other.user_message(), max_chars));
                    (
                        "后台服务未就绪".to_string(),
                        "重试启动后台服务".to_string(),
                        true,
                    )
                }
            },
        };

        let last_crash_title = snapshot
            .last_crash
            .as_ref()
            .map(|c| format_crash_menu_line(c, max_chars));

        let quit_title = if is_external {
            "退出 Fusa（保留外部后台）".to_string()
        } else {
            "彻底退出 Fusa".to_string()
        };

        let tooltip = format!("Fusa — {summary_title}");

        Self {
            summary_title,
            fault_reason_title,
            last_crash_title,
            open_window_title: "打开主窗口".to_string(),
            restart_title,
            restart_enabled: restart_enabled && !is_stopping,
            open_logs_title: "打开日志".to_string(),
            open_logs_enabled: true,
            quit_title,
            quit_enabled: !is_quitting,
            tooltip,
        }
    }
}

/// 格式化上次崩溃时间（UTC `HH:MM:SS`）与原因摘要，整行严格不超过 `max_chars`（60 字）。
pub fn format_crash_menu_line(crash: &CrashRecord, max_chars: usize) -> String {
    let total_secs = crash.occurred_at_epoch_ms / 1000;
    let day_secs = total_secs % 86_400;
    let hh = day_secs / 3600;
    let mm = (day_secs % 3600) / 60;
    let ss = day_secs % 60;
    let line = format!("上次崩溃 {hh:02}:{mm:02}:{ss:02}：{}", crash.menu_reason);
    truncate_chars_clean(&line, max_chars)
}

/// 根据 `TrayMenuModel` 构建 Tauri 原生托盘菜单。
pub fn build_tauri_tray_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    model: &TrayMenuModel,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};

    let menu = Menu::new(app)?;

    let summary_item = MenuItem::with_id(
        app,
        "status_summary",
        &model.summary_title,
        false,
        None::<&str>,
    )?;
    menu.append(&summary_item)?;

    if let Some(conflict_text) = &model.fault_reason_title {
        let fault_item =
            MenuItem::with_id(app, "fault_reason", conflict_text, false, None::<&str>)?;
        menu.append(&fault_item)?;
    }

    if let Some(crash_text) = &model.last_crash_title {
        let crash_item = MenuItem::with_id(app, "last_crash", crash_text, false, None::<&str>)?;
        menu.append(&crash_item)?;
    }

    menu.append(&PredefinedMenuItem::separator(app)?)?;

    let open_win = MenuItem::with_id(
        app,
        MENU_ACTION_OPEN_MAIN_WINDOW,
        &model.open_window_title,
        true,
        None::<&str>,
    )?;
    menu.append(&open_win)?;

    let restart_item = MenuItem::with_id(
        app,
        MENU_ACTION_RESTART_DAEMON,
        &model.restart_title,
        model.restart_enabled,
        None::<&str>,
    )?;
    menu.append(&restart_item)?;

    let logs_item = MenuItem::with_id(
        app,
        MENU_ACTION_OPEN_LOGS,
        &model.open_logs_title,
        model.open_logs_enabled,
        None::<&str>,
    )?;
    menu.append(&logs_item)?;

    menu.append(&PredefinedMenuItem::separator(app)?)?;

    let quit_item = MenuItem::with_id(
        app,
        MENU_ACTION_QUIT_APP,
        &model.quit_title,
        model.quit_enabled,
        None::<&str>,
    )?;
    menu.append(&quit_item)?;

    Ok(menu)
}
