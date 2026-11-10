import AppKit
import UserNotifications
import WebKit

final class MainWindowController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    let window: NSWindow
    let webView: WKWebView
    private let supervisor: DaemonSupervisor
    private let onStatusUpdate: (Int, Int, Int) -> Void
    private var didAttemptTokenAuth = false
    private(set) var isShowingErrorPage = false
    private var downloadDestinations: [ObjectIdentifier: URL] = [:]

    init(supervisor: DaemonSupervisor, onStatusUpdate: @escaping (Int, Int, Int) -> Void) {
        self.supervisor = supervisor
        self.onStatusUpdate = onStatusUpdate

        let contentController = WKUserContentController()
        let scriptSource = """
        (function() {
          document.documentElement.dataset.macosApp = "true";

          var origFocus = window.focus ? window.focus.bind(window) : function() {};
          window.focus = function() {
            origFocus();
            if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.activateWindow) {
              window.webkit.messageHandlers.activateWindow.postMessage({});
            }
          };

          var reportedUnauth = false;
          function checkUnauthenticated() {
            if (reportedUnauth) return;
            if (document.querySelector('[data-testid="unauthenticated"]')) {
              reportedUnauth = true;
              if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.authNeeded) {
                window.webkit.messageHandlers.authNeeded.postMessage({});
              }
            }
          }
          var observer = new MutationObserver(checkUnauthenticated);
          observer.observe(document.documentElement, { childList: true, subtree: true });
          window.addEventListener("DOMContentLoaded", checkUnauthenticated);

          var callbacks = {};
          var seq = 0;
          window.__agentHubNotificationClicked = function(id) {
            var fn = callbacks[id];
            if (typeof fn === "function") fn();
          };
          function NativeNotification(title, options) {
            var opts = options || {};
            var id = String(++seq);
            var self = this;
            this.title = String(title || "");
            this.body = String(opts.body || "");
            this.tag = String(opts.tag || id);
            this.onclick = null;
            this.close = function() { delete callbacks[id]; };
            callbacks[id] = function() {
              if (typeof self.onclick === "function") self.onclick();
            };
            if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.sendNotification) {
              window.webkit.messageHandlers.sendNotification.postMessage({
                id: id,
                title: this.title,
                body: this.body,
                tag: this.tag
              });
            }
          }
          NativeNotification.permission = "granted";
          NativeNotification.requestPermission = function(cb) {
            if (typeof cb === "function") cb("granted");
            return Promise.resolve("granted");
          };
          window.Notification = NativeNotification;
        })();
        """
        let userScript = WKUserScript(source: scriptSource, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        contentController.addUserScript(userScript)

        let config = WKWebViewConfiguration()
        config.userContentController = contentController
        config.websiteDataStore = .default()

        self.webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800), configuration: config)

        let styleMask: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView]
        self.window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
            styleMask: styleMask,
            backing: .buffered,
            defer: false
        )

        super.init()

        contentController.add(self, name: "hubStatus")
        contentController.add(self, name: "windowDrag")
        contentController.add(self, name: "authNeeded")
        contentController.add(self, name: "sendNotification")
        contentController.add(self, name: "activateWindow")

        window.title = "Piece"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = false
        window.backgroundColor = NSColor.white
        window.minSize = NSSize(width: 480, height: 560)
        window.delegate = self
        window.contentView = webView
        if !window.setFrameUsingName("AgentHubMainWindow") {
            window.center()
        }
        window.setFrameAutosaveName("AgentHubMainWindow")

        webView.navigationDelegate = self
        webView.uiDelegate = self
    }

    func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func reload() {
        didAttemptTokenAuth = false
        loadHub()
    }

    /// 免手输登录：先检查 httpCookieStore 是否已有 agent_hub_ui_4317 Cookie；有则直接加载 /，没有则读 state/ui-token 跳 /auth?token=。
    func loadHub() {
        isShowingErrorPage = false
        let cookieName = supervisor.cookieName
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self = self else { return }
            let hasSessionCookie = cookies.contains { cookie in
                cookie.name == cookieName && (cookie.domain == "127.0.0.1" || cookie.domain == "localhost")
            }
            DispatchQueue.main.async {
                if hasSessionCookie {
                    self.webView.load(URLRequest(url: self.supervisor.baseURL))
                } else {
                    self.authenticateWithUiToken()
                }
            }
        }
    }

    private func authenticateWithUiToken() {
        if !didAttemptTokenAuth, let token = supervisor.readUiToken(),
           var components = URLComponents(url: supervisor.baseURL.appendingPathComponent("auth"), resolvingAgainstBaseURL: false) {
            didAttemptTokenAuth = true
            components.queryItems = [URLQueryItem(name: "token", value: token)]
            if let authURL = components.url {
                webView.load(URLRequest(url: authURL))
                return
            }
        }
        webView.load(URLRequest(url: supervisor.baseURL))
    }

    func showStartupError(_ message: String) {
        isShowingErrorPage = true
        let escaped = message
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        let html = """
        <!doctype html>
        <html lang="zh-CN">
        <head>
        <meta charset="utf-8">
        <style>
          body { margin: 0; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif; color: #18181b; background: #ffffff; padding: 24px; box-sizing: border-box; text-align: center; }
          p { margin: 0; max-width: 520px; }
          .muted { font-size: 13.5px; color: #71717a; word-break: break-all; }
        </style>
        </head>
        <body>
          <p>\(escaped)</p>
          <p class="muted">日志文件：\(supervisor.logFilePath)</p>
        </body>
        </html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func handleNotificationClicked(id: String) {
        showWindow()
        let safeId = id.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        webView.evaluateJavaScript("window.__agentHubNotificationClicked && window.__agentHubNotificationClicked(\"\(safeId)\");", completionHandler: nil)
    }

    // MARK: - NSWindowDelegate

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    // MARK: - WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.name {
        case "hubStatus":
            guard let body = message.body as? [String: Any] else { return }
            let runningWorkers = body["runningWorkers"] as? Int ?? 0
            let askingCount = body["askingCount"] as? Int ?? 0
            let waitingCount = body["waitingCount"] as? Int ?? 0
            onStatusUpdate(runningWorkers, askingCount, waitingCount)

        case "windowDrag":
            let body = message.body as? [String: Any]
            let doubleClick = body?["doubleClick"] as? Bool ?? false
            if doubleClick {
                window.performZoom(nil)
            } else if let event = NSApp.currentEvent {
                window.performDrag(with: event)
            }

        case "authNeeded":
            if !didAttemptTokenAuth {
                authenticateWithUiToken()
            }

        case "activateWindow":
            showWindow()

        case "sendNotification":
            guard let body = message.body as? [String: Any] else { return }
            let id = body["id"] as? String ?? UUID().uuidString
            let title = body["title"] as? String ?? "Piece"
            let text = body["body"] as? String ?? ""
            let tag = body["tag"] as? String ?? id
            postNativeNotification(id: id, title: title, body: text, tag: tag)

        default:
            break
        }
    }

    private func postNativeNotification(id: String, title: String, body: String, tag: String) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            content.userInfo = ["notificationId": id]
            let request = UNNotificationRequest(identifier: tag, content: content, trigger: nil)
            center.add(request, withCompletionHandler: nil)
        }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("Boolean(document.querySelector('[data-testid=\"unauthenticated\"]'))") { [weak self] result, _ in
            guard let self = self else { return }
            if let unauth = result as? Bool, unauth, !self.didAttemptTokenAuth {
                self.authenticateWithUiToken()
            }
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        preferences: WKWebpagePreferences,
        decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
    ) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download, preferences)
            return
        }
        if let url = navigationAction.request.url,
           let scheme = url.scheme?.lowercased(),
           scheme == "http" || scheme == "https" {
            let host = url.host?.lowercased() ?? ""
            if host != "127.0.0.1" && host != "localhost" {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel, preferences)
                return
            }
        }
        decisionHandler(.allow, preferences)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        if !navigationResponse.canShowMIMEType {
            decisionHandler(.download)
            return
        }
        if let http = navigationResponse.response as? HTTPURLResponse,
           let disposition = http.value(forHTTPHeaderField: "Content-Disposition")?.lowercased(),
           disposition.contains("attachment") {
            decisionHandler(.download)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    // MARK: - WKUIDelegate

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            let host = url.host?.lowercased() ?? ""
            if host == "127.0.0.1" || host == "localhost" {
                webView.load(URLRequest(url: url))
            } else {
                NSWorkspace.shared.open(url)
            }
        }
        return nil
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    // MARK: - WKDownloadDelegate

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let fm = FileManager.default
        let downloadsDir = fm.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: (NSHomeDirectory() as NSString).appendingPathComponent("Downloads"))
        let destination = uniqueDownloadURL(in: downloadsDir, filename: suggestedFilename)
        downloadDestinations[ObjectIdentifier(download)] = destination
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let dest = downloadDestinations.removeValue(forKey: ObjectIdentifier(download)) {
            NSWorkspace.shared.activateFileViewerSelecting([dest])
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadDestinations.removeValue(forKey: ObjectIdentifier(download))
    }

    private func uniqueDownloadURL(in directory: URL, filename: String) -> URL {
        let fm = FileManager.default
        let safeName = filename.isEmpty ? "download" : filename
        let initial = directory.appendingPathComponent(safeName)
        if !fm.fileExists(atPath: initial.path) {
            return initial
        }
        let ext = (safeName as NSString).pathExtension
        let base = (safeName as NSString).deletingPathExtension
        var index = 1
        while true {
            let candidateName = ext.isEmpty ? "\(base) (\(index))" : "\(base) (\(index)).\(ext)"
            let candidate = directory.appendingPathComponent(candidateName)
            if !fm.fileExists(atPath: candidate.path) {
                return candidate
            }
            index += 1
        }
    }
}
