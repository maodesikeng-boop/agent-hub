pub mod bootstrap;
pub mod dialog_bridge;
pub mod navigation;
pub mod platform;
pub mod self_test;
pub mod tray;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use fusa_supervisor::refresh_current_process_path;
use tauri::image::Image;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::cookie::{time::Duration as CookieDuration, CookieBuilder, SameSite};
use tauri::webview::{NewWindowResponse, WebviewWindowBuilder};
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, State, Webview, WebviewUrl, WebviewWindow, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::bootstrap::{BootstrapViewModel, DesktopController};
use crate::dialog_bridge::DesktopDialogBridge;
use crate::navigation::{
    classify_navigation_url, classify_new_window_url, is_embedded_bootstrap_origin,
    NavigationDecision,
};
use crate::tray::{
    build_tauri_tray_menu, TrayMenuModel, MENU_ACTION_OPEN_LOGS, MENU_ACTION_OPEN_MAIN_WINDOW,
    MENU_ACTION_QUIT_APP, MENU_ACTION_RESTART_DAEMON,
};

const TRAY_ICON_ID: &str = "fusa-tray";
const MAIN_WINDOW_LABEL: &str = "main";
const BOOTSTRAP_STATE_EVENT: &str = "fusa://bootstrap-state";
const EMBEDDED_TRAY_PNG: &[u8] = include_bytes!("../icons/32x32.png");
const DESKTOP_DIALOG_URL_ENV: &str = "AGENT_HUB_DESKTOP_DIALOG_URL";
const DESKTOP_DIALOG_TOKEN_ENV: &str = "AGENT_HUB_DESKTOP_DIALOG_TOKEN";

fn ensure_bootstrap_caller<R: tauri::Runtime>(webview: &Webview<R>) -> Result<(), String> {
    let caller_url = webview
        .url()
        .map_err(|e| format!("Can't verify the caller's page origin: {e}"))?;
    if !is_embedded_bootstrap_origin(&caller_url) {
        return Err("Only the embedded bootstrap page may call desktop commands".to_string());
    }
    Ok(())
}

#[tauri::command]
fn get_bootstrap_state<R: tauri::Runtime>(
    webview: Webview<R>,
    controller: State<'_, Arc<DesktopController>>,
) -> Result<BootstrapViewModel, String> {
    ensure_bootstrap_caller(&webview)?;
    Ok(controller.current_view())
}

#[tauri::command]
fn retry_bootstrap<R: tauri::Runtime>(
    webview: Webview<R>,
    controller: State<'_, Arc<DesktopController>>,
) -> Result<BootstrapViewModel, String> {
    ensure_bootstrap_caller(&webview)?;
    controller.reset_navigation_flag();
    controller.spawn_bootstrap_workflow();
    Ok(controller.current_view())
}

#[tauri::command]
fn open_logs<R: tauri::Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    controller: State<'_, Arc<DesktopController>>,
) -> Result<(), String> {
    ensure_bootstrap_caller(&webview)?;
    open_log_with_app(&app, controller.supervisor.host_log_path())
}

fn open_external_url_with_app<R: tauri::Runtime>(app: &AppHandle<R>, url: &Url) {
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        return;
    }
    if app.opener().open_url(url.as_str(), None::<&str>).is_err() {
        let _ = platform::open_external_url(url);
    }
}

fn open_log_with_app<R: tauri::Runtime>(
    app: &AppHandle<R>,
    log_path: &std::path::Path,
) -> Result<(), String> {
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let target = if log_path.exists() {
        log_path
    } else {
        log_path.parent().unwrap_or(log_path)
    };
    if let Some(target_str) = target.to_str() {
        if app.opener().open_path(target_str, None::<&str>).is_ok() {
            return Ok(());
        }
    }
    platform::open_log_file_or_dir(log_path)
}

fn sync_session_cookie_to_webview<R: tauri::Runtime>(
    window: &WebviewWindow<R>,
    controller: &DesktopController,
) -> Result<(), String> {
    if let Some(sc) = controller.supervisor.session_cookie() {
        let mut builder = CookieBuilder::new(sc.name.clone(), sc.value().to_string())
            .domain("127.0.0.1")
            .path(sc.path.clone())
            .http_only(sc.http_only)
            .same_site(if sc.same_site_strict {
                SameSite::Strict
            } else {
                SameSite::Lax
            });
        if let Some(secs) = sc.max_age_secs {
            if let Ok(secs_i64) = i64::try_from(secs) {
                builder = builder.max_age(CookieDuration::seconds(secs_i64));
            }
        }
        window
            .set_cookie(builder.build())
            .map_err(|e| format!("Failed to write the local session cookie: {e}"))?;
    }
    Ok(())
}

fn inject_cookie_and_navigate_to_daemon<R: tauri::Runtime>(
    window: &WebviewWindow<R>,
    controller: &DesktopController,
) -> Result<(), String> {
    sync_session_cookie_to_webview(window, controller)?;
    let target_url = Url::parse(&format!(
        "http://127.0.0.1:{}/",
        controller.supervisor.port()
    ))
    .map_err(|e| e.to_string())?;
    window
        .navigate(target_url)
        .map_err(|e| format!("Failed to open the local workbench: {e}"))?;
    Ok(())
}

fn show_and_focus_main_window<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn refresh_tray_from_controller<R: tauri::Runtime>(
    app: &AppHandle<R>,
    controller: &DesktopController,
) {
    let Some(tray) = app.tray_by_id(TRAY_ICON_ID) else {
        return;
    };
    let snap = controller.supervisor.snapshot();
    let model = TrayMenuModel::from_snapshot(&snap, &controller.contract);
    let _ = tray.set_tooltip(Some(&model.tooltip));
    if let Ok(menu) = build_tauri_tray_menu(app, &model) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn begin_async_app_quit<R: tauri::Runtime>(
    app: &AppHandle<R>,
    controller: &Arc<DesktopController>,
    dialog_bridge: Option<&Arc<DesktopDialogBridge>>,
    quit_started: &Arc<AtomicBool>,
    quit_completed: &Arc<AtomicBool>,
) {
    if quit_started
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }

    if let Some(bridge) = dialog_bridge {
        bridge.stop();
    }

    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.hide();
    }

    let app_for_thread = app.clone();
    let ctrl_for_thread = Arc::clone(controller);
    let done_flag = Arc::clone(quit_completed);
    thread::spawn(move || {
        ctrl_for_thread.supervisor.shutdown();
        done_flag.store(true, Ordering::SeqCst);
        app_for_thread.exit(0);
    });
}

pub fn run() {
    refresh_current_process_path(&[]);

    let app_data_dir = platform::resolve_local_app_data_dir()
        .expect("Bellwood can't resolve its app data directory (LOCALAPPDATA must point to a local disk, not a network share)");
    let hub_home_dir = platform::resolve_hub_home_dir()
        .expect("Bellwood can't resolve the daemon data directory (USERPROFILE / AGENT_HUB_HOME must point to a local disk, not a network share)");

    let quit_started = Arc::new(AtomicBool::new(false));
    let quit_completed = Arc::new(AtomicBool::new(false));

    let quit_started_setup = Arc::clone(&quit_started);
    let quit_completed_setup = Arc::clone(&quit_completed);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_and_focus_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_bootstrap_state,
            retry_bootstrap,
            open_logs,
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let bridge = Arc::new(DesktopDialogBridge::start(app_handle.clone(), |h| {
                show_and_focus_main_window(h)
            })?);
            app.manage(Arc::clone(&bridge));

            let extra_envs = vec![
                (DESKTOP_DIALOG_URL_ENV.to_string(), bridge.url.clone()),
                (DESKTOP_DIALOG_TOKEN_ENV.to_string(), bridge.token.clone()),
            ];
            let resource_dir = app.path().resource_dir().ok();
            let runtime_cfg = platform::resolve_native_runtime_config(
                app_data_dir.clone(),
                hub_home_dir.clone(),
                resource_dir.as_deref(),
                extra_envs,
            )
            .map_err(std::io::Error::other)?;

            let controller = DesktopController::new(runtime_cfg).map_err(std::io::Error::other)?;
            app.manage(Arc::clone(&controller));

            let daemon_port = controller.supervisor.port();
            let app_for_nav_ext = app_handle.clone();
            let app_for_new_win = app_handle.clone();
            let main_window = WebviewWindowBuilder::new(
                app,
                MAIN_WINDOW_LABEL,
                WebviewUrl::App("index.html".into()),
            )
            .title("Bellwood")
            .inner_size(1180.0, 780.0)
            .min_inner_size(800.0, 560.0)
            .center()
            .on_navigation(move |target_url| {
                match classify_navigation_url(target_url, daemon_port) {
                    NavigationDecision::AllowInApp => true,
                    NavigationDecision::OpenExternalBrowser => {
                        open_external_url_with_app(&app_for_nav_ext, target_url);
                        false
                    }
                    NavigationDecision::Block => false,
                }
            })
            .on_new_window(move |target_url, _features| {
                if classify_new_window_url(&target_url) == NavigationDecision::OpenExternalBrowser {
                    open_external_url_with_app(&app_for_new_win, &target_url);
                }
                NewWindowResponse::Deny
            })
            .build()?;

            let bootstrap_origin_url = main_window.url().ok();

            let win_for_close = main_window.clone();
            let quit_done_for_close = Arc::clone(&quit_completed_setup);
            main_window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    if !quit_done_for_close.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = win_for_close.hide();
                    }
                }
            });

            let initial_model = TrayMenuModel::from_snapshot(
                &controller.supervisor.snapshot(),
                &controller.contract,
            );
            let initial_menu = build_tauri_tray_menu(&app_handle, &initial_model)?;
            let tray_icon_img = match app.default_window_icon().cloned() {
                Some(icon) => icon,
                None => Image::from_bytes(EMBEDDED_TRAY_PNG)?,
            };

            let ctrl_for_menu = Arc::clone(&controller);
            let bridge_for_menu = Arc::clone(&bridge);
            let quit_started_menu = Arc::clone(&quit_started_setup);
            let quit_done_menu = Arc::clone(&quit_completed_setup);
            let bootstrap_url_for_restart = bootstrap_origin_url.clone();

            TrayIconBuilder::with_id(TRAY_ICON_ID)
                .icon(tray_icon_img)
                .tooltip(&initial_model.tooltip)
                .menu(&initial_menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_and_focus_main_window(tray.app_handle());
                    }
                })
                .on_menu_event(move |app_h, event| match event.id().as_ref() {
                    MENU_ACTION_OPEN_MAIN_WINDOW => {
                        show_and_focus_main_window(app_h);
                    }
                    MENU_ACTION_RESTART_DAEMON => {
                        show_and_focus_main_window(app_h);
                        if let (Some(win), Some(url)) = (
                            app_h.get_webview_window(MAIN_WINDOW_LABEL),
                            &bootstrap_url_for_restart,
                        ) {
                            let _ = win.navigate(url.clone());
                        }
                        let ctrl = Arc::clone(&ctrl_for_menu);
                        thread::spawn(move || {
                            ctrl.reset_navigation_flag();
                            let _ = ctrl.supervisor.restart_manual();
                        });
                    }
                    MENU_ACTION_OPEN_LOGS => {
                        let _ = open_log_with_app(app_h, ctrl_for_menu.supervisor.host_log_path());
                    }
                    MENU_ACTION_QUIT_APP => {
                        begin_async_app_quit(
                            app_h,
                            &ctrl_for_menu,
                            Some(&bridge_for_menu),
                            &quit_started_menu,
                            &quit_done_menu,
                        );
                    }
                    _ => {}
                })
                .build(app)?;

            let app_for_view = app_handle.clone();
            let ctrl_for_view = Arc::clone(&controller);
            let app_for_nav = app_handle.clone();
            let ctrl_for_nav = Arc::clone(&controller);

            controller.set_callbacks(
                Arc::new(move |view| {
                    let _ = app_for_view.emit(BOOTSTRAP_STATE_EVENT, &view);
                    refresh_tray_from_controller(&app_for_view, &ctrl_for_view);
                    if view.tone == "ready" && ctrl_for_view.has_navigated_to_daemon() {
                        if let Some(win) = app_for_view.get_webview_window(MAIN_WINDOW_LABEL) {
                            let _ = sync_session_cookie_to_webview(&win, &ctrl_for_view);
                        }
                    }
                }),
                Arc::new(move || {
                    if let Some(win) = app_for_nav.get_webview_window(MAIN_WINDOW_LABEL) {
                        let _ = inject_cookie_and_navigate_to_daemon(&win, &ctrl_for_nav);
                    }
                }),
            );

            controller.spawn_bootstrap_workflow();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Failed to build the Bellwood desktop shell");

    app.run(move |app_handle, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            if !quit_completed.load(Ordering::SeqCst) {
                api.prevent_exit();
                let bridge_state = app_handle
                    .try_state::<Arc<DesktopDialogBridge>>()
                    .map(|s| Arc::clone(s.inner()));
                if let Some(ctrl) = app_handle.try_state::<Arc<DesktopController>>() {
                    begin_async_app_quit(
                        app_handle,
                        ctrl.inner(),
                        bridge_state.as_ref(),
                        &quit_started,
                        &quit_completed,
                    );
                } else {
                    quit_completed.store(true, Ordering::SeqCst);
                    app_handle.exit(0);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bootstrap::derive_view_from_supervisor;
    use fusa_supervisor::{
        CrashRecord, DaemonIdentity, DaemonOwnership, DesktopContract, StopReason, SupervisorFault,
        SupervisorSnapshot, SupervisorState,
    };
    use std::path::{Path, PathBuf};

    #[test]
    fn local_dir_validation_rejects_unc_shares_and_accepts_local_volumes() {
        assert!(
            platform::validate_local_dir(Path::new(r"C:\Users\alice\AppData\Local\Fusa")).is_ok()
        );
        assert!(platform::validate_local_dir(Path::new("/Users/alice/.agent-hub")).is_ok());
        assert!(platform::validate_local_dir(Path::new(r"\\fileserver\share\Fusa")).is_err());
        assert!(platform::validate_local_dir(Path::new(r"\\?\UNC\fileserver\share\Fusa")).is_err());
        assert!(platform::validate_local_dir(Path::new("   ")).is_err());
    }

    #[test]
    fn main_frame_stays_on_bootstrap_and_daemon_shell_pages_and_sends_other_urls_to_system_browser()
    {
        let port = 4317u16;

        for internal in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/",
        ] {
            let u = Url::parse(internal).unwrap();
            assert!(is_embedded_bootstrap_origin(&u));
            assert_eq!(
                classify_navigation_url(&u, port),
                NavigationDecision::AllowInApp
            );
        }

        for shell in [
            "about:blank",
            "http://127.0.0.1:4317/",
            "http://127.0.0.1:4317",
            "http://127.0.0.1:4317/#/c/12",
            "http://127.0.0.1:4317/auth",
            "http://127.0.0.1:4317/auth?token=abc",
        ] {
            let u = Url::parse(shell).unwrap();
            assert!(!is_embedded_bootstrap_origin(&u));
            assert_eq!(
                classify_navigation_url(&u, port),
                NavigationDecision::AllowInApp,
                "{shell}"
            );
        }

        for external in [
            "http://127.0.0.1:4317/api/sent-files/0123456789abcdef/report.html",
            "http://127.0.0.1:4317/tmp/out/report.html",
            "http://127.0.0.1:4317/d/peer-1/",
            "http://127.0.0.1:4317/project/7?tab=agents",
            "http://127.0.0.1:8080/",
            "http://localhost:3000/",
            "https://127.0.0.1:4317/",
            "http://localhost:4317/",
            "https://github.com/maodesikeng-boop/agent-hub",
            "mailto:support@example.com",
        ] {
            let u = Url::parse(external).unwrap();
            assert!(!is_embedded_bootstrap_origin(&u));
            assert_eq!(
                classify_navigation_url(&u, port),
                NavigationDecision::OpenExternalBrowser,
                "{external}"
            );
        }

        for blocked in [
            "javascript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
            "data:text/html,<h1>spoof</h1>",
        ] {
            let u = Url::parse(blocked).unwrap();
            assert!(!is_embedded_bootstrap_origin(&u));
            assert_eq!(classify_navigation_url(&u, port), NavigationDecision::Block);
        }
    }

    #[test]
    fn new_window_requests_never_open_in_app_and_send_web_links_to_system_browser() {
        for external in [
            "http://127.0.0.1:4317/",
            "http://127.0.0.1:4317/api/sent-files/0123456789abcdef/report.html",
            "http://localhost:3000/",
            "https://github.com/maodesikeng-boop/agent-hub",
            "mailto:support@example.com",
        ] {
            let u = Url::parse(external).unwrap();
            assert_eq!(
                classify_new_window_url(&u),
                NavigationDecision::OpenExternalBrowser,
                "{external}"
            );
        }
        for blocked in [
            "about:blank",
            "tauri://localhost/index.html",
            "javascript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
        ] {
            let u = Url::parse(blocked).unwrap();
            assert_eq!(
                classify_new_window_url(&u),
                NavigationDecision::Block,
                "{blocked}"
            );
        }
    }

    #[test]
    fn tray_menu_model_aligns_with_contract_external_managed_and_60_char_truncation() {
        let contract = DesktopContract::embedded().unwrap();

        for action in [
            MENU_ACTION_OPEN_MAIN_WINDOW,
            MENU_ACTION_RESTART_DAEMON,
            MENU_ACTION_OPEN_LOGS,
            MENU_ACTION_QUIT_APP,
        ] {
            assert!(contract.menu_actions.iter().any(|a| a == action));
        }

        let ext_snap = SupervisorSnapshot {
            port: 4317,
            state: SupervisorState::Running {
                ownership: DaemonOwnership::ExternalManaged,
                identity: DaemonIdentity {
                    product: "fusa".to_string(),
                    protocol_version: 1,
                    instance_id: "ext-1".to_string(),
                    status: Some("ok".to_string()),
                },
                port: 4317,
                pid: None,
                generation: 1,
            },
            ownership: DaemonOwnership::ExternalManaged,
            has_session_cookie: true,
            last_crash: None,
            host_log_path: PathBuf::from("/tmp/fusa-desktop.log"),
        };
        let ext_menu = TrayMenuModel::from_snapshot(&ext_snap, &contract);
        assert!(!ext_menu.restart_enabled);
        assert_eq!(ext_menu.restart_title, "Restart Daemon (External)");
        assert_eq!(ext_menu.quit_title, "Quit Bellwood (Keep External Daemon)");
        assert!(ext_menu.quit_enabled);

        let long_reason = "致命异常：数据库连接池初始化失败，详细调用栈位置在模块 alpha_beta_gamma_delta_epsilon_zeta_eta_theta_1234567890";
        let fault_snap = SupervisorSnapshot {
            port: 4317,
            state: SupervisorState::Faulted {
                fault: SupervisorFault::PortConflict {
                    port: 4317,
                    detail: long_reason.to_string(),
                },
                generation: 1,
            },
            ownership: DaemonOwnership::None,
            has_session_cookie: false,
            last_crash: Some(CrashRecord {
                occurred_at_epoch_ms: (14 * 3600 + 25 * 60 + 9) * 1000,
                exit_code: Some(1),
                menu_reason: long_reason.to_string(),
                stderr_tail_lines: vec![long_reason.to_string()],
            }),
            host_log_path: PathBuf::from("/tmp/fusa-desktop.log"),
        };
        let fault_menu = TrayMenuModel::from_snapshot(&fault_snap, &contract);
        let crash_line = fault_menu.last_crash_title.unwrap();
        assert!(crash_line.starts_with("Last crash 14:25:09: "));
        assert!(crash_line.chars().count() <= 60);
        let conflict_line = fault_menu.fault_reason_title.unwrap();
        assert!(conflict_line.chars().count() <= 60);

        let quitting_snap = SupervisorSnapshot {
            port: 4317,
            state: SupervisorState::Stopping {
                reason: StopReason::AppQuit,
                generation: 2,
            },
            ownership: DaemonOwnership::Owned,
            has_session_cookie: false,
            last_crash: None,
            host_log_path: PathBuf::from("/tmp/fusa-desktop.log"),
        };
        let quitting_menu = TrayMenuModel::from_snapshot(&quitting_snap, &contract);
        assert!(!quitting_menu.quit_enabled);
        assert!(!quitting_menu.restart_enabled);
    }

    #[test]
    fn bootstrap_view_transitions_directly_to_running_and_exposes_fault_recovery() {
        let running_owned = SupervisorSnapshot {
            port: 4317,
            state: SupervisorState::Running {
                ownership: DaemonOwnership::Owned,
                identity: DaemonIdentity {
                    product: "fusa".to_string(),
                    protocol_version: 1,
                    instance_id: "own-1".to_string(),
                    status: Some("ok".to_string()),
                },
                port: 4317,
                pid: Some(4200),
                generation: 1,
            },
            ownership: DaemonOwnership::Owned,
            has_session_cookie: true,
            last_crash: None,
            host_log_path: PathBuf::from("/tmp/fusa-desktop.log"),
        };

        let v_running = derive_view_from_supervisor(&running_owned);
        assert_eq!(v_running.tone, "ready");
        assert_eq!(v_running.title, "Running");
        assert!(!v_running.can_retry);
        assert!(v_running.can_open_logs);

        let faulted = SupervisorSnapshot {
            port: 4317,
            state: SupervisorState::Faulted {
                fault: SupervisorFault::PortConflict {
                    port: 4317,
                    detail: "port busy".to_string(),
                },
                generation: 1,
            },
            ownership: DaemonOwnership::None,
            has_session_cookie: false,
            last_crash: None,
            host_log_path: PathBuf::from("/tmp/fusa-desktop.log"),
        };
        let v_faulted = derive_view_from_supervisor(&faulted);
        assert_eq!(v_faulted.tone, "error");
        assert!(v_faulted.can_retry);
        assert!(v_faulted.can_open_logs);
        assert!(v_faulted.error.is_some());
    }

    #[test]
    fn bootstrap_ui_and_tauri_security_config_comply_with_standards() {
        let html = include_str!("../ui/index.html");
        let css = include_str!("../ui/styles.css");
        let js = include_str!("../ui/app.js");
        let tauri_conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let bundled_contract = include_str!("../resources/contract.json");
        let canonical_contract = include_str!("../../../../desktop/contract.json");

        assert_eq!(bundled_contract, canonical_contract);
        assert_eq!(tauri_conf["app"]["withGlobalTauri"], false);
        assert_eq!(capability["local"], true);
        assert!(capability.get("remote").is_none());

        let css_without_comments: String = css
            .split("/*")
            .enumerate()
            .map(|(i, part)| {
                if i == 0 {
                    part
                } else {
                    part.split_once("*/").map_or("", |(_, rest)| rest)
                }
            })
            .collect();
        for forbidden_css in [
            "linear-gradient",
            "radial-gradient",
            "conic-gradient",
            "backdrop-filter",
            "-webkit-backdrop-filter",
            "box-shadow",
            "text-shadow",
            "999px",
            "9999px",
        ] {
            assert!(
                !css_without_comments
                    .to_ascii_lowercase()
                    .contains(forbidden_css),
                "ui/styles.css must not use {forbidden_css}"
            );
        }

        for (name, content) in [("index.html", html), ("app.js", js)] {
            assert!(
                !content.contains('·') && !content.contains("&middot;"),
                "{name} must not join metadata with middle dot `·`"
            );
            for retired in [
                "providers-section",
                "open_vendor_terminal",
                "enter_workspace",
            ] {
                assert!(
                    !content.contains(retired),
                    "{name} must not retain retired static onboarding identifier `{retired}`"
                );
            }
            let lower = content.to_ascii_lowercase();
            assert!(
                !lower.contains("wsl"),
                "{name} must not retain retired WSL references"
            );
            for vendor_word in [
                "claude",
                "anthropic",
                "codex",
                "openai",
                "gemini",
                "antigravity",
                "deepseek",
                "cursor",
            ] {
                assert!(
                    !lower.contains(vendor_word),
                    "{name} must not hardcode vendor name `{vendor_word}`"
                );
            }
        }

        let ico = include_bytes!("../icons/icon.ico");
        assert!(ico.len() > 22);
        assert_eq!(&ico[0..4], &[0x00, 0x00, 0x01, 0x00]);
        let frame_count = u16::from_le_bytes([ico[4], ico[5]]);
        assert!(frame_count >= 4, "expected multi-resolution .ico frames");
    }

    #[test]
    fn dialog_bridge_enforces_loopback_bearer_auth_413_limit_and_409_concurrency() {
        use std::io::{Read, Write};
        use std::net::TcpStream;
        use std::sync::{Arc, Barrier};

        let bridge = DesktopDialogBridge::start_with_handler(|start_dir| {
            Some(start_dir.unwrap_or_else(|| r"C:\Picked\Default".to_string()))
        })
        .unwrap();
        assert!(bridge.url.starts_with("http://127.0.0.1:"));
        let addr_str = bridge
            .url
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap()
            .to_string();

        let send_raw = |raw: &[u8]| -> String {
            let mut s = TcpStream::connect(&addr_str).unwrap();
            s.write_all(raw).unwrap();
            s.flush().unwrap();
            let mut out = String::new();
            let _ = s.read_to_string(&mut out);
            out
        };

        let opt_resp = send_raw(b"OPTIONS /pick-folder HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        assert!(opt_resp.starts_with("HTTP/1.1 404"));
        assert!(!opt_resp
            .to_ascii_lowercase()
            .contains("access-control-allow-origin"));

        let unauth = send_raw(
            b"POST /pick-folder HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\n\r\n{}",
        );
        assert!(unauth.starts_with("HTTP/1.1 401"));
        let upper_tok = bridge.token.to_ascii_uppercase();
        let case_tampered = format!(
            "POST /pick-folder HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {upper_tok}\r\nContent-Length: 2\r\n\r\n{{}}"
        );
        assert!(send_raw(case_tampered.as_bytes()).starts_with("HTTP/1.1 401"));

        let big_body = format!(r#"{{"startDir":"{}"}}"#, "a".repeat(9000));
        let big_req = format!(
            "POST /pick-folder HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\n\r\n{}",
            bridge.token,
            big_body.len(),
            big_body
        );
        assert!(send_raw(big_req.as_bytes()).starts_with("HTTP/1.1 413"));

        let ok_body = r#"{"startDir":"D:\\Repo"}"#;
        let ok_req = format!(
            "POST /pick-folder HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: bearer {}\r\nContent-Length: {}\r\n\r\n{}",
            bridge.token,
            ok_body.len(),
            ok_body
        );
        let ok_resp = send_raw(ok_req.as_bytes());
        assert!(ok_resp.starts_with("HTTP/1.1 200"));
        assert!(ok_resp.contains(r#"{"path":"D:\\Repo"}"#));
        bridge.stop();

        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let entered_w = Arc::clone(&entered);
        let release_w = Arc::clone(&release);
        let slow_bridge = DesktopDialogBridge::start_with_handler(move |_| {
            entered_w.wait();
            release_w.wait();
            Some("done".to_string())
        })
        .unwrap();
        let slow_addr = slow_bridge
            .url
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap()
            .to_string();
        let slow_tok = slow_bridge.token.clone();
        let slow_addr_t1 = slow_addr.clone();
        let slow_tok_t1 = slow_tok.clone();
        let t1 = std::thread::spawn(move || {
            let mut s = TcpStream::connect(&slow_addr_t1).unwrap();
            let req = format!(
                "POST /pick-folder HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {slow_tok_t1}\r\nContent-Length: 2\r\n\r\n{{}}"
            );
            s.write_all(req.as_bytes()).unwrap();
            let mut out = String::new();
            let _ = s.read_to_string(&mut out);
            out
        });
        entered.wait();

        let mut s2 = TcpStream::connect(&slow_addr).unwrap();
        let req2 = format!(
            "POST /pick-folder HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {slow_tok}\r\nContent-Length: 2\r\n\r\n{{}}"
        );
        s2.write_all(req2.as_bytes()).unwrap();
        let mut resp2 = String::new();
        let _ = s2.read_to_string(&mut resp2);
        assert!(resp2.starts_with("HTTP/1.1 409"));

        release.wait();
        assert!(t1.join().unwrap().starts_with("HTTP/1.1 200"));
        slow_bridge.stop();
    }

    #[test]
    fn dialog_bridge_413_response_survives_request_body_sent_after_the_response() {
        use std::io::{Read, Write};
        use std::net::TcpStream;
        use std::time::Duration;

        let bridge = DesktopDialogBridge::start_with_handler(|_| None).unwrap();
        let addr = bridge
            .url
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap()
            .to_string();

        for attempt in 0..20 {
            let mut s = TcpStream::connect(&addr).unwrap();
            s.set_nodelay(true).unwrap();
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let head = format!(
                "POST /pick-folder HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nContent-Length: 1000000\r\n\r\n",
                bridge.token
            );
            s.write_all(head.as_bytes()).unwrap();
            s.flush().unwrap();

            std::thread::sleep(Duration::from_millis(10));
            let body_chunk = [b'a'; 16 * 1024];
            let _ = s.write_all(&body_chunk);
            std::thread::sleep(Duration::from_millis(10));

            let mut raw = Vec::new();
            let mut chunk = [0u8; 1024];
            let read_result = loop {
                match s.read(&mut chunk) {
                    Ok(0) => break Ok(()),
                    Ok(n) => raw.extend_from_slice(&chunk[..n]),
                    Err(e) => break Err(e),
                }
            };
            let resp = String::from_utf8_lossy(&raw);
            assert!(
                read_result.is_ok(),
                "attempt {attempt}: reading the 413 response failed with {read_result:?}; got {resp:?}"
            );
            assert!(
                resp.starts_with("HTTP/1.1 413")
                    && resp.contains(r#"{"error":"payload_too_large"}"#),
                "attempt {attempt}: expected a complete 413 response, got {resp:?}"
            );
        }
        bridge.stop();
    }

    #[test]
    fn dialog_bridge_413_linger_drain_bounds_stalled_and_flooding_clients_and_preserves_normal_200_path(
    ) {
        use std::io::{Read, Write};
        use std::net::TcpStream;
        use std::time::{Duration, Instant};

        fn read_framed_http_response(stream: &mut TcpStream) -> String {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 1024];
            let mut total_needed = None;
            loop {
                if let Some(needed) = total_needed {
                    if buf.len() >= needed {
                        break;
                    }
                }
                let n = stream.read(&mut chunk).unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                if total_needed.is_none() {
                    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let end = pos + 4;
                        let hdr = String::from_utf8_lossy(&buf[..end]).to_ascii_lowercase();
                        let cl = hdr
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .and_then(|v| v.trim().parse::<usize>().ok())
                            .unwrap_or(0);
                        total_needed = Some(end + cl);
                    }
                }
            }
            String::from_utf8_lossy(&buf).into_owned()
        }

        let bridge =
            DesktopDialogBridge::start_with_handler(|_| Some(r"C:\Picked\Ok".to_string())).unwrap();
        let addr = bridge
            .url
            .strip_prefix("http://")
            .unwrap()
            .split('/')
            .next()
            .unwrap()
            .to_string();

        let ok_req = format!(
            "POST /pick-folder HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nContent-Length: 2\r\n\r\n{{}}",
            bridge.token
        );
        let mut s_keep = TcpStream::connect(&addr).unwrap();
        s_keep
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        s_keep.write_all(ok_req.as_bytes()).unwrap();
        let first_ok = read_framed_http_response(&mut s_keep);
        assert!(first_ok.starts_with("HTTP/1.1 200"), "got {first_ok:?}");

        let t_normal = Instant::now();
        let mut s_second = TcpStream::connect(&addr).unwrap();
        s_second
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        s_second.write_all(ok_req.as_bytes()).unwrap();
        let second_ok = read_framed_http_response(&mut s_second);
        let normal_elapsed = t_normal.elapsed();
        assert!(
            second_ok.starts_with("HTTP/1.1 200"),
            "holding previous 200 socket open must not cause 409 busy; got {second_ok:?}"
        );
        assert!(
            normal_elapsed < Duration::from_millis(300),
            "normal 200 path must not trigger 500ms linger drain (took {normal_elapsed:?})"
        );
        drop(s_second);
        drop(s_keep);

        let mut s_stalled = TcpStream::connect(&addr).unwrap();
        s_stalled
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let big_head = format!(
            "POST /pick-folder HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nContent-Length: 1000000\r\n\r\n",
            bridge.token
        );
        s_stalled.write_all(big_head.as_bytes()).unwrap();
        let stalled_resp = read_framed_http_response(&mut s_stalled);
        assert!(
            stalled_resp.starts_with("HTTP/1.1 413"),
            "got {stalled_resp:?}"
        );

        let t0 = Instant::now();
        let mut s_after_stall = TcpStream::connect(&addr).unwrap();
        s_after_stall
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        s_after_stall.write_all(ok_req.as_bytes()).unwrap();
        let after_stall_resp = read_framed_http_response(&mut s_after_stall);
        let stall_recovery = t0.elapsed();
        assert!(
            after_stall_resp.starts_with("HTTP/1.1 200"),
            "got {after_stall_resp:?}"
        );
        assert!(
            stall_recovery < Duration::from_secs(2),
            "accept loop took {stall_recovery:?} after stalled 413 client (expected ~500ms linger cap, not 5s read timeout)"
        );
        drop(s_after_stall);
        drop(s_stalled);

        let total_flood: usize = 64 * 1024 * 1024;
        let mut s_flood = TcpStream::connect(&addr).unwrap();
        s_flood
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        s_flood
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let flood_head = format!(
            "POST /pick-folder HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nContent-Length: {total_flood}\r\n\r\n",
            bridge.token
        );
        s_flood.write_all(flood_head.as_bytes()).unwrap();
        let flood_resp = read_framed_http_response(&mut s_flood);
        assert!(flood_resp.starts_with("HTTP/1.1 413"), "got {flood_resp:?}");
        let block = [b'x'; 16 * 1024];
        let mut written = 0usize;
        while written < total_flood {
            match s_flood.write_all(&block) {
                Ok(()) => written += block.len(),
                Err(_) => break,
            }
        }
        assert!(
            written < total_flood,
            "byte cap must close before draining all {total_flood} bytes (wrote {written})"
        );
        drop(s_flood);

        let mut s_after_flood = TcpStream::connect(&addr).unwrap();
        s_after_flood
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        s_after_flood.write_all(ok_req.as_bytes()).unwrap();
        assert!(read_framed_http_response(&mut s_after_flood).starts_with("HTTP/1.1 200"));

        bridge.stop();
    }

    #[test]
    fn normalize_hub_home_override_aligns_tilde_and_trailing_slashes_with_node() {
        let home = Path::new(r"C:\Users\Alice");
        let cwd = Path::new(r"D:\Work");
        let p_tilde =
            platform::normalize_hub_home_override(r"~\.agent-hub\", Some(home), Some(cwd));
        assert_eq!(
            fusa_supervisor::data_dir_pipe_hash(&p_tilde.to_string_lossy()),
            "6e74bd83902c"
        );
        let p_rel = platform::normalize_hub_home_override("fusa-local/", Some(home), Some(cwd));
        assert!(p_rel.to_string_lossy().contains("Work"));
        assert!(!p_rel.to_string_lossy().ends_with('/'));
    }
}
