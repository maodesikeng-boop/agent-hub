use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationDecision {
    AllowInApp,
    OpenExternalBrowser,
    Block,
}

// The main window has no address bar or back button, so leaving these paths would strand the user.
pub const SHELL_PATHS: [&str; 2] = ["/", "/auth"];

pub fn is_embedded_bootstrap_origin(url: &Url) -> bool {
    match (url.scheme(), url.host_str()) {
        ("tauri", Some("localhost")) => url.port().is_none(),
        ("http" | "https", Some("tauri.localhost")) => url.port().is_none(),
        _ => false,
    }
}

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

pub fn classify_navigation_url(url: &Url, daemon_port: u16) -> NavigationDecision {
    if url.as_str() == "about:blank"
        || is_embedded_bootstrap_origin(url)
        || is_daemon_shell_page(url, daemon_port)
    {
        return NavigationDecision::AllowInApp;
    }
    external_or_block(url)
}

pub fn classify_new_window_url(url: &Url) -> NavigationDecision {
    external_or_block(url)
}
