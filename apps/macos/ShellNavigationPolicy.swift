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

// The window has no address bar or back button, so the main frame stays on shell pages and links open in the system browser.
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
