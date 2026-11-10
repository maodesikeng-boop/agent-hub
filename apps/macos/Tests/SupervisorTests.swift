import AppKit
import Darwin
import Foundation

func pumpRunLoop(_ seconds: TimeInterval) {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.03))
    }
}

func waitUntil(timeout: TimeInterval, condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.03))
        if condition() { return true }
    }
    return condition()
}

func check(_ condition: @autoclosure () -> Bool, _ message: String, file: StaticString = #file, line: UInt = #line) {
    if !condition() {
        fputs("FAIL [\(file):\(line)]: \(message)\n", stderr)
        exit(1)
    }
}

func findFreePort() -> Int {
    let sock = Darwin.socket(AF_INET, SOCK_STREAM, 0)
    check(sock >= 0, "socket() failed")
    defer { Darwin.close(sock) }
    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = 0
    addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
    let bindRes = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.bind(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    check(bindRes == 0, "bind() failed")
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    let nameRes = withUnsafeMutablePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.getsockname(sock, $0, &len)
        }
    }
    check(nameRes == 0, "getsockname() failed")
    return Int(UInt16(bigEndian: addr.sin_port))
}

@main
enum SupervisorTestsMain {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)

        let fm = FileManager.default
        let tempRoot = (NSTemporaryDirectory() as NSString).appendingPathComponent("fusa-sup-tests-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString)")
        try! fm.createDirectory(atPath: tempRoot, withIntermediateDirectories: true)

        var trackedProcesses: [Process] = []
        func cleanupAll() {
            for p in trackedProcesses where p.isRunning {
                kill(p.processIdentifier, SIGKILL)
            }
            try? fm.removeItem(atPath: tempRoot)
        }

        guard CommandLine.arguments.count >= 3 else {
            fputs("Usage: SupervisorTests <repoDir> <nodePath>\n", stderr)
            exit(2)
        }
        let repoDir = CommandLine.arguments[1]
        let nodePath = CommandLine.arguments[2]
        setenv("AGENT_HUB_REPO_DIR", repoDir, 1)
        setenv("AGENT_HUB_NODE", nodePath, 1)

        // MARK: - 0. 契约加载与常量完全一致

        let contractPath = (repoDir as NSString).appendingPathComponent("apps/desktop/contract.json")
        let rawContractData = try! Data(contentsOf: URL(fileURLWithPath: contractPath))
        let decodedContract = try! JSONDecoder().decode(DesktopContract.self, from: rawContractData)

        check(DesktopContract.shared == decodedContract, "DesktopContract.shared must equal apps/desktop/contract.json")
        check(SupervisorConfig.defaultPort == 4317, "defaultPort == 4317")
        check(SupervisorConfig.probeTimeoutSeconds == 0.5, "probeTimeout == 0.5s")
        check(SupervisorConfig.pollIntervalSeconds == 0.15, "pollInterval == 0.15s")
        check(SupervisorConfig.startupBudgetSeconds == 15.0, "startupBudget == 15.0s")
        check(SupervisorConfig.stopGraceSeconds == 40.0, "stopGrace == 40.0s")
        check(SupervisorConfig.crashWindowSeconds == 60.0, "crashWindow == 60.0s")
        check(SupervisorConfig.maxCrashCountInWindow == 5, "maxCrashCountInWindow == 5")
        check(SupervisorConfig.logMaxBytes == 2_097_152, "logMaxBytes == 2 MiB")
        check(SupervisorConfig.stderrTailMaxBytes == 4_096, "stderrTailMaxBytes == 4 KiB")
        check(SupervisorConfig.stderrTailMaxLines == 8, "stderrTailMaxLines == 8")

        let expectedBackoffs: [TimeInterval] = [1, 2, 4, 8, 16, 30, 30, 30]
        for (idx, expected) in expectedBackoffs.enumerated() {
            let actual = decodedContract.backoffDelaySeconds(forCrashCount: idx + 1)
            check(actual == expected, "backoff for crash #\(idx + 1): expected \(expected), got \(actual)")
        }

        // 验证 Bundle 资源加载路径（模拟 Fusa.app/Contents/Resources/contract.json）
        let fakeAppPath = (tempRoot as NSString).appendingPathComponent("FakeFusa.app")
        let fakeResourcesPath = (fakeAppPath as NSString).appendingPathComponent("Contents/Resources")
        try! fm.createDirectory(atPath: fakeResourcesPath, withIntermediateDirectories: true)
        try! """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.agenthub.test</string></dict></plist>
        """.write(toFile: (fakeAppPath as NSString).appendingPathComponent("Contents/Info.plist"), atomically: true, encoding: .utf8)
        try! rawContractData.write(to: URL(fileURLWithPath: (fakeResourcesPath as NSString).appendingPathComponent("contract.json")))
        if let testBundle = Bundle(path: fakeAppPath) {
            let bundleContract = DesktopContract.load(bundle: testBundle, environment: [:])
            check(bundleContract == decodedContract, "Bundle-loaded contract must match apps/desktop/contract.json")
        } else {
            check(false, "Failed to construct NSBundle for FakeFusa.app")
        }

        // MARK: - 准备可切换模式的假 HTTP 服务（测试非 Fusa 冲突 + 外部兼容 Fusa 复用）

        let mockPort = findFreePort()
        let modeFilePath = (tempRoot as NSString).appendingPathComponent("mock-mode.txt")
        let requestsLogPath = (tempRoot as NSString).appendingPathComponent("mock-requests.jsonl")
        let mockServerScript = (tempRoot as NSString).appendingPathComponent("mock-http.mjs")
        let secretToken = "TOP_SECRET_UI_TOKEN_DO_NOT_LEAK_987654"

        try! "html200".write(toFile: modeFilePath, atomically: true, encoding: .utf8)
        try! "".write(toFile: requestsLogPath, atomically: true, encoding: .utf8)

        try! """
        import { createServer } from "node:http";
        import { appendFileSync, readFileSync } from "node:fs";

        const port = Number(process.argv[2]);
        const modeFile = process.argv[3];
        const reqLog = process.argv[4];
        const expectedToken = process.argv[5];

        const server = createServer((req, res) => {
          let body = "";
          req.on("data", (c) => (body += c.toString("utf8")));
          req.on("end", () => {
            appendFileSync(
              reqLog,
              JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }) + "\\n",
            );
            const mode = readFileSync(modeFile, "utf8").trim();
            if (req.url === "/auth" && req.method === "POST" && mode === "fusa_v1") {
              const parsed = JSON.parse(body || "{}");
              if (parsed.token === expectedToken && req.headers.origin === `http://127.0.0.1:${port}`) {
                res.writeHead(204, {
                  "set-cookie": `agent_hub_ui_${port}=session_from_ext_fusa; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
                });
                res.end();
                return;
              }
              res.writeHead(401, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "unauthorized" }));
              return;
            }
            if (mode === "html200") {
              res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
              res.end("<!doctype html><html><body>Some Other App</body></html>");
            } else if (mode === "json200_other") {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ status: "active", service: "other-server" }));
            } else if (mode === "http401") {
              res.writeHead(401, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "unauthorized" }));
            } else if (mode === "fusa_v99") {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ status: "unauthenticated", product: "fusa", protocolVersion: 99, instanceId: "incompat-99" }));
            } else if (mode === "fusa_v1") {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ status: "unauthenticated", product: "fusa", protocolVersion: 1, instanceId: "ext-fusa-001" }));
            } else {
              res.writeHead(500);
              res.end("unknown mode");
            }
          });
        });

        server.listen(port, "127.0.0.1", () => {
          console.log("READY");
        });
        """.write(toFile: mockServerScript, atomically: true, encoding: .utf8)

        let mockServerProc = Process()
        mockServerProc.executableURL = URL(fileURLWithPath: nodePath)
        mockServerProc.arguments = [mockServerScript, String(mockPort), modeFilePath, requestsLogPath, secretToken]
        let mockReadyPipe = Pipe()
        mockServerProc.standardOutput = mockReadyPipe
        try! mockServerProc.run()
        trackedProcesses.append(mockServerProc)

        check(waitUntil(timeout: 5.0) {
            let data = mockReadyPipe.fileHandleForReading.availableData
            return String(data: data, encoding: .utf8)?.contains("READY") == true
        }, "mock HTTP server failed to start")
        let mockServerPid = mockServerProc.processIdentifier

        // 准备带 ui-token 的临时 home
        let conflictHome = (tempRoot as NSString).appendingPathComponent("home-conflict")
        try! fm.createDirectory(atPath: (conflictHome as NSString).appendingPathComponent("state"), withIntermediateDirectories: true)
        try! secretToken.write(toFile: (conflictHome as NSString).appendingPathComponent("state/ui-token"), atomically: true, encoding: .utf8)

        // MARK: - 1. 端口被非 Fusa 服务或协议不兼容服务占用：报冲突、不发 token、不误杀

        for mode in ["html200", "json200_other", "http401", "fusa_v99"] {
            try! mode.write(toFile: modeFilePath, atomically: true, encoding: .utf8)
            let sup = DaemonSupervisor(homeDir: conflictHome, port: mockPort)
            let bar = StatusBarController(onOpenMainWindow: {}, onRestartDaemon: {}, onQuitApp: {})
            sup.onStateChange = { st, cr in bar.updateDaemonState(st, lastCrash: cr) }
            sup.onOwnershipChange = { own in bar.updateOwnership(own) }
            sup.onConflictChange = { reason in bar.updateConflict(reason) }

            var ensureResult: Result<Void, Error>?
            sup.ensureRunning { ensureResult = $0 }
            check(waitUntil(timeout: 3.0) { ensureResult != nil }, "ensureRunning timed out for mode=\(mode)")

            if case .failure(let err) = ensureResult! {
                check(err.localizedDescription.contains(String(mockPort)), "conflict error should mention port for mode=\(mode)")
            } else {
                check(false, "ensureRunning must fail on non-Fusa / incompatible server (mode=\(mode))")
            }

            check(sup.currentConflictReason != nil, "currentConflictReason must be set for mode=\(mode)")
            check(sup.currentOwnership == .none, "ownership must be .none for mode=\(mode)")
            check(sup.currentPid == nil, "must not spawn daemon on port conflict (mode=\(mode))")
            check(bar.currentSummaryTitle == "后台端口冲突或协议不兼容", "status bar summary must show conflict for mode=\(mode)")
            check(bar.isConflictVisible, "status bar conflict detail must be visible for mode=\(mode)")
            check(bar.currentButtonTitle == " !", "status bar button must show ' !' for mode=\(mode)")

            // 尝试用 ui-token 兑换 Cookie：必须先探活核验失败并拦截，绝不发送 token
            var cookieResult: Result<[HTTPCookie], Error>?
            sup.exchangeUiTokenForCookies { cookieResult = $0 }
            check(waitUntil(timeout: 3.0) { cookieResult != nil }, "exchangeUiTokenForCookies timed out for mode=\(mode)")
            if case .success = cookieResult! {
                check(false, "exchangeUiTokenForCookies must fail for mode=\(mode)")
            }

            // 点重启或退出时：绝不阻塞 40s，也绝不误杀外部进程
            let t0 = Date()
            var restartResult: Result<Void, Error>?
            sup.restartDaemon { restartResult = $0 }
            check(waitUntil(timeout: 3.0) { restartResult != nil }, "restartDaemon timed out on conflicted port")
            check(Date().timeIntervalSince(t0) < 2.0, "restartDaemon must not wait stopGraceMs on unowned conflicted port")

            var stoppedDone = false
            sup.stopOwned { stoppedDone = true }
            check(waitUntil(timeout: 1.0) { stoppedDone }, "stopOwned must finish immediately when nothing owned")
            sup.stopIfOwned()

            check(kill(mockServerPid, 0) == 0, "external non-Fusa process must never be killed (mode=\(mode))")
        }

        // 核对请求日志：在全部 4 种非兼容模式下，ui-token 从未出现在任何 URL、Header 或 Body 中，也从未请求过 /auth
        let conflictReqLogs = try! String(contentsOfFile: requestsLogPath, encoding: .utf8)
        check(!conflictReqLogs.contains(secretToken), "ui-token MUST NEVER be sent to unverified servers!")
        check(!conflictReqLogs.contains("\"/auth"), "/auth MUST NEVER be called against unverified servers!")

        // MARK: - 2. 外部兼容 Fusa 后台：只复用并标记为外部管理，核验通过后允许 POST /auth 换 Cookie，退出/重启不误杀

        try! "fusa_v1".write(toFile: modeFilePath, atomically: true, encoding: .utf8)
        let extSup = DaemonSupervisor(homeDir: conflictHome, port: mockPort)
        let extBar = StatusBarController(onOpenMainWindow: {}, onRestartDaemon: {}, onQuitApp: {})
        extSup.onStateChange = { st, cr in extBar.updateDaemonState(st, lastCrash: cr) }
        extSup.onOwnershipChange = { own in extBar.updateOwnership(own) }
        extSup.onConflictChange = { reason in extBar.updateConflict(reason) }

        var extEnsure: Result<Void, Error>?
        extSup.ensureRunning { extEnsure = $0 }
        check(waitUntil(timeout: 3.0) { extEnsure != nil }, "extSup.ensureRunning timed out")
        if case .failure(let err) = extEnsure! {
            check(false, "extSup.ensureRunning failed unexpectedly: \(err)")
        }
        check(extSup.currentPid == nil, "reusing external Fusa must not spawn a child process")
        check(extSup.currentOwnership == .external(instanceId: "ext-fusa-001"), "ownership must be .external(ext-fusa-001)")
        check(extSup.isExternallyManaged, "isExternallyManaged must be true")
        check(extSup.currentConflictReason == nil, "conflictReason must be nil for compatible external Fusa")
        check(extBar.currentSummaryTitle == "后台服务运行中（外部管理）", "status bar should show 外部管理, got: \(extBar.currentSummaryTitle)")
        check(!extBar.isRestartEnabled, "restart menu item must be disabled for external daemon")
        check(extBar.currentQuitTitle == "退出 Fusa（保留外部后台）", "quit menu item should clarify external daemon is preserved")

        var exchangedCookies: [HTTPCookie]?
        extSup.exchangeUiTokenForCookies { res in
            if case .success(let cookies) = res {
                exchangedCookies = cookies
            }
        }
        check(waitUntil(timeout: 3.0) { exchangedCookies != nil }, "exchangeUiTokenForCookies failed on verified external Fusa")
        check(exchangedCookies?.count == 1, "expected 1 session cookie, got \(exchangedCookies?.count ?? -1)")
        check(exchangedCookies?.first?.name == "agent_hub_ui_\(mockPort)", "cookie name mismatch")
        check(exchangedCookies?.first?.value == "session_from_ext_fusa", "cookie value mismatch")
        check(exchangedCookies?.first?.isHTTPOnly == true, "cookie should be HttpOnly")

        // 验证令牌只通过 POST /auth 请求体发送，绝不出现在 URL 查询串里
        let postAuthLogs = try! String(contentsOfFile: requestsLogPath, encoding: .utf8)
        for line in postAuthLogs.split(separator: "\n") {
            if let obj = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
               let urlStr = obj["url"] as? String {
                check(!urlStr.contains(secretToken), "ui-token must never appear in request URL: \(urlStr)")
            }
        }

        // 对外部后台调用 restartDaemon / stopOwned / stopIfOwned：不阻塞、不接管、不杀进程
        let extRestartStart = Date()
        var extRestartDone = false
        extSup.restartDaemon { res in
            if case .success = res { extRestartDone = true }
        }
        check(waitUntil(timeout: 3.0) { extRestartDone }, "restartDaemon on external Fusa should succeed by keeping reuse")
        check(Date().timeIntervalSince(extRestartStart) < 2.0, "restartDaemon on external Fusa must not wait stopGraceMs")
        check(extSup.currentOwnership == .external(instanceId: "ext-fusa-001"), "must remain externally managed")

        var extStopDone = false
        extSup.stopOwned { extStopDone = true }
        check(waitUntil(timeout: 1.0) { extStopDone }, "stopOwned on external Fusa must complete immediately")
        extSup.stopIfOwned()
        check(kill(mockServerPid, 0) == 0, "external Fusa daemon must still be alive after stopOwned / stopIfOwned")

        // MARK: - 3. 慢优雅关闭（5 秒退出 > 旧版 3 秒强杀）在真实 40 秒契约预算内优雅退出，且超时才对自有子进程 SIGKILL

        let slowPort = findFreePort()
        let slowHome = (tempRoot as NSString).appendingPathComponent("home-slow")
        let fakeRepoDir = (tempRoot as NSString).appendingPathComponent("fake-repo")
        try! fm.createDirectory(atPath: (fakeRepoDir as NSString).appendingPathComponent("src/daemon"), withIntermediateDirectories: true)
        try! "// placeholder".write(
            toFile: (fakeRepoDir as NSString).appendingPathComponent("src/daemon/main.ts"),
            atomically: true,
            encoding: .utf8
        )

        let gracefulMarkerPath = (tempRoot as NSString).appendingPathComponent("graceful-exit.log")
        let slowDaemonEntry = (tempRoot as NSString).appendingPathComponent("slow-daemon.mjs")

        try! """
        import { createServer } from "node:http";
        import { randomUUID } from "node:crypto";
        import { appendFileSync } from "node:fs";

        const port = Number(process.env.AGENT_HUB_PORT);
        const delayMs = Number(process.env.FAKE_SHUTDOWN_DELAY_MS || "5000");
        const hangForever = process.env.FAKE_HANG_FOREVER === "1";
        const markerFile = process.env.FAKE_GRACEFUL_MARKER;
        const instanceId = randomUUID();

        const server = createServer((req, res) => {
          if (req.method === "GET" && req.url === "/api/auth/status") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
              status: "unauthenticated",
              product: "fusa",
              protocolVersion: 1,
              instanceId,
            }));
            return;
          }
          res.writeHead(404);
          res.end();
        });

        server.listen(port, "127.0.0.1");

        let shuttingDown = false;
        process.on("SIGTERM", () => {
          if (hangForever) {
            return; // 故意忽略 SIGTERM 以验证超时后 SIGKILL 兜底
          }
          if (shuttingDown) return;
          shuttingDown = true;
          setTimeout(() => {
            if (markerFile) {
              appendFileSync(markerFile, `graceful:${process.pid}:${instanceId}\\n`);
            }
            server.close(() => process.exit(0));
            setTimeout(() => process.exit(0), 50).unref();
          }, delayMs);
        });
        """.write(toFile: slowDaemonEntry, atomically: true, encoding: .utf8)

        setenv("AGENT_HUB_REPO_DIR", fakeRepoDir, 1)
        setenv("AGENT_HUB_DAEMON_ENTRY", slowDaemonEntry, 1)
        setenv("AGENT_HUB_PORT", String(slowPort), 1)
        setenv("FAKE_SHUTDOWN_DELAY_MS", "5000", 1)
        setenv("FAKE_HANG_FOREVER", "0", 1)
        setenv("FAKE_GRACEFUL_MARKER", gracefulMarkerPath, 1)

        // 使用真实契约（stopGraceMs = 40000ms）验证 5 秒优雅退出不会被旧版 3 秒预算强杀
        let ownedSup = DaemonSupervisor(homeDir: slowHome, port: slowPort)
        var initialStarted = false
        ownedSup.ensureRunning { res in
            if case .success = res { initialStarted = true }
        }
        check(waitUntil(timeout: 10.0) { initialStarted }, "ownedSup initial start failed")
        guard let pidA = ownedSup.currentPid,
              case .owned(let ownedPidA, let instanceIdA) = ownedSup.currentOwnership else {
            check(false, "ownedSup should own pidA with verified instanceId")
            exit(1)
        }
        check(pidA == ownedPidA && !instanceIdA.isEmpty, "pidA / instanceIdA mismatch")

        // 重启时新进程改为 100ms 快速关闭，便于后续清理；正在跑的 pidA 仍保持 5000ms 慢关闭！
        setenv("FAKE_SHUTDOWN_DELAY_MS", "100", 1)

        let slowRestartBegan = Date()
        var slowRestartSucceeded = false
        ownedSup.restartDaemon { res in
            if case .success = res { slowRestartSucceeded = true }
        }
        check(waitUntil(timeout: 20.0) { slowRestartSucceeded }, "slow restartDaemon timed out under 40s stopGraceMs")
        let slowRestartElapsed = Date().timeIntervalSince(slowRestartBegan)

        // 必须等完 ~5 秒优雅退出（绝不能在 3 秒强杀，也不必傻等满 40 秒）
        check(slowRestartElapsed >= 4.8, "restart must wait for 5s graceful exit (elapsed=\(slowRestartElapsed)s)")
        check(slowRestartElapsed < 15.0, "restart should proceed promptly once old instance exits (elapsed=\(slowRestartElapsed)s)")

        let markerContent = (try? String(contentsOfFile: gracefulMarkerPath, encoding: .utf8)) ?? ""
        check(
            markerContent.contains("graceful:\(pidA):\(instanceIdA)"),
            "pidA must complete 5s graceful SIGTERM handler without SIGKILL, marker=\(markerContent)"
        )
        check(kill(pidA, 0) != 0, "pidA must have exited before new instance started")
        check(ownedSup.recentCrashCount == 0, "graceful manual restart must not count as crash")

        guard let pidB = ownedSup.currentPid,
              case .owned(_, let instanceIdB) = ownedSup.currentOwnership else {
            check(false, "ownedSup should own new pidB after restart")
            exit(1)
        }
        check(pidB != pidA, "pidB must differ from pidA")
        check(instanceIdB != instanceIdA, "instanceIdB must differ from instanceIdA")

        var cleanStopB = false
        ownedSup.stopOwned { cleanStopB = true }
        check(waitUntil(timeout: 5.0) { cleanStopB }, "stopOwned for pidB timed out")
        check(kill(pidB, 0) != 0, "pidB must be stopped")

        // 验证卡死忽略 SIGTERM 时：超过 stopGraceMs 后仅对自己拉起的子进程发 SIGKILL
        let hungPort = findFreePort()
        setenv("AGENT_HUB_PORT", String(hungPort), 1)
        setenv("FAKE_HANG_FOREVER", "1", 1)

        let shortStopContract = DesktopContract(
            product: decodedContract.product,
            protocolVersion: decodedContract.protocolVersion,
            defaultPort: decodedContract.defaultPort,
            statusPath: decodedContract.statusPath,
            probeTimeoutMs: decodedContract.probeTimeoutMs,
            pollIntervalMs: 50,
            startupBudgetMs: decodedContract.startupBudgetMs,
            wslColdStartBudgetMs: decodedContract.wslColdStartBudgetMs,
            stopGraceMs: 600,
            crashBackoffMs: decodedContract.crashBackoffMs,
            crashWindowMs: decodedContract.crashWindowMs,
            maxCrashesInWindow: decodedContract.maxCrashesInWindow,
            logRelativePath: decodedContract.logRelativePath,
            logMaxBytes: decodedContract.logMaxBytes,
            logRotatedFiles: decodedContract.logRotatedFiles,
            stderrTailMaxBytes: decodedContract.stderrTailMaxBytes,
            stderrSummaryMaxLines: decodedContract.stderrSummaryMaxLines,
            menuReasonMaxChars: decodedContract.menuReasonMaxChars,
            menuActions: decodedContract.menuActions
        )

        let hungSup = DaemonSupervisor(
            contract: shortStopContract,
            homeDir: (tempRoot as NSString).appendingPathComponent("home-hung"),
            port: hungPort
        )
        var hungStarted = false
        hungSup.ensureRunning { if case .success = $0 { hungStarted = true } }
        check(waitUntil(timeout: 10.0) { hungStarted }, "hungSup failed to start")
        let hungPid = hungSup.currentPid!

        let hungStopStart = Date()
        var hungStopped = false
        hungSup.stopOwned { hungStopped = true }
        check(waitUntil(timeout: 5.0) { hungStopped }, "hungSup.stopOwned failed to SIGKILL after grace timeout")
        let hungStopElapsed = Date().timeIntervalSince(hungStopStart)
        check(hungStopElapsed >= 0.55 && hungStopElapsed < 4.0, "hung stop should wait ~0.6s grace then SIGKILL, got \(hungStopElapsed)s")
        check(waitUntil(timeout: 2.0) { kill(hungPid, 0) != 0 }, "hungPid must be killed after stopGraceMs")
        check(kill(mockServerPid, 0) == 0, "unrelated external mock server must still be untouched!")

        // MARK: - 4. 快速连续崩溃退避序列与窗口上限

        let crashPort = findFreePort()
        let crashEntry = (tempRoot as NSString).appendingPathComponent("fast-crash.mjs")
        try! """
        console.error("Fatal: test crash sequence");
        process.exit(1);
        """.write(toFile: crashEntry, atomically: true, encoding: .utf8)

        setenv("AGENT_HUB_PORT", String(crashPort), 1)
        setenv("AGENT_HUB_DAEMON_ENTRY", slowDaemonEntry, 1)
        setenv("FAKE_HANG_FOREVER", "0", 1)
        setenv("FAKE_SHUTDOWN_DELAY_MS", "50", 1)

        let fastCrashContract = DesktopContract(
            product: decodedContract.product,
            protocolVersion: decodedContract.protocolVersion,
            defaultPort: decodedContract.defaultPort,
            statusPath: decodedContract.statusPath,
            probeTimeoutMs: 300,
            pollIntervalMs: 50,
            startupBudgetMs: 5_000,
            wslColdStartBudgetMs: decodedContract.wslColdStartBudgetMs,
            stopGraceMs: 2_000,
            crashBackoffMs: [100, 200, 400, 800, 1600, 3000],
            crashWindowMs: 60_000,
            maxCrashesInWindow: 5,
            logRelativePath: decodedContract.logRelativePath,
            logMaxBytes: decodedContract.logMaxBytes,
            logRotatedFiles: decodedContract.logRotatedFiles,
            stderrTailMaxBytes: decodedContract.stderrTailMaxBytes,
            stderrSummaryMaxLines: decodedContract.stderrSummaryMaxLines,
            menuReasonMaxChars: decodedContract.menuReasonMaxChars,
            menuActions: decodedContract.menuActions
        )

        let crashHome = (tempRoot as NSString).appendingPathComponent("home-crash")
        let crashSup = DaemonSupervisor(contract: fastCrashContract, homeDir: crashHome, port: crashPort)
        var recordedDelays: [TimeInterval] = []
        var enteredFailed = false
        crashSup.onStateChange = { state, _ in
            switch state {
            case .restarting(_, _, let delay, _):
                recordedDelays.append(delay)
            case .failed(let count, _, _):
                if count == 5 { enteredFailed = true }
            case .running:
                break
            }
        }

        var crashInitialReady = false
        crashSup.ensureRunning { if case .success = $0 { crashInitialReady = true } }
        check(waitUntil(timeout: 10.0) { crashInitialReady }, "crashSup initial start failed")
        let firstCrashPid = crashSup.currentPid!

        setenv("AGENT_HUB_DAEMON_ENTRY", crashEntry, 1)
        kill(firstCrashPid, SIGKILL)

        check(waitUntil(timeout: 10.0) { enteredFailed }, "crashSup did not enter .failed after 5 rapid crashes")
        pumpRunLoop(0.4)
        check(recordedDelays == [0.1, 0.2, 0.4, 0.8], "expected backoff delays [0.1, 0.2, 0.4, 0.8], got \(recordedDelays)")
        check(crashSup.currentPid == nil, "no daemon should remain running after .failed")

        mockServerProc.terminate()
        _ = waitUntil(timeout: 2.0) { !mockServerProc.isRunning }
        cleanupAll()
        print("ALL_SUPERVISOR_TESTS_PASSED")
    }
}
