import Darwin
import Foundation

enum FusaSelfTest {
    static let flag = "--self-test"

    private struct Failure: Error {
        let message: String
    }

    private struct HealthPathContract: Decodable {
        let healthPath: String
    }

    static func run() -> Int32 {
        var template = Array("/tmp/fusa-st.XXXXXX".utf8CString)
        let createdPtr = template.withUnsafeMutableBufferPointer { buf in
            mkdtemp(buf.baseAddress)
        }
        guard createdPtr != nil else {
            fputs("[fusa-self-test] FAIL: mkdtemp(/tmp/fusa-st.XXXXXX) 失败\n", stderr)
            return 1
        }
        let tempRoot = String(cString: template)
        let homeDir = (tempRoot as NSString).appendingPathComponent("hub")
        defer { try? FileManager.default.removeItem(atPath: tempRoot) }
        do {
            try FileManager.default.createDirectory(atPath: homeDir, withIntermediateDirectories: true)
            let summary = try runInner(homeDir: homeDir)
            print("[fusa-self-test] PASS \(summary)")
            return 0
        } catch let failure as Failure {
            fputs("[fusa-self-test] FAIL: \(failure.message)\n", stderr)
            let log = (homeDir as NSString).appendingPathComponent(DesktopContract.shared.logRelativePath)
            if let text = try? String(contentsOfFile: log, encoding: .utf8) {
                fputs("--- desktop-daemon.log ---\n\(text.suffix(4000))\n", stderr)
            }
            return 1
        } catch {
            fputs("[fusa-self-test] FAIL: \(error.localizedDescription)\n", stderr)
            return 1
        }
    }

    private static func runInner(homeDir: String) throws -> String {
        let contract = DesktopContract.shared
        let bundlePath = Bundle.main.bundlePath

        let runtime: DaemonRuntimeLocation
        switch DaemonRuntimeLocator.resolve() {
        case .success(let located): runtime = located
        case .failure(let err): throw Failure(message: err.message)
        }
        guard runtime.mode == .bundled else {
            throw Failure(message: "不是分发包（Info.plist 的 \(DaemonRuntimeLocator.runtimeModeInfoKey) 不是 bundled）")
        }
        for path in [runtime.daemonRoot, runtime.nodePath] where !path.hasPrefix(bundlePath + "/") {
            throw Failure(message: "运行环境不在包内：\(path)（包：\(bundlePath)）")
        }

        guard let runtimeDir = DaemonRuntimeLocator.bundledRuntimeDir(.live) else {
            throw Failure(message: "找不到包内 Resources 目录")
        }
        let manifestPath = (runtimeDir as NSString).appendingPathComponent("runtime-manifest.json")
        guard let manifestData = FileManager.default.contents(atPath: manifestPath),
              let manifest = try? JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
              let expectedNode = manifest["nodeVersion"] as? String else {
            throw Failure(message: "读不到运行环境清单：\(manifestPath)")
        }
        let nodeVersion = try runTool(runtime.nodePath, ["--version"]).trimmingCharacters(in: .whitespacesAndNewlines)
        guard nodeVersion == expectedNode else {
            throw Failure(message: "包内 Node 版本 \(nodeVersion) 与清单 \(expectedNode) 不一致")
        }
        let npmCli = (((runtime.nodePath as NSString).deletingLastPathComponent as NSString)
            .appendingPathComponent("../lib/node_modules/npm/bin/npm-cli.js") as NSString).standardizingPath
        let npmVersion = try runTool(runtime.nodePath, [npmCli, "--version"]).trimmingCharacters(in: .whitespacesAndNewlines)

        let port = try findFreePort()
        let supervisor = DaemonSupervisor(homeDir: homeDir, port: port)
        let startedAt = Date()
        var startResult: Result<Void, Error>?
        supervisor.ensureRunning { startResult = $0 }
        let startBudget = contract.startupBudgetSeconds + 5
        guard pumpUntil(timeout: startBudget, { startResult != nil }) else {
            supervisor.stopIfOwned()
            throw Failure(message: "守护进程 \(Int(startBudget)) 秒内没就绪")
        }
        if case .failure(let err) = startResult! {
            supervisor.stopIfOwned()
            throw Failure(message: "拉起守护进程失败：\(err.localizedDescription)")
        }
        let startupMs = Int(Date().timeIntervalSince(startedAt) * 1000)
        guard case .owned(let pid, let instanceId) = supervisor.currentOwnership else {
            supervisor.stopIfOwned()
            throw Failure(message: "守护进程不是本次自检拉起的：\(supervisor.currentOwnership)")
        }

        var sandboxStatus = "nested-skipped"
        let verify: () throws -> Void = {
            let healthPath = (try? JSONDecoder().decode(
                HealthPathContract.self,
                from: Data(contentsOf: Bundle.main.url(forResource: "contract", withExtension: "json")!)
            ))?.healthPath ?? "/api/health"
            let healthURL = URL(string: "http://127.0.0.1:\(port)\(healthPath)")!
            let (unauthStatus, _) = try httpGet(healthURL, headers: [:])
            guard unauthStatus == 401 else { throw Failure(message: "未鉴权 GET \(healthPath) 应返回 401，实际 \(unauthStatus)") }
            var cookieResult: Result<[HTTPCookie], Error>?
            supervisor.exchangeUiTokenForCookies { cookieResult = $0 }
            guard pumpUntil(timeout: 10, { cookieResult != nil }),
                  case .success(let cookies) = cookieResult!, !cookies.isEmpty else {
                throw Failure(message: "用 ui-token 兑换会话 Cookie 失败")
            }
            let authHeaders = HTTPCookie.requestHeaderFields(with: cookies)
            let (okStatus, body) = try httpGet(healthURL, headers: authHeaders)
            guard okStatus == 200,
                  let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  json["ok"] as? Bool == true,
                  json["product"] as? String == contract.product,
                  json["instanceId"] as? String == instanceId else {
                throw Failure(message: "已鉴权 GET \(healthPath) 应返回 200 且身份一致，实际 \(okStatus)：\(String(data: body, encoding: .utf8) ?? "")")
            }
            let reloadURL = URL(string: "http://127.0.0.1:\(port)/api/self-reload")!
            let (reloadBuildStatus, _) = try httpPostJson(
                reloadURL,
                origin: "http://127.0.0.1:\(port)",
                headers: authHeaders,
                body: Data("{\"build\":true}".utf8)
            )
            guard reloadBuildStatus == 400 else {
                throw Failure(message: "分发包 POST /api/self-reload {\"build\":true} 应返回 400，实际 \(reloadBuildStatus)")
            }

            let hubShim = (homeDir as NSString).appendingPathComponent("run/bin/hub")
            guard let shim = try? String(contentsOfFile: hubShim, encoding: .utf8) else {
                throw Failure(message: "守护进程没写出 hub 外壳：\(hubShim)")
            }
            let hubMain = (runtime.daemonRoot as NSString).appendingPathComponent("src/hub/main.ts")
            guard shim.contains(runtime.nodePath), shim.contains(hubMain) else {
                throw Failure(message: "hub 外壳没指向包内运行环境：\(shim)")
            }
            let usage = try runTool(hubShim, ["help"])
            guard usage.contains("hub") else { throw Failure(message: "hub help 输出不对：\(usage.prefix(200))") }

            if canRunSandboxExec() {
                let realHome = realpathOrSelf(homeDir)
                let wtDir = (realHome as NSString).appendingPathComponent("worktrees/1/1")
                try FileManager.default.createDirectory(atPath: wtDir, withIntermediateDirectories: true)
                let escapedHome = sbplEscape(realHome)
                let escapedWt = sbplEscape(wtDir)
                let profile = "(version 1)\n(allow default)\n(deny file-write* (subpath \"\(escapedHome)\"))\n(allow file-write* (subpath \"\(escapedWt)\"))"
                let sbUsage = try runTool("/usr/bin/sandbox-exec", ["-p", profile, hubShim, "help"])
                guard sbUsage.contains("hub") else {
                    throw Failure(message: "sandbox-exec 内跑 hub help 输出不对：\(sbUsage.prefix(200))")
                }
                _ = try runTool("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", "echo ok > \"$1\"", "--", "\(wtDir)/probe"])
                let deniedPath = "\(realHome)/state/sandbox-denied-probe"
                let deniedStatus = try runToolStatus("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", "echo bad > \"$1\"", "--", deniedPath])
                guard deniedStatus != 0, !FileManager.default.fileExists(atPath: deniedPath) else {
                    throw Failure(message: "sandbox-exec 没拦住对数据目录 state/ 的写入")
                }
                sandboxStatus = "verified"
            }
        }
        let verifyError: Error?
        do { try verify(); verifyError = nil } catch { verifyError = error }

        let stopStarted = Date()
        var stopped = false
        supervisor.stopOwned { stopped = true }
        let stopBudget = contract.stopGraceSeconds + 5
        let stopOk = pumpUntil(timeout: stopBudget) { stopped }
        let shutdownMs = Int(Date().timeIntervalSince(stopStarted) * 1000)
        if let verifyError { throw verifyError }
        guard stopOk else { throw Failure(message: "守护进程 \(Int(stopBudget)) 秒内没停下") }
        guard pumpUntil(timeout: 3, { kill(pid, 0) != 0 }) else {
            throw Failure(message: "关机后守护进程 PID \(pid) 仍然存活")
        }
        var probeAfter: Bool?
        supervisor.probe { probeAfter = $0 }
        _ = pumpUntil(timeout: 5) { probeAfter != nil }
        if probeAfter == true { throw Failure(message: "关机后端口 \(port) 仍在响应") }

        return "mode=bundled node=\(nodeVersion) npm=\(npmVersion) sandbox=\(sandboxStatus) port=\(port) pid=\(pid) startupMs=\(startupMs) shutdownMs=\(shutdownMs)"
    }

    private static func pumpUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.03))
        }
        return condition()
    }

    private static func runTool(_ executable: String, _ args: [String]) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = args
        let out = Pipe()
        process.standardOutput = out
        process.standardError = out
        do { try process.run() } catch {
            throw Failure(message: "跑不起来 \(executable)：\(error.localizedDescription)")
        }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let text = String(data: data, encoding: .utf8) ?? ""
        guard process.terminationStatus == 0 else {
            throw Failure(message: "\(executable) \(args.joined(separator: " ")) 退出码 \(process.terminationStatus)：\(text.prefix(400))")
        }
        return text
    }

    private static func runToolStatus(_ executable: String, _ args: [String]) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = args
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch {
            throw Failure(message: "跑不起来 \(executable)：\(error.localizedDescription)")
        }
        process.waitUntilExit()
        return process.terminationStatus
    }

    private static func canRunSandboxExec() -> Bool {
        (try? runToolStatus("/usr/bin/sandbox-exec", ["-p", "(version 1)\n(allow default)", "/usr/bin/true"])) == 0
    }

    private static func realpathOrSelf(_ path: String) -> String {
        guard let resolved = Darwin.realpath(path, nil) else { return path }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    private static func sbplEscape(_ path: String) -> String {
        path.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }

    private static func httpGet(_ url: URL, headers: [String: String]) throws -> (Int, Data) {
        var req = URLRequest(url: url)
        req.timeoutInterval = 5
        headers.forEach { req.setValue($1, forHTTPHeaderField: $0) }
        return try sendHttp(req)
    }

    private static func httpPostJson(_ url: URL, origin: String, headers: [String: String], body: Data) throws -> (Int, Data) {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 5
        headers.forEach { req.setValue($1, forHTTPHeaderField: $0) }
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(origin, forHTTPHeaderField: "Origin")
        req.httpBody = body
        return try sendHttp(req)
    }

    private static func sendHttp(_ req: URLRequest) throws -> (Int, Data) {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let done = DispatchSemaphore(value: 0)
        var result: (Int, Data)?
        var failure: Error?
        session.dataTask(with: req) { data, response, error in
            if let error { failure = error } else {
                result = ((response as? HTTPURLResponse)?.statusCode ?? 0, data ?? Data())
            }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 10)
        let target = req.url?.absoluteString ?? ""
        if let failure { throw Failure(message: "请求 \(target) 失败：\(failure.localizedDescription)") }
        guard let result else { throw Failure(message: "请求 \(target) 超时") }
        return result
    }

    private static func findFreePort() throws -> Int {
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else { throw Failure(message: "socket() 失败") }
        defer { close(sock) }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0 else { throw Failure(message: "bind() 失败") }
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(sock, $0, &len) }
        }
        guard named == 0 else { throw Failure(message: "getsockname() 失败") }
        return Int(UInt16(bigEndian: addr.sin_port))
    }
}
