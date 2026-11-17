use url::Url;

/// WebView 主框架导航与新窗口请求的安全裁决。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationDecision {
    /// 在主窗口内加载：只有内嵌引导页和守护进程的壳页面（`SHELL_PATHS`）。
    AllowInApp,
    /// 拦下并交系统默认浏览器打开（其余 `http`/`https`/`mailto`，含守护进程的其它路径）。
    OpenExternalBrowser,
    /// 直接拒绝（如 `javascript:`、`file:`、`data:` 等非预期顶层协议）。
    Block,
}

/// 主窗口能停留的守护进程路径。主窗口没有地址栏和后退键，跳到别的页面就回不来。
pub const SHELL_PATHS: [&str; 2] = ["/", "/auth"];

/// 判断给定 URL 是否属于 Tauri 内嵌本地引导页源（`tauri://localhost` 或 Windows WebView2 的 `http(s)://tauri.localhost`）。
/// 只有该源允许调用本地引导期 Tauri command；任何 `127.0.0.1` 或外部页面均返回 `false`。
pub fn is_embedded_bootstrap_origin(url: &Url) -> bool {
    match (url.scheme(), url.host_str()) {
        ("tauri", Some("localhost")) => url.port().is_none(),
        ("http" | "https", Some("tauri.localhost")) => url.port().is_none(),
        _ => false,
    }
}

/// 判断给定 URL 是否属于当前受监管的本机 Fusa 守护进程回环源 `http://127.0.0.1:<daemon_port>`。
pub fn is_local_daemon_origin(url: &Url, daemon_port: u16) -> bool {
    url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port_or_known_default() == Some(daemon_port)
}

fn is_daemon_shell_page(url: &Url, daemon_port: u16) -> bool {
    is_local_daemon_origin(url, daemon_port) && SHELL_PATHS.contains(&url.path())
}

fn external_or_block(url: &Url) -> NavigationDecision {
    match url.scheme() {
        "http" | "https" | "mailto" => NavigationDecision::OpenExternalBrowser,
        _ => NavigationDecision::Block,
    }
}

/// 主框架导航的白名单裁决。
pub fn classify_navigation_url(url: &Url, daemon_port: u16) -> NavigationDecision {
    if url.as_str() == "about:blank"
        || is_embedded_bootstrap_origin(url)
        || is_daemon_shell_page(url, daemon_port)
    {
        return NavigationDecision::AllowInApp;
    }
    external_or_block(url)
}

/// 新窗口请求（`target="_blank"`、`window.open`）从不在应用里开窗：网页交系统浏览器，其余拒绝。
pub fn classify_new_window_url(url: &Url) -> NavigationDecision {
    external_or_block(url)
}
