import Foundation

enum ShellNavigationTarget: Equatable {
    case newWindow
    case mainFrame
    case subframe(linkActivated: Bool)
}

enum ShellNavigationDecision: Equatable {
    case allow
    case openExternally
    case cancel
}

/// 主窗口没有地址栏和后退键：主框架只停在守护进程的壳页面，网页链接交系统浏览器，预览窗 iframe 照常加载守护进程的文件。
struct ShellNavigationPolicy {
    static let shellPaths: Set<String> = ["/", "/auth"]
    static let externalSchemes: Set<String> = ["http", "https", "mailto"]

    let daemonPort: Int

    func decide(_ url: URL?, target: ShellNavigationTarget) -> ShellNavigationDecision {
        guard let url = url, let scheme = url.scheme?.lowercased() else { return .cancel }
        let isWebLink = Self.externalSchemes.contains(scheme)
        switch target {
        case .newWindow:
            return isWebLink ? .openExternally : .cancel
        case .mainFrame:
            if url.absoluteString == "about:blank" || isShellPage(url) { return .allow }
            return isWebLink ? .openExternally : .cancel
        case .subframe(let linkActivated):
            return linkActivated && isWebLink && !isDaemonOrigin(url) ? .openExternally : .allow
        }
    }

    private func isDaemonOrigin(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "http" && url.host?.lowercased() == "127.0.0.1" && url.port == daemonPort
    }

    private func isShellPage(_ url: URL) -> Bool {
        isDaemonOrigin(url) && Self.shellPaths.contains(url.path.isEmpty ? "/" : url.path)
    }
}
