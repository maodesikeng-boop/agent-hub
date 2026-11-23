use fusa_supervisor::{
    truncate_chars_clean, CrashRecord, DaemonOwnership, DesktopContract, StopReason,
    SupervisorFault, SupervisorSnapshot, SupervisorState,
};

pub const MENU_ACTION_OPEN_MAIN_WINDOW: &str = "open_main_window";
pub const MENU_ACTION_RESTART_DAEMON: &str = "restart_daemon";
pub const MENU_ACTION_OPEN_LOGS: &str = "open_logs";
pub const MENU_ACTION_QUIT_APP: &str = "quit_app";

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
            SupervisorState::Idle => (
                "Preparing Bellwood…".to_string(),
                "Restart Daemon".to_string(),
                false,
            ),
            SupervisorState::Starting { .. } => (
                "Starting daemon…".to_string(),
                "Restart Daemon".to_string(),
                false,
            ),
            SupervisorState::Running { ownership, .. } => {
                if *ownership == DaemonOwnership::ExternalManaged {
                    (
                        "Daemon running (External)".to_string(),
                        "Restart Daemon (External)".to_string(),
                        false,
                    )
                } else {
                    (
                        "Daemon running".to_string(),
                        "Restart Daemon".to_string(),
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
                    format!("Daemon exited unexpectedly. Restarting in {delay_sec}s ({attempt}/{max_attempts})…"),
                    "Restart Daemon".to_string(),
                    true,
                )
            }
            SupervisorState::Stopping { reason, .. } => {
                let summary = match reason {
                    StopReason::ManualRestart => "Restarting daemon…",
                    StopReason::AppQuit => "Stopping daemon (up to 40s)…",
                };
                (summary.to_string(), "Restart Daemon".to_string(), false)
            }
            SupervisorState::Stopped => (
                "Daemon stopped".to_string(),
                "Start Daemon".to_string(),
                !is_quitting,
            ),
            SupervisorState::Faulted { fault, .. } => match fault {
                SupervisorFault::PortConflict { detail, .. } => {
                    fault_reason_title = Some(truncate_chars_clean(detail, max_chars));
                    (
                        "Daemon port conflict or incompatible protocol".to_string(),
                        "Check Daemon Again".to_string(),
                        true,
                    )
                }
                SupervisorFault::CrashLimitExceeded {
                    crashes_in_window, ..
                } => (
                    format!("Daemon stopped after {crashes_in_window} crashes"),
                    "Restart Daemon".to_string(),
                    true,
                ),
                other => {
                    fault_reason_title =
                        Some(truncate_chars_clean(&other.user_message(), max_chars));
                    (
                        "Daemon not ready".to_string(),
                        "Retry Starting Daemon".to_string(),
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
            "Quit Bellwood (Keep External Daemon)".to_string()
        } else {
            "Quit Bellwood".to_string()
        };

        let tooltip = format!("Bellwood — {summary_title}");

        Self {
            summary_title,
            fault_reason_title,
            last_crash_title,
            open_window_title: "Open Main Window".to_string(),
            restart_title,
            restart_enabled: restart_enabled && !is_stopping,
            open_logs_title: "Open Log".to_string(),
            open_logs_enabled: true,
            quit_title,
            quit_enabled: !is_quitting,
            tooltip,
        }
    }
}

pub fn format_crash_menu_line(crash: &CrashRecord, max_chars: usize) -> String {
    let total_secs = crash.occurred_at_epoch_ms / 1000;
    let day_secs = total_secs % 86_400;
    let hh = day_secs / 3600;
    let mm = (day_secs % 3600) / 60;
    let ss = day_secs % 60;
    let line = format!("Last crash {hh:02}:{mm:02}:{ss:02}: {}", crash.menu_reason);
    truncate_chars_clean(&line, max_chars)
}

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
