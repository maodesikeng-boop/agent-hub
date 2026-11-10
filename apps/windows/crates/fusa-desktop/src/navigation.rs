use url::Url;

/// WebView 顶层导航与新窗口请求的安全裁决。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationDecision {
    /// 允许在当前应用窗口内加载（仅限内嵌本地引导页与已核验端口的本机 `http://127.0.0.1:<port>`）。
    AllowInApp,
    /// 拦截窗口内跳转并转交系统默认浏览器打开（所有非 `127.0.0.1:<port>` 的 `http`/`https`/`mailto` 链接）。
    OpenExternalBrowser,
    /// 直接拒绝（如 `javascript:`、`file:`、`data:` 等非预期顶层协议）。
    Block,
}

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

/// 对所有导航与 `window.open` 目标 URL 进行白名单裁决。
pub fn classify_navigation_url(url: &Url, daemon_port: u16) -> NavigationDecision {
    if url.as_str() == "about:blank"
        || is_embedded_bootstrap_origin(url)
        || is_local_daemon_origin(url, daemon_port)
    {
        return NavigationDecision::AllowInApp;
    }

    match url.scheme() {
        "http" | "https" | "mailto" => NavigationDecision::OpenExternalBrowser,
        _ => NavigationDecision::Block,
    }
}
