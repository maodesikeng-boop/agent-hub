pub mod bootstrap;
pub mod navigation;
pub mod platform;
pub mod tray;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use tauri::image::Image;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::cookie::{time::Duration as CookieDuration, CookieBuilder, SameSite};
use tauri::webview::{NewWindowResponse, WebviewWindowBuilder};
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, State, Webview, WebviewUrl, WebviewWindow, WindowEvent,
};
use url::Url;

use crate::bootstrap::{BootstrapViewModel, DesktopController};
use crate::navigation::{classify_navigation_url, is_embedded_bootstrap_origin, NavigationDecision};
use crate::tray::{
    build_tauri_tray_menu, TrayMenuModel, MENU_ACTION_OPEN_LOGS, MENU_ACTION_OPEN_MAIN_WINDOW,
    MENU_ACTION_QUIT_APP, MENU_ACTION_RESTART_DAEMON,
};

const TRAY_ICON_ID: &str = "fusa-tray";
const MAIN_WINDOW_LABEL: &str = "main";
const BOOTSTRAP_STATE_EVENT: &str = "fusa://bootstrap-state";
const BUNDLED_RELEASE_FILENAME: &str = "fusa-release.tar.gz";
const EMBEDDED_TRAY_PNG: &[u8] = include_bytes!("../icons/32x32.png");

/// 纵深防御：除 `capabilities/default.json` 仅对 `local: true` 授权外，
/// 在每个 Tauri command 入口再次校验调用方 URL 必须是内嵌引导页源，绝不对 `127.0.0.1` 或外部页面开放任何本地命令。
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
fn install_wsl_component<R: tauri::Runtime>(
    webview: Webview<R>,
    controller: State<'_, Arc<DesktopController>>,
) -> Result<BootstrapViewModel, String> {
    ensure_bootstrap_caller(&webview)?;
    controller.trigger_wsl_install()
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
fn open_vendor_terminal<R: tauri::Runtime>(
    webview: Webview<R>,
    controller: State<'_, Arc<DesktopController>>,
) -> Result<(), String> {
    ensure_bootstrap_caller(&webview)?;
    platform::spawn_interactive_wsl_terminal(controller.distro_name(), controller.linux_user())
}

#[tauri::command]
fn open_logs<R: tauri::Runtime>(
    webview: Webview<R>,
    controller: State<'_, Arc<DesktopController>>,
) -> Result<(), String> {
    ensure_bootstrap_caller(&webview)?;
    platform::open_log_file_or_dir(controller.supervisor.host_log_path())
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

/// 将仅保存在 Rust 内存中的会话 Cookie 写入当前 WebView2 实例，随后导航至 `http://127.0.0.1:<port>/`。
/// 令牌与 Cookie 值绝不拼入 URL、命令行参数、日志或前端 JS 全局变量。
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

/// 在独立后台线程执行最多 40 秒的受监管优雅退出，严禁在 GUI 主线程同步 sleep 阻塞窗口消息循环。
fn begin_async_app_quit<R: tauri::Runtime>(
    app: &AppHandle<R>,
    controller: &Arc<DesktopController>,
    quit_started: &Arc<AtomicBool>,
    quit_completed: &Arc<AtomicBool>,
) {
    if quit_started
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
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

fn resolve_bundled_release<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<(String, PathBuf)> {
    let resource_dir = app.path().resource_dir().ok()?;
    let candidates = [
        resource_dir.join(BUNDLED_RELEASE_FILENAME),
        resource_dir.join("resources").join(BUNDLED_RELEASE_FILENAME),
    ];
    for candidate in candidates {
        if candidate.is_file() {
            return Some((env!("CARGO_PKG_VERSION").to_string(), candidate));
        }
    }
    None
}

/// 启动 Tauri 2 Windows 桌面外壳。
pub fn run() {
    let app_data_dir = platform::resolve_local_app_data_dir()
        .expect("Fusa 无法解析本地应用数据目录（请确认 LOCALAPPDATA 指向本机磁盘而非网络共享路径）");

    let quit_started = Arc::new(AtomicBool::new(false));
    let quit_completed = Arc::new(AtomicBool::new(false));

    let quit_started_setup = Arc::clone(&quit_started);
    let quit_completed_setup = Arc::clone(&quit_completed);

    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_bootstrap_state,
            install_wsl_component,
            retry_bootstrap,
            open_vendor_terminal,
            open_logs,
            enter_workspace,
        ])
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let bundled_release = resolve_bundled_release(&app_handle);
            let controller = DesktopController::new(app_data_dir.clone(), bundled_release)
                .map_err(|e| std::io::Error::other(e))?;
            app.manage(Arc::clone(&controller));

            let daemon_port = controller.supervisor.port();
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
                    let _ = platform::open_external_url(target_url);
                    false
                }
                NavigationDecision::Block => false,
            })
            .on_new_window(move |target_url, _features| {
                match classify_navigation_url(&target_url, daemon_port) {
                    NavigationDecision::AllowInApp => NewWindowResponse::Allow,
                    NavigationDecision::OpenExternalBrowser => {
                        let _ = platform::open_external_url(&target_url);
                        NewWindowResponse::Deny
                    }
                    NavigationDecision::Block => NewWindowResponse::Deny,
                }
            })
            .build()?;

            let bootstrap_origin_url = main_window.url().ok();

            // 点击窗口右上角关闭按钮：仅隐藏主窗口到系统托盘，不关闭后台守护进程。
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

            // 构建系统托盘图标与菜单（对齐 apps/desktop/contract.json 与 Mac StatusBarController）。
            let initial_model =
                TrayMenuModel::from_snapshot(&controller.supervisor.snapshot(), &controller.contract);
            let initial_menu = build_tauri_tray_menu(&app_handle, &initial_model)?;
            let tray_icon_img = match app.default_window_icon().cloned() {
                Some(icon) => icon,
                None => Image::from_bytes(EMBEDDED_TRAY_PNG)?,
            };

            let ctrl_for_menu = Arc::clone(&controller);
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
                        if let (Some(win), Some(url)) =
                            (app_h.get_webview_window(MAIN_WINDOW_LABEL), &bootstrap_url_for_restart)
                        {
                            let _ = win.navigate(url.clone());
                        }
                        let ctrl = Arc::clone(&ctrl_for_menu);
                        thread::spawn(move || {
                            ctrl.reset_navigation_flag();
                            let _ = ctrl.supervisor.restart_manual();
                        });
                    }
                    MENU_ACTION_OPEN_LOGS => {
                        let _ =
                            platform::open_log_file_or_dir(ctrl_for_menu.supervisor.host_log_path());
                    }
                    MENU_ACTION_QUIT_APP => {
                        begin_async_app_quit(
                            app_h,
                            &ctrl_for_menu,
                            &quit_started_menu,
                            &quit_done_menu,
                        );
                    }
                    _ => {}
                })
                .build(app)?;

            // 绑定后台状态变更回调：推送本地引导页事件、刷新系统托盘菜单，并在准备就绪时注入 Cookie 进入工作台。
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

            // 异步拉起 WSL2 检测/准备与守护进程起停监管，主窗口在 ≤1s 内立即显示本地引导视图。
            controller.spawn_bootstrap_workflow();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 Fusa 桌面外壳失败");

    app.run(move |app_handle, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            if !quit_completed.load(Ordering::SeqCst) {
                api.prevent_exit();
                if let Some(ctrl) = app_handle.try_state::<Arc<DesktopController>>() {
                    begin_async_app_quit(app_handle, ctrl.inner(), &quit_started, &quit_completed);
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
    use crate::bootstrap::{derive_view_from_provision_error, derive_view_from_supervisor};
    use fusa_supervisor::{
        CrashRecord, DaemonIdentity, DaemonOwnership, DesktopContract, StopReason, SupervisorFault,
        SupervisorSnapshot, SupervisorState,
    };
    use fusa_wsl::{ProvisionError, VendorGuideEntry};

    #[test]
    fn navigation_whitelist_allows_bootstrap_and_daemon_port_only_and_intercepts_external_urls() {
        let port = 4317u16;

        // 1. 内嵌本地引导页允许在应用窗口内加载，且被识别为合法的引导命令调用方
        for internal in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/",
        ] {
            let u = Url::parse(internal).unwrap();
            assert!(
                is_embedded_bootstrap_origin(&u),
                "expected {internal} to be bootstrap origin"
            );
            assert_eq!(
                classify_navigation_url(&u, port),
                NavigationDecision::AllowInApp
            );
        }

        // 2. 本机受监管端口 http://127.0.0.1:4317 允许在窗口内加载，但绝不允许调用本地引导 Tauri command
        let daemon_root = Url::parse("http://127.0.0.1:4317/").unwrap();
        let daemon_deep = Url::parse("http://127.0.0.1:4317/project/7?tab=agents").unwrap();
        assert!(!is_embedded_bootstrap_origin(&daemon_root));
        assert!(!is_embedded_bootstrap_origin(&daemon_deep));
        assert_eq!(
            classify_navigation_url(&daemon_root, port),
            NavigationDecision::AllowInApp
        );
        assert_eq!(
            classify_navigation_url(&daemon_deep, port),
            NavigationDecision::AllowInApp
        );

        // 3. 其他端口、localhost 别名或任意公网链接一律拦截并转交系统默认浏览器打开
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
                NavigationDecision::OpenExternalBrowser,
                "expected {external} to open in external browser"
            );
        }

        // 4. 危险或非预期协议一律直接拦截拒绝
        for blocked in [
            "javascript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
            "data:text/html,<h1>spoof</h1>",
        ] {
            let u = Url::parse(blocked).unwrap();
            assert!(!is_embedded_bootstrap_origin(&u));
            assert_eq!(
                classify_navigation_url(&u, port),
                NavigationDecision::Block,
                "expected {blocked} to be blocked"
            );
        }
    }

    #[test]
    fn tray_menu_model_aligns_with_contract_external_managed_and_60_char_truncation() {
        let contract = DesktopContract::embedded().unwrap();

        // 校验托盘动作 ID 与 apps/desktop/contract.json 完全一致
        for action in [
            MENU_ACTION_OPEN_MAIN_WINDOW,
            MENU_ACTION_RESTART_DAEMON,
            MENU_ACTION_OPEN_LOGS,
            MENU_ACTION_QUIT_APP,
        ] {
            assert!(
                contract.menu_actions.iter().any(|a| a == action),
                "missing menu action {action} in contract.json"
            );
        }

        // 1. 外部兼容 Fusa 实例（ExternalManaged）：禁用重启并标明“外部管理”，退出标明保留外部后台
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
                linux_pid: None,
                linux_pgid: None,
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

        // 2. 自有实例崩溃摘要与端口冲突详情：严格截断至 <= 60 字符且不乱码
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
        assert!(
            crash_line.chars().count() <= 60,
            "crash line exceeded 60 chars: {} ({})",
            crash_line.chars().count(),
            crash_line
        );
        let conflict_line = fault_menu.fault_reason_title.unwrap();
        assert!(conflict_line.chars().count() <= 60);

        // 3. 正在执行“彻底退出 Fusa”异步 40s 停机时：防重复点击退出与重启
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
    fn bootstrap_view_derivation_handles_dynamic_vendors_and_wsl_errors() {
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
                linux_pid: Some(4200),
                linux_pgid: Some(4200),
                generation: 1,
            },
            ownership: DaemonOwnership::Owned,
            has_session_cookie: true,
            last_crash: None,
            host_log_path: PathBuf::from("/tmp/fusa-desktop.log"),
        };

        let dynamic_vendors = vec![VendorGuideEntry {
            id: "sample-vendor-a".to_string(),
            command: "vendor-a-cli".to_string(),
            install_command: "npm install -g @example/vendor-a".to_string(),
            login_command: "vendor-a-cli auth login".to_string(),
            installed: false,
            binary_path: None,
        }];

        // 首次运行或所有动态厂商均未安装时展示厂商引导卡片
        let v_first = derive_view_from_supervisor(&running_owned, &dynamic_vendors, true);
        assert!(v_first.show_vendor_guide);
        assert!(v_first.can_enter_workspace);
        assert_eq!(v_first.vendors.len(), 1);
        assert_eq!(v_first.vendors[0].id, "sample-vendor-a");

        // 至少一家厂商已安装且已完成首次引导后自动进入工作台（不再阻断停留）
        let mut installed_vendors = dynamic_vendors.clone();
        installed_vendors[0].installed = true;
        let v_ready = derive_view_from_supervisor(&running_owned, &installed_vendors, true);
        assert!(!v_ready.show_vendor_guide);

        // WSL 未安装时暴露一键提权安装按钮
        let v_no_wsl = derive_view_from_provision_error(&ProvisionError::WslNotInstalled);
        assert_eq!(v_no_wsl.tone, "error");
        assert!(v_no_wsl.can_install_wsl);
        assert!(v_no_wsl.can_retry);
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

        // 1. 打包携带的 contract.json 与仓库单一事实源完全一致
        assert_eq!(bundled_contract, canonical_contract);

        // 2. Tauri 安全配置锁死：不注入全局 window.__TAURI__，不做 MVP 范围外的 updater / autostart，
        //    且 capabilities 仅限 local: true（不含任何 remote 域授权）
        assert_eq!(tauri_conf["app"]["withGlobalTauri"], false);
        assert!(tauri_conf.get("plugins").is_none());
        assert_eq!(capability["local"], true);
        assert!(capability.get("remote").is_none());

        // 3. 严格遵守 docs/ui-standard.md：无渐变、无毛玻璃、无装饰阴影、不用 `·` 拼接
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
            // 严禁写死具体厂商名单（全部由 --vendors-json 动态注入）
            let lower = content.to_ascii_lowercase();
            for vendor_word in [
                "claude",
                "anthropic",
                "codex",
                "openai",
                "gemini",
                "antigravity",
                "cursor",
            ] {
                assert!(
                    !lower.contains(vendor_word),
                    "{name} must not hardcode vendor name `{vendor_word}`"
                );
            }
        }

        // 4. 校验生成的 Windows icon.ico 文件头有效（ICONDIR: reserved=0, type=1, count>=4）
        let ico = include_bytes!("../icons/icon.ico");
        assert!(ico.len() > 22);
        assert_eq!(&ico[0..4], &[0x00, 0x00, 0x01, 0x00]);
        let frame_count = u16::from_le_bytes([ico[4], ico[5]]);
        assert!(frame_count >= 4, "expected multi-resolution .ico frames");
    }
}
