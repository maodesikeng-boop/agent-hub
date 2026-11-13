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
    classify_navigation_url, is_embedded_bootstrap_origin, NavigationDecision,
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
        .map_err(|e| format!("无法校验调用方页面来源：{e}"))?;
    if !is_embedded_bootstrap_origin(&caller_url) {
        return Err("拒绝非内嵌引导页调用本地桌面命令".to_string());
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
fn open_vendor_terminal<R: tauri::Runtime>(webview: Webview<R>) -> Result<(), String> {
    ensure_bootstrap_caller(&webview)?;
    platform::spawn_interactive_native_terminal()
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

#[tauri::command]
fn enter_workspace<R: tauri::Runtime>(
    webview: Webview<R>,
    controller: State<'_, Arc<DesktopController>>,
) -> Result<(), String> {
    ensure_bootstrap_caller(&webview)?;
    controller.trigger_navigate_to_workspace();
    Ok(())
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

fn inject_cookie_and_navigate_to_daemon<R: tauri::Runtime>(
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
            .map_err(|e| format!("写入本地会话 Cookie 失败：{e}"))?;
    }

    let target_url = Url::parse(&format!("http://127.0.0.1:{}/", controller.supervisor.port()))
        .map_err(|e| e.to_string())?;
    window
        .navigate(target_url)
        .map_err(|e| format!("导航至本地工作台失败：{e}"))?;
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
        .expect("Fusa 无法解析本地应用数据目录（请确认 LOCALAPPDATA 指向本机磁盘而非网络共享路径）");
    let hub_home_dir = platform::resolve_hub_home_dir()
        .expect("Fusa 无法解析守护进程数据目录（请确认 USERPROFILE / AGENT_HUB_HOME 指向本机磁盘而非网络共享路径）");

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
            open_vendor_terminal,
            open_logs,
            enter_workspace,
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let bridge = Arc::new(DesktopDialogBridge::start(
                app_handle.clone(),
                |h| show_and_focus_main_window(h),
            )?);
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

            let controller =
                DesktopController::new(runtime_cfg).map_err(std::io::Error::other)?;
            app.manage(Arc::clone(&controller));

            let daemon_port = controller.supervisor.port();
            let app_for_nav_ext = app_handle.clone();
            let app_for_new_win = app_handle.clone();
            let main_window = WebviewWindowBuilder::new(
                app,
                MAIN_WINDOW_LABEL,
                WebviewUrl::App("index.html".into()),
            )
            .title("Fusa")
            .inner_size(1180.0, 780.0)
            .min_inner_size(800.0, 560.0)
            .center()
            .on_navigation(move |target_url| match classify_navigation_url(target_url, daemon_port)
            {
                NavigationDecision::AllowInApp => true,
                NavigationDecision::OpenExternalBrowser => {
                    open_external_url_with_app(&app_for_nav_ext, target_url);
                    false
                }
                NavigationDecision::Block => false,
            })
            .on_new_window(move |target_url, _features| {
                match classify_navigation_url(&target_url, daemon_port) {
                    NavigationDecision::AllowInApp => NewWindowResponse::Allow,
                    NavigationDecision::OpenExternalBrowser => {
                        open_external_url_with_app(&app_for_new_win, &target_url);
                        NewWindowResponse::Deny
                    }
                    NavigationDecision::Block => NewWindowResponse::Deny,
                }
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
        .expect("构建 Fusa 桌面外壳失败");

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
    use crate::bootstrap::{
        derive_view_from_supervisor, DesktopPreflightSummary, VendorGuideEntry,
    };
    use fusa_supervisor::{
        CrashRecord, DaemonIdentity, DaemonOwnership, DesktopContract, StopReason, SupervisorFault,
        SupervisorSnapshot, SupervisorState,
    };
    use std::path::{Path, PathBuf};

    #[test]
    fn local_dir_validation_rejects_unc_shares_and_accepts_local_volumes() {
        assert!(platform::validate_local_dir(Path::new(r"C:\Users\alice\AppData\Local\Fusa")).is_ok());
        assert!(platform::validate_local_dir(Path::new("/Users/alice/.agent-hub")).is_ok());
        assert!(platform::validate_local_dir(Path::new(r"\\fileserver\share\Fusa")).is_err());
        assert!(platform::validate_local_dir(Path::new(r"\\?\UNC\fileserver\share\Fusa")).is_err());
        assert!(platform::validate_local_dir(Path::new("   ")).is_err());
    }

    #[test]
    fn navigation_whitelist_allows_bootstrap_and_daemon_port_only_and_intercepts_external_urls() {
        let port = 4317u16;

        for internal in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/",
        ] {
            let u = Url::parse(internal).unwrap();
            assert!(is_embedded_bootstrap_origin(&u));
            assert_eq!(classify_navigation_url(&u, port), NavigationDecision::AllowInApp);
        }

        let daemon_root = Url::parse("http://127.0.0.1:4317/").unwrap();
        let daemon_deep = Url::parse("http://127.0.0.1:4317/project/7?tab=agents").unwrap();
        assert!(!is_embedded_bootstrap_origin(&daemon_root));
        assert!(!is_embedded_bootstrap_origin(&daemon_deep));
        assert_eq!(classify_navigation_url(&daemon_root, port), NavigationDecision::AllowInApp);
        assert_eq!(classify_navigation_url(&daemon_deep, port), NavigationDecision::AllowInApp);

        for external in [
            "http://127.0.0.1:8080/",
            "https://127.0.0.1:4317/",
            "http://localhost:4317/",
            "https://github.com/maodesikeng-boop/agent-hub",
            "mailto:support@example.com",
        ] {
            let u = Url::parse(external).unwrap();
            assert!(!is_embedded_bootstrap_origin(&u));
            assert_eq!(
                classify_navigation_url(&u, port),
                NavigationDecision::OpenExternalBrowser
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
        assert_eq!(ext_menu.restart_title, "重启后台服务（外部管理）");
        assert_eq!(ext_menu.quit_title, "退出 Fusa（保留外部后台）");
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
        assert!(crash_line.starts_with("上次崩溃 14:25:09："));
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
    fn bootstrap_view_guides_missing_git_and_dynamic_vendors_without_blocking_continue() {
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

        let preflight_missing_git = DesktopPreflightSummary {
            git_installed: false,
            git_path: None,
            git_install_command: "winget install --id Git.Git -e --source winget".to_string(),
            vendors: vec![VendorGuideEntry {
                id: "sample-vendor-a".to_string(),
                label: "Sample Vendor A".to_string(),
                command: "vendor-a-cli".to_string(),
                install_command: "npm install -g @example/vendor-a".to_string(),
                login_command: "vendor-a-cli auth login".to_string(),
                installed: true,
                binary_path: Some(r"C:\Users\u\.local\bin\vendor-a-cli.exe".to_string()),
            }],
        };

        let v_first = derive_view_from_supervisor(&running_owned, &preflight_missing_git, false);
        assert!(v_first.show_git_guide);
        assert!(v_first.show_vendor_guide);
        assert!(v_first.can_enter_workspace);

        let v_after_continue =
            derive_view_from_supervisor(&running_owned, &preflight_missing_git, true);
        assert!(!v_after_continue.show_git_guide);
        assert!(!v_after_continue.show_vendor_guide);
        assert!(v_after_continue.can_enter_workspace);
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
}
