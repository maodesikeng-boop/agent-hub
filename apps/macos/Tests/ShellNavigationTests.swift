import AppKit
import Darwin
import Foundation
import WebKit

// 真 WKWebView 里点链接：主窗口必须一直停在 Fusa 页面，网页交给系统浏览器，预览窗 iframe 照常显示。
// 编译运行：
//   swiftc -framework AppKit -framework WebKit -framework UserNotifications \
//     apps/macos/MainWindowController.swift apps/macos/DaemonSupervisor.swift apps/macos/ShellNavigationPolicy.swift \
//     apps/macos/Tests/ShellNavigationTests.swift -o /tmp/ShellNavigationTests && /tmp/ShellNavigationTests

func pump(_ seconds: TimeInterval) {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
    }
}

func waitFor(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.02))
    }
    return condition()
}

func freePort() -> Int {
    let sock = Darwin.socket(AF_INET, SOCK_STREAM, 0)
    defer { Darwin.close(sock) }
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
    _ = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.getsockname(sock, $0, &len) }
    }
    return Int(UInt16(bigEndian: addr.sin_port))
}

func serve(_ dir: String, port: Int) -> Process {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
    p.arguments = ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", dir]
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try! p.run()
    return p
}

func write(_ path: String, _ text: String) {
    try! FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try! text.write(toFile: path, atomically: true, encoding: .utf8)
}

@main
enum ShellNavigationTestsMain {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)

        let policy = ShellNavigationPolicy(daemonPort: 4317)
        let decisions: [(String?, ShellNavigationTarget, ShellNavigationDecision)] = [
            ("about:blank", .mainFrame, .allow),
            ("http://127.0.0.1:4317", .mainFrame, .allow),
            ("http://127.0.0.1:4317/#/c/1", .mainFrame, .allow),
            ("http://127.0.0.1:4317/auth?token=x", .mainFrame, .allow),
            ("http://127.0.0.1:4317/api/sent-files/0123456789abcdef/a.html", .mainFrame, .openExternally),
            ("http://127.0.0.1:4317/d/peer/", .mainFrame, .openExternally),
            ("http://localhost:4317/", .mainFrame, .openExternally),
            ("https://127.0.0.1:4317/", .mainFrame, .openExternally),
            ("http://127.0.0.1:5173/", .mainFrame, .openExternally),
            ("mailto:a@example.com", .mainFrame, .openExternally),
            ("file:///etc/hosts", .mainFrame, .cancel),
            ("javascript:alert(1)", .mainFrame, .cancel),
            (nil, .mainFrame, .cancel),
            ("http://127.0.0.1:4317/", .newWindow, .openExternally),
            ("http://localhost:3000/", .newWindow, .openExternally),
            ("https://example.com/", .newWindow, .openExternally),
            ("about:blank", .newWindow, .cancel),
            ("http://127.0.0.1:4317/api/sent-files/0123456789abcdef/a.pdf?inline=1", .subframe(linkActivated: false), .allow),
            ("http://127.0.0.1:4317/api/sent-files/0123456789abcdef/a.html#sec", .subframe(linkActivated: true), .allow),
            ("https://example.com/", .subframe(linkActivated: true), .openExternally),
            ("https://example.com/embed", .subframe(linkActivated: false), .allow),
            ("about:srcdoc", .subframe(linkActivated: true), .allow),
        ]
        for (raw, target, expected) in decisions {
            let got = policy.decide(raw.flatMap(URL.init(string:)), target: target)
            if got != expected {
                fputs("FAIL policy \(raw ?? "nil") \(target): expected \(expected), got \(got)\n", stderr)
                exit(1)
            }
        }
        print("PASS ShellNavigationPolicy: \(decisions.count) cases")

        let root = (NSTemporaryDirectory() as NSString).appendingPathComponent("fusa-shell-nav-\(UUID().uuidString)")
        let daemonDir = "\(root)/daemon"
        let otherDir = "\(root)/other"
        let daemonPort = freePort()
        let otherPort = freePort()
        let shell = "http://127.0.0.1:\(daemonPort)/"
        let previewPath = "/api/sent-files/0123456789abcdef/preview.html"

        write("\(daemonDir)/index.html", """
        <!doctype html><meta charset="utf-8"><title>Fusa</title>
        <a id="blank-report" target="_blank" href="http://127.0.0.1:\(daemonPort)/tmp/out/report.html">report</a>
        <a id="blank-localhost" target="_blank" href="http://localhost:\(otherPort)/">localhost</a>
        <a id="blank-api" target="_blank" href="/api/sent-files/0123456789abcdef/report.html">api</a>
        <a id="top-api" href="/api/sent-files/0123456789abcdef/report.html">api top</a>
        <a id="top-other" href="http://127.0.0.1:\(otherPort)/">other top</a>
        <a id="hash" href="#/c/1">conversation</a>
        <iframe id="pv" src="\(previewPath)"></iframe>
        """)
        write("\(daemonDir)\(previewPath)", """
        <!doctype html><meta charset="utf-8">
        <h1 id="ok">preview</h1>
        <a id="ext" href="http://127.0.0.1:\(otherPort)/ext.html">ext</a>
        <a id="anchor" href="#sec">anchor</a><p id="sec">sec</p>
        """)
        write("\(daemonDir)/tmp/out/report.html", "<!doctype html><h1>report</h1>")
        write("\(otherDir)/index.html", "<!doctype html><h1>dev server</h1>")
        write("\(otherDir)/ext.html", "<!doctype html><h1>ext</h1>")

        let servers = [serve(daemonDir, port: daemonPort), serve(otherDir, port: otherPort)]
        var failures: [String] = []
        func finish(_ code: Int32) -> Never {
            servers.forEach { $0.terminate() }
            try? FileManager.default.removeItem(atPath: root)
            exit(code)
        }

        var opened: [URL] = []
        let supervisor = DaemonSupervisor(homeDir: root, port: daemonPort)
        let controller = MainWindowController(supervisor: supervisor, onStatusUpdate: { _, _, _ in }, openExternalURL: { opened.append($0) })
        let webView = controller.webView

        func js(_ source: String, in frame: WKFrameInfo? = nil) -> Any? {
            var result: Any?
            var done = false
            webView.evaluateJavaScript(source, in: frame, in: .page) { r in
                if case .success(let value) = r { result = value }
                done = true
            }
            _ = waitFor(5) { done }
            return result
        }

        func loadShell() -> Bool {
            webView.load(URLRequest(url: URL(string: shell)!))
            return waitFor(10) {
                !webView.isLoading && webView.url?.absoluteString == shell
                    && (js("document.getElementById('pv')?.contentDocument?.getElementById('ok')?.textContent") as? String) == "preview"
            }
        }

        func expect(_ ok: Bool, _ message: String) {
            print("\(ok ? "PASS" : "FAIL") \(message)")
            if !ok { failures.append(message) }
        }

        guard waitFor(10, { (try? Data(contentsOf: URL(string: shell)!)) != nil }) else {
            fputs("test servers did not start\n", stderr)
            finish(2)
        }

        let cases: [(id: String, expected: String)] = [
            ("blank-report", "http://127.0.0.1:\(daemonPort)/tmp/out/report.html"),
            ("blank-localhost", "http://localhost:\(otherPort)/"),
            ("blank-api", "http://127.0.0.1:\(daemonPort)/api/sent-files/0123456789abcdef/report.html"),
            ("top-api", "http://127.0.0.1:\(daemonPort)/api/sent-files/0123456789abcdef/report.html"),
            ("top-other", "http://127.0.0.1:\(otherPort)/"),
        ]
        for c in cases {
            guard loadShell() else {
                expect(false, "shell page loads before clicking #\(c.id)")
                continue
            }
            opened.removeAll()
            _ = js("document.getElementById('\(c.id)').click()")
            pump(1.5)
            expect(webView.url?.absoluteString == shell, "#\(c.id): main window stays on Fusa (url=\(webView.url?.absoluteString ?? "nil"))")
            expect(opened.map(\.absoluteString) == [c.expected], "#\(c.id): system browser opens \(c.expected) exactly once (opened=\(opened.map(\.absoluteString)))")
        }

        if loadShell() {
            opened.removeAll()
            _ = js("document.getElementById('hash').click()")
            pump(0.5)
            expect(webView.url?.absoluteString == "\(shell)#/c/1", "#hash: in-app hash route still works (url=\(webView.url?.absoluteString ?? "nil"))")
            expect(opened.isEmpty, "#hash: nothing opened externally (opened=\(opened.map(\.absoluteString)))")
        }

        if loadShell() {
            opened.removeAll()
            expect(true, "preview iframe renders daemon HTML inline")
            _ = js("var d = document.getElementById('pv').contentDocument; d.getElementById('anchor').click(); d.location.hash")
            pump(0.5)
            expect((js("document.getElementById('pv').contentWindow.location.hash") as? String) == "#sec", "preview iframe: #anchor jump works")
            _ = js("document.getElementById('pv').contentDocument.getElementById('ext').click()")
            pump(1.5)
            expect(webView.url?.absoluteString == shell, "preview iframe ext link: main window stays on Fusa")
            expect((js("document.getElementById('pv').contentDocument?.getElementById('ok')?.textContent") as? String) == "preview",
                   "preview iframe ext link: preview stays rendered")
            expect(opened.map(\.absoluteString) == ["http://127.0.0.1:\(otherPort)/ext.html"],
                   "preview iframe ext link: system browser opens it (opened=\(opened.map(\.absoluteString)))")
        } else {
            expect(false, "preview iframe renders daemon HTML inline")
        }

        if failures.isEmpty {
            print("ALL PASS")
            finish(0)
        }
        print("\(failures.count) FAILED")
        finish(1)
    }
}
