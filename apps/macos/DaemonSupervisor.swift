import CoreFoundation
import Darwin
import Foundation

/// Mac 与 Windows 桌面外壳共用的后台监管契约（单一来源：apps/desktop/contract.json，打包时拷入 Contents/Resources/contract.json）。
struct DesktopContract: Codable, Equatable {
    let product: String
    let protocolVersion: Int
    let defaultPort: Int
    let statusPath: String
    let probeTimeoutMs: Int
    let pollIntervalMs: Int
    let startupBudgetMs: Int
    let wslColdStartBudgetMs: Int
    let stopGraceMs: Int
    let crashBackoffMs: [Int]
    let crashWindowMs: Int
    let maxCrashesInWindow: Int
    /// 守护进程空闲排空后请求热重启时用的退出码（`hub self-reload`）：立即拉起新进程，不算崩溃、不进退避和熔断计数。
    let reloadExitCode: Int
    /// 外壳拉起守护进程时设的环境变量名：守护进程据此知道退出后有人拉起，才接受热重启请求。
    let supervisedEnv: String
    let logRelativePath: String
    let logMaxBytes: Int
    let logRotatedFiles: Int
    let stderrTailMaxBytes: Int
    let stderrSummaryMaxLines: Int
    let menuReasonMaxChars: Int
    let menuActions: [String]

    var probeTimeoutSeconds: TimeInterval { Double(probeTimeoutMs) / 1000.0 }
    var pollIntervalSeconds: TimeInterval { Double(pollIntervalMs) / 1000.0 }
    var startupBudgetSeconds: TimeInterval { Double(startupBudgetMs) / 1000.0 }
    var stopGraceSeconds: TimeInterval { Double(stopGraceMs) / 1000.0 }
    var crashBackoffSeconds: [TimeInterval] { crashBackoffMs.map { Double($0) / 1000.0 } }
    var crashWindowSeconds: TimeInterval { Double(crashWindowMs) / 1000.0 }

    func backoffDelaySeconds(forCrashCount count: Int) -> TimeInterval {
        let series = crashBackoffSeconds
        guard !series.isEmpty else { return 1.0 }
        let idx = min(max(0, count - 1), series.count - 1)
        return series[idx]
    }

    static let shared: DesktopContract = load()

    static func load(
        from customURL: URL? = nil,
        bundle: Bundle = .main,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> DesktopContract {
        let fm = FileManager.default
        var candidates: [URL] = []

        if let customURL = customURL {
            candidates.append(customURL)
        }
        if let envPath = environment["AGENT_HUB_DESKTOP_CONTRACT"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !envPath.isEmpty {
            candidates.append(URL(fileURLWithPath: (envPath as NSString).expandingTildeInPath))
        }
        if let bundledURL = bundle.url(forResource: "contract", withExtension: "json") {
            candidates.append(bundledURL)
        }
        if let repoDir = environment["AGENT_HUB_REPO_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !repoDir.isEmpty {
            let expanded = (repoDir as NSString).expandingTildeInPath
            candidates.append(URL(fileURLWithPath: (expanded as NSString).appendingPathComponent("apps/desktop/contract.json")))
        }
        let compileTimeContractURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("desktop/contract.json")
        candidates.append(compileTimeContractURL)

        for url in candidates where fm.fileExists(atPath: url.path) {
            if let data = try? Data(contentsOf: url),
               let decoded = try? JSONDecoder().decode(DesktopContract.self, from: data) {
                return decoded
            }
        }
        fatalError("无法加载桌面壳监管契约 contract.json（已检查：\(candidates.map(\.path).joined(separator: ", "))）")
    }
}

/// 守护进程监管器的契约常量访问入口（全部取自 DesktopContract.shared，消除魔法数字双写）。
enum SupervisorConfig {
    static var contract: DesktopContract { DesktopContract.shared }
    static var product: String { contract.product }
    static var protocolVersion: Int { contract.protocolVersion }
    static var defaultPort: Int { contract.defaultPort }
    static var statusPath: String { contract.statusPath }
    static var probeTimeoutSeconds: TimeInterval { contract.probeTimeoutSeconds }
    static var pollIntervalSeconds: TimeInterval { contract.pollIntervalSeconds }
    static var startupBudgetSeconds: TimeInterval { contract.startupBudgetSeconds }
    static var stopGraceSeconds: TimeInterval { contract.stopGraceSeconds }
    static var crashWindowSeconds: TimeInterval { contract.crashWindowSeconds }
    static var maxCrashCountInWindow: Int { contract.maxCrashesInWindow }
    static var stderrTailMaxBytes: Int { contract.stderrTailMaxBytes }
    static var stderrTailMaxLines: Int { contract.stderrSummaryMaxLines }
    static var menuReasonMaxChars: Int { contract.menuReasonMaxChars }
    static var logMaxBytes: Int { contract.logMaxBytes }
}

/// `/api/auth/status` 返回的守护进程轻量身份标识。
struct DaemonIdentity: Codable, Equatable {
    let product: String
    let protocolVersion: Int
    let instanceId: String
}

/// 单次探活结果：已核验的兼容 Fusa 后台、端口被非 Fusa / 不兼容服务占用的冲突、或尚未连通。
enum DaemonProbeResult: Equatable {
    case verified(DaemonIdentity)
    case conflict(String)
    case unreachable
}

/// 当前端口上后台服务的所有权归属：只有 `.owned` 才允许执行自动崩溃拉起与停止/强杀管理。
enum DaemonOwnership: Equatable {
    case none
    case owned(pid: Int32, instanceId: String)
    case external(instanceId: String)

    var isExternal: Bool {
        if case .external = self { return true }
        return false
    }

    var isOwned: Bool {
        if case .owned = self { return true }
        return false
    }
}

struct DaemonCrashRecord: Equatable {
    let timestamp: Date
    let pid: Int32
    let exitDescription: String
    let stderrTailLines: [String]
    let menuSummaryReason: String

    var formattedTime: String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm:ss"
        return formatter.string(from: timestamp)
    }

    var menuTitle: String {
        "上次崩溃 \(formattedTime)，\(menuSummaryReason)"
    }
}

enum DaemonSupervisorState: Equatable {
    case running
    case restarting(attempt: Int, maxAttempts: Int, delaySeconds: TimeInterval, lastCrash: DaemonCrashRecord)
    case failed(crashCount: Int, windowSeconds: TimeInterval, lastCrash: DaemonCrashRecord)
}

/// 收集子进程 stderr 输出：实时追加写入日志文件，同时在内存中保留最近一段用于崩溃摘要。
private final class ProcessStderrCollector {
    private let lock = NSLock()
    private var buffer = Data()
    private let maxBytes: Int
    private let writeLog: (Data) -> Void

    init(maxBytes: Int, writeLog: @escaping (Data) -> Void) {
        self.maxBytes = maxBytes
        self.writeLog = writeLog
    }

    func append(_ data: Data) {
        guard !data.isEmpty else { return }
        writeLog(data)
        lock.lock()
        buffer.append(data.suffix(maxBytes))
        if buffer.count > maxBytes {
            buffer.removeFirst(buffer.count - maxBytes)
        }
        lock.unlock()
    }

    func tailLines(maxLines: Int) -> [String] {
        lock.lock()
        let snapshot = buffer
        lock.unlock()
        guard !snapshot.isEmpty else { return [] }
        let text = String(decoding: snapshot, as: UTF8.self)
        let lines = text
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if lines.count <= maxLines {
            return lines
        }
        return Array(lines.suffix(maxLines))
    }
}

private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

final class DaemonSupervisor {
    private static let maxTrackedIntentionalPids = 64

    let contract: DesktopContract
    let homeDir: String
    let port: Int

    var onStateChange: ((DaemonSupervisorState, DaemonCrashRecord?) -> Void)?
    var onOwnershipChange: ((DaemonOwnership) -> Void)?
    var onConflictChange: ((String?) -> Void)?

    private let httpSession: URLSession
    private var signalTokens: [ObjectIdentifier: audit_token_t] = [:]
    private var spawnedProcess: Process?
    private var ownedInstanceId: String?
    private var ownership: DaemonOwnership = .none
    private var conflictReason: String?
    private var intentionalStopPids: Set<Int32> = []
    private var isShuttingDown = false
    private var recentCrashTimestamps: [Date] = []
    private var lastCrashRecord: DaemonCrashRecord?
    private var state: DaemonSupervisorState = .running
    private var pendingRestartWorkItem: DispatchWorkItem?
    private var restartGeneration = UUID()
    /// 用户点“重启后台服务”后到旧进程退出这段时间：别的路径（退避重启、启动轮询）不许拉起新进程，免得和旧进程抢端口
    private var isRestarting = false
    private var stoppingProcess: Process?
    private var stopCompletions: [() -> Void] = []
    private let logLock = NSLock()
    private let lock = NSLock()

    init(
        contract: DesktopContract = DesktopContract.shared,
        homeDir: String? = nil,
        port: Int? = nil
    ) {
        self.contract = contract
        let env = ProcessInfo.processInfo.environment

        if let explicitHome = homeDir?.trimmingCharacters(in: .whitespacesAndNewlines), !explicitHome.isEmpty {
            self.homeDir = (explicitHome as NSString).expandingTildeInPath
        } else if let customHome = env["AGENT_HUB_HOME"]?.trimmingCharacters(in: .whitespacesAndNewlines), !customHome.isEmpty {
            self.homeDir = (customHome as NSString).expandingTildeInPath
        } else {
            self.homeDir = (NSHomeDirectory() as NSString).appendingPathComponent(".agent-hub")
        }

        if let explicitPort = port, explicitPort > 0 {
            self.port = explicitPort
        } else if let envPortStr = env["AGENT_HUB_PORT"], let envPort = Int(envPortStr), envPort > 0 {
            self.port = envPort
        } else {
            let defaultsPort = UserDefaults.standard.integer(forKey: "AgentHubPort")
            self.port = defaultsPort > 0 ? defaultsPort : contract.defaultPort
        }

        let sessionConfig = URLSessionConfiguration.ephemeral
        sessionConfig.requestCachePolicy = .reloadIgnoringLocalCacheData
        sessionConfig.urlCache = nil
        sessionConfig.httpCookieStorage = nil
        sessionConfig.httpShouldSetCookies = false
        sessionConfig.timeoutIntervalForRequest = max(contract.probeTimeoutSeconds, 2.0)
        sessionConfig.timeoutIntervalForResource = 5.0
        self.httpSession = URLSession(configuration: sessionConfig, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }

    deinit {
        httpSession.invalidateAndCancel()
    }

    var baseURL: URL {
        URL(string: "http://127.0.0.1:\(port)")!
    }

    var probeURL: URL {
        let path = contract.statusPath.hasPrefix("/") ? contract.statusPath : "/\(contract.statusPath)"
        return URL(string: "http://127.0.0.1:\(port)\(path)")!
    }

    var authURL: URL {
        URL(string: "http://127.0.0.1:\(port)/auth")!
    }

    var cookieName: String {
        "agent_hub_ui_\(port)"
    }

    var uiTokenPath: String {
        (homeDir as NSString).appendingPathComponent("state/ui-token")
    }

    var logFilePath: String {
        (homeDir as NSString).appendingPathComponent(contract.logRelativePath)
    }

    var currentPid: Int32? {
        lock.lock()
        defer { lock.unlock() }
        guard let proc = spawnedProcess ?? stoppingProcess, proc.isRunning else { return nil }
        return proc.processIdentifier
    }

    var currentOwnership: DaemonOwnership {
        lock.lock()
        defer { lock.unlock() }
        return ownership
    }

    var isExternallyManaged: Bool {
        currentOwnership.isExternal
    }

    var currentConflictReason: String? {
        lock.lock()
        defer { lock.unlock() }
        return conflictReason
    }

    var currentState: DaemonSupervisorState {
        lock.lock()
        defer { lock.unlock() }
        return state
    }

    var currentLastCrash: DaemonCrashRecord? {
        lock.lock()
        defer { lock.unlock() }
        return lastCrashRecord
    }

    var recentCrashCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return recentCrashTimestamps.count
    }

    func readUiToken() -> String? {
        guard let data = FileManager.default.contents(atPath: uiTokenPath),
              let raw = String(data: data, encoding: .utf8) else {
            return nil
        }
        let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return token.isEmpty ? nil : token
    }

    /// 探活并严格核验 `/api/auth/status` 的 JSON 身份（product == "fusa"、protocolVersion 兼容、非空 instanceId）。
    func probeIdentity(completion: @escaping (DaemonProbeResult) -> Void) {
        var request = URLRequest(url: probeURL)
        request.httpMethod = "GET"
        request.timeoutInterval = contract.probeTimeoutSeconds
        request.cachePolicy = .reloadIgnoringLocalCacheData

        let task = httpSession.dataTask(with: request) { [contract, port] data, response, error in
            if error != nil || response == nil {
                completion(.unreachable)
                return
            }
            completion(Self.parseProbeResponse(data: data, response: response, contract: contract, port: port))
        }
        task.resume()
    }

    /// 布尔探活封装：仅当端口响应通过 Fusa 身份与协议版本校验时才返回 true。
    func probe(completion: @escaping (Bool) -> Void) {
        probeIdentity { result in
            if case .verified = result {
                completion(true)
            } else {
                completion(false)
            }
        }
    }

    /// 先通过 `/api/auth/status` 核验兼容 Fusa 身份，核验通过后才允许读取 `state/ui-token` 通过 `POST /auth` 兑换会话 Cookie。
    /// 若端口被其他程序或协议不兼容版本占用，立即返回冲突错误，绝不读取或发送本机令牌。
    func exchangeUiTokenForCookies(completion: @escaping (Result<[HTTPCookie], Error>) -> Void) {
        probeIdentity { [weak self] probeResult in
            guard let self = self else { return }
            switch probeResult {
            case .conflict(let reason):
                self.recordConflict(reason)
                let err = Self.makeError(code: 5, message: reason)
                DispatchQueue.main.async { completion(.failure(err)) }

            case .unreachable:
                let err = Self.makeError(code: 6, message: "后台服务尚未就绪（端口 \(self.port) 无响应）")
                DispatchQueue.main.async { completion(.failure(err)) }

            case .verified:
                self.clearConflict()
                guard let token = self.readUiToken() else {
                    DispatchQueue.main.async { completion(.success([])) }
                    return
                }
                let targetAuthURL = self.authURL
                var req = URLRequest(url: targetAuthURL)
                req.httpMethod = "POST"
                req.timeoutInterval = max(self.contract.probeTimeoutSeconds, 2.0)
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                req.setValue(self.baseURL.absoluteString, forHTTPHeaderField: "Origin")
                req.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token], options: [])

                let task = self.httpSession.dataTask(with: req) { _, response, error in
                    if let error = error {
                        DispatchQueue.main.async { completion(.failure(error)) }
                        return
                    }
                    guard let http = response as? HTTPURLResponse else {
                        DispatchQueue.main.async { completion(.success([])) }
                        return
                    }
                    guard (200..<300).contains(http.statusCode),
                          let setCookie = http.value(forHTTPHeaderField: "Set-Cookie"),
                          !setCookie.isEmpty else {
                        DispatchQueue.main.async { completion(.success([])) }
                        return
                    }
                    let cookies = HTTPCookie.cookies(
                        withResponseHeaderFields: ["Set-Cookie": setCookie],
                        for: targetAuthURL
                    )
                    DispatchQueue.main.async { completion(.success(cookies)) }
                }
                task.resume()
            }
        }
    }

    /// 确保守护进程在运行：
    /// - 若已有兼容的外部 Fusa 后台：只复用并标记为外部管理（不接管）；
    /// - 若端口被非 Fusa 服务或协议不兼容进程占用：进入冲突报错状态，绝不误认、不发令牌、不误杀；
    /// - 若端口空闲：后台拉起 node src/daemon/main.ts 并轮询核验身份直至就绪。
    func ensureRunning(completion: @escaping (Result<Void, Error>) -> Void) {
        probeIdentity { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .verified(let identity):
                let nextOwnership: DaemonOwnership
                self.lock.lock()
                if self.isShuttingDown || self.isRestarting {
                    self.lock.unlock()
                    DispatchQueue.main.async { completion(.failure(Self.makeError(code: 7, message: "后台服务正在停止。"))) }
                    return
                }
                if let proc = self.spawnedProcess, proc.isRunning,
                   self.ownedInstanceId == nil || self.ownedInstanceId == identity.instanceId {
                    self.ownedInstanceId = identity.instanceId
                    nextOwnership = .owned(pid: proc.processIdentifier, instanceId: identity.instanceId)
                } else {
                    nextOwnership = .external(instanceId: identity.instanceId)
                }
                self.ownership = nextOwnership
                self.conflictReason = nil
                self.lock.unlock()

                self.notifyConflictChange(nil)
                self.notifyOwnershipChange(nextOwnership)
                self.updateState(.running)
                DispatchQueue.main.async {
                    completion(.success(()))
                }

            case .conflict(let reason):
                self.recordConflict(reason)
                let err = Self.makeError(code: 5, message: reason)
                DispatchQueue.main.async {
                    completion(.failure(err))
                }

            case .unreachable:
                self.startDaemon(completion: completion)
            }
        }
    }

    /// 用户主动点菜单“重启后台服务”：
    /// - 仅停止本次由 DaemonSupervisor 自己拉起的进程（禁用自动重启 -> SIGTERM -> 最多等 40s -> 确认旧实例退出后再拉起新实例）；
    /// - 若当前是外部兼容 Fusa 后台或未拥有任何子进程，绝不发送信号或阻塞等待外部进程退出。
    func restartDaemon(completion: @escaping (Result<Void, Error>) -> Void) {
        lock.lock()
        if isRestarting || isShuttingDown || stoppingProcess != nil {
            lock.unlock()
            DispatchQueue.main.async { completion(.failure(Self.makeError(code: 7, message: "后台服务正在停止，请稍后重试。"))) }
            return
        }
        restartGeneration = UUID()
        pendingRestartWorkItem?.cancel()
        pendingRestartWorkItem = nil
        recentCrashTimestamps.removeAll()
        let proc = spawnedProcess
        let expectedInstanceId = ownedInstanceId
        guard let ownedProc = proc else {
            lock.unlock()
            ensureRunning(completion: completion)
            return
        }
        isRestarting = true
        stoppingProcess = ownedProc
        spawnedProcess = nil
        ownedInstanceId = nil
        ownership = .none
        markIntentionalStopLocked(ownedProc)
        lock.unlock()

        notifyOwnershipChange(.none)

        stopOwnedProcess(
            ownedProc,
            expectedInstanceId: expectedInstanceId,
            graceSeconds: contract.stopGraceSeconds
        ) { [weak self] in
            guard let self = self else { return }
            self.lock.lock()
            self.isRestarting = false
            self.stoppingProcess = nil
            let quitting = self.isShuttingDown
            let waiters = self.stopCompletions
            self.stopCompletions.removeAll()
            self.lock.unlock()
            waiters.forEach { $0() }
            if quitting {
                completion(.failure(Self.makeError(code: 7, message: "应用正在退出。")))
            } else {
                self.ensureRunning(completion: completion)
            }
        }
    }

    /// 异步优雅停止由本应用拉起的守护进程（遵循契约 40s 优雅停止预算，超时仅对自己拉起的该子进程发 SIGKILL）；
    /// 外部后台（spawnedProcess == nil）完全不受影响并立即回调。
    func stopOwned(completion: @escaping () -> Void) {
        lock.lock()
        isShuttingDown = true
        if stoppingProcess != nil {
            stopCompletions.append(completion)
            lock.unlock()
            return
        }
        restartGeneration = UUID()
        pendingRestartWorkItem?.cancel()
        pendingRestartWorkItem = nil
        let proc = spawnedProcess
        let expectedInstanceId = ownedInstanceId
        stoppingProcess = proc
        spawnedProcess = nil
        ownedInstanceId = nil
        ownership = .none
        if let proc = proc {
            markIntentionalStopLocked(proc)
        }
        lock.unlock()

        notifyOwnershipChange(.none)

        guard let ownedProc = proc else {
            DispatchQueue.main.async { completion() }
            return
        }
        stopOwnedProcess(
            ownedProc,
            expectedInstanceId: expectedInstanceId,
            graceSeconds: contract.stopGraceSeconds
        ) { [self] in
            lock.lock()
            stoppingProcess = nil
            let waiters = stopCompletions
            stopCompletions.removeAll()
            lock.unlock()
            completion()
            waiters.forEach { $0() }
        }
    }

    /// 同步停止入口（兼容测试及 applicationWillTerminate 兜底）：仅对本应用自己拉起的守护进程发 SIGTERM，绝不触碰外部进程。
    func stopIfOwned() {
        lock.lock()
        isShuttingDown = true
        restartGeneration = UUID()
        pendingRestartWorkItem?.cancel()
        pendingRestartWorkItem = nil
        let proc = spawnedProcess
        spawnedProcess = nil
        ownedInstanceId = nil
        ownership = .none
        if let proc = proc {
            markIntentionalStopLocked(proc)
        }
        lock.unlock()

        if let proc = proc, proc.isRunning {
            signalOwned(proc, SIGTERM)
        }
    }

    // The kernel checks the audit token's PID generation atomically with delivery.
    // Never fall back to kill(pid): Foundation can reap the child between a check and kill.
    private func signalOwned(_ process: Process, _ signal: Int32) {
        lock.lock()
        defer { lock.unlock() }
        guard process.isRunning, var token = signalTokens[ObjectIdentifier(process)] else { return }
        _ = proc_signal_with_audittoken(&token, signal)
    }

    private static func signalToken(for process: Process) -> audit_token_t? {
        var name: mach_port_name_t = 0
        guard task_name_for_pid(mach_task_self_, process.processIdentifier, &name) == KERN_SUCCESS else { return nil }
        defer { mach_port_deallocate(mach_task_self_, name) }
        var token = audit_token_t()
        var count = mach_msg_type_number_t(MemoryLayout<audit_token_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &token) { ptr in
            ptr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(name, task_flavor_t(TASK_AUDIT_TOKEN), $0, &count)
            }
        }
        guard result == KERN_SUCCESS, process.isRunning else { return nil }
        return token
    }

    private func markIntentionalStopLocked(_ process: Process) {
        guard process.isRunning else { return }
        if intentionalStopPids.count >= Self.maxTrackedIntentionalPids {
            intentionalStopPids.removeAll()
        }
        intentionalStopPids.insert(process.processIdentifier)
    }

    private func stopOwnedProcess(
        _ process: Process,
        expectedInstanceId: String?,
        graceSeconds: TimeInterval,
        completion: @escaping () -> Void
    ) {
        if process.isRunning {
            signalOwned(process, SIGTERM)
        }
        let deadline = Date().addingTimeInterval(graceSeconds)
        waitForOwnedShutdown(
            process: process,
            expectedInstanceId: expectedInstanceId,
            deadline: deadline,
            completion: completion
        )
    }

    private func waitForOwnedShutdown(
        process: Process,
        expectedInstanceId: String?,
        deadline: Date,
        completion: @escaping () -> Void
    ) {
        if process.isRunning {
            if Date() >= deadline {
                // 超出 40 秒优雅停止预算仍未退出：仅对本次自己拉起的该子进程发 SIGKILL
                if process.isRunning {
                    signalOwned(process, SIGKILL)
                }
                waitForReapAfterSigkill(
                    process: process,
                    completion: completion
                )
                return
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + contract.pollIntervalSeconds) { [weak self] in
                self?.waitForOwnedShutdown(
                    process: process,
                    expectedInstanceId: expectedInstanceId,
                    deadline: deadline,
                    completion: completion
                )
            }
            return
        }

        // 子进程已退出；若曾记录过它的 instanceId，再探一次确认端口上旧实例已彻底释放（不触碰任何新出现的外部进程）
        guard let expectedId = expectedInstanceId else {
            DispatchQueue.main.async { completion() }
            return
        }
        probeIdentity { [weak self] probeResult in
            guard let self = self else {
                DispatchQueue.main.async { completion() }
                return
            }
            if case .verified(let identity) = probeResult,
               identity.instanceId == expectedId,
               Date() < deadline {
                DispatchQueue.global().asyncAfter(deadline: .now() + self.contract.pollIntervalSeconds) { [weak self] in
                    self?.waitForOwnedShutdown(
                        process: process,
                        expectedInstanceId: expectedInstanceId,
                        deadline: deadline,
                        completion: completion
                    )
                }
                return
            }
            DispatchQueue.main.async { completion() }
        }
    }

    private func waitForReapAfterSigkill(
        process: Process,
        completion: @escaping () -> Void
    ) {
        if !process.isRunning {
            DispatchQueue.main.async { completion() }
            return
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { [weak self] in
            self?.waitForReapAfterSigkill(process: process, completion: completion)
        }
    }

    private static func parseProbeResponse(
        data: Data?,
        response: URLResponse?,
        contract: DesktopContract,
        port: Int
    ) -> DaemonProbeResult {
        guard let http = response as? HTTPURLResponse else {
            return .unreachable
        }
        guard http.statusCode == 200 else {
            return .conflict(
                "端口 \(port) 已被其他 HTTP 服务占用（状态码 \(http.statusCode)，非 Fusa 后台），请关闭占用该端口的程序或更换 AGENT_HUB_PORT。"
            )
        }
        guard let data = data,
              !data.isEmpty,
              let raw = try? JSONSerialization.jsonObject(with: data, options: []),
              let dict = raw as? [String: Any] else {
            return .conflict(
                "端口 \(port) 已被其他服务占用（响应不是有效的 Fusa 身份 JSON），请关闭占用该端口的程序或更换 AGENT_HUB_PORT。"
            )
        }
        guard let product = dict["product"] as? String, product == contract.product else {
            return .conflict(
                "端口 \(port) 已被其他服务或旧版 Fusa 后台占用，请先关闭旧后台或占用程序，再重试；也可更换 AGENT_HUB_PORT。"
            )
        }
        guard let versionNumber = dict["protocolVersion"] as? NSNumber,
              CFGetTypeID(versionNumber) != CFBooleanGetTypeID(),
              versionNumber.doubleValue == Double(versionNumber.intValue) else {
            return .conflict(
                "端口 \(port) 上的 Fusa 后台缺少有效的协议版本号，请停止旧进程或更新应用。"
            )
        }
        let version = versionNumber.intValue
        guard version == contract.protocolVersion else {
            return .conflict(
                "端口 \(port) 上的 Fusa 后台协议版本不兼容（后台版本 \(version)，当前外壳需要版本 \(contract.protocolVersion)），请停止旧进程或更新应用。"
            )
        }
        guard let rawInstanceId = dict["instanceId"] as? String else {
            return .conflict("端口 \(port) 上的服务缺少 Fusa 实例标识（instanceId），拒绝连接。")
        }
        let instanceId = rawInstanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !instanceId.isEmpty, instanceId.utf8.count <= 128,
              instanceId.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }) else {
            return .conflict("端口 \(port) 上的服务返回无效实例标识（instanceId），拒绝连接。")
        }
        return .verified(DaemonIdentity(product: product, protocolVersion: version, instanceId: instanceId))
    }

    private func resolveRepoDir() -> String? {
        let env = ProcessInfo.processInfo.environment
        var candidates: [String] = []
        if let envDir = env["AGENT_HUB_REPO_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines), !envDir.isEmpty {
            candidates.append((envDir as NSString).expandingTildeInPath)
        }
        if let defaultsDir = UserDefaults.standard.string(forKey: "AgentHubRepoDir")?.trimmingCharacters(in: .whitespacesAndNewlines), !defaultsDir.isEmpty {
            candidates.append((defaultsDir as NSString).expandingTildeInPath)
        }
        if let plistDir = Bundle.main.object(forInfoDictionaryKey: "AgentHubRepoDir") as? String {
            let trimmed = plistDir.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                candidates.append((trimmed as NSString).expandingTildeInPath)
            }
        }

        let fm = FileManager.default
        for dir in candidates {
            let entry = (dir as NSString).appendingPathComponent("src/daemon/main.ts")
            if fm.fileExists(atPath: entry) {
                return dir
            }
        }
        return nil
    }

    private func resolveNodePath() -> String? {
        let env = ProcessInfo.processInfo.environment
        let home = NSHomeDirectory() as NSString
        var candidates: [String] = []

        if let envNode = env["AGENT_HUB_NODE"]?.trimmingCharacters(in: .whitespacesAndNewlines), !envNode.isEmpty {
            candidates.append((envNode as NSString).expandingTildeInPath)
        }
        if let plistNode = Bundle.main.object(forInfoDictionaryKey: "AgentHubNodePath") as? String {
            let trimmed = plistNode.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                candidates.append((trimmed as NSString).expandingTildeInPath)
            }
        }
        candidates.append(home.appendingPathComponent(".local/share/mise/shims/node"))
        candidates.append(home.appendingPathComponent(".local/share/mise/installs/node/24/bin/node"))

        let miseNodeRoot = home.appendingPathComponent(".local/share/mise/installs/node")
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: miseNodeRoot) {
            for v in versions.sorted().reversed() where v.hasPrefix("24") {
                candidates.append((miseNodeRoot as NSString).appendingPathComponent("\(v)/bin/node"))
            }
        }

        candidates.append("/opt/homebrew/bin/node")
        candidates.append("/usr/local/bin/node")

        let fm = FileManager.default
        for path in candidates {
            if fm.isExecutableFile(atPath: path) {
                return path
            }
        }
        return nil
    }

    private func openAppendLogHandle() -> FileHandle? {
        let fm = FileManager.default
        let logDir = (logFilePath as NSString).deletingLastPathComponent
        try? fm.createDirectory(atPath: logDir, withIntermediateDirectories: true)
        if contract.logRotatedFiles > 0,
           let size = (try? fm.attributesOfItem(atPath: logFilePath))?[.size] as? Int,
           size >= contract.logMaxBytes {
            for idx in stride(from: contract.logRotatedFiles, through: 1, by: -1) {
                let dst = "\(logFilePath).\(idx)"
                let src = idx == 1 ? logFilePath : "\(logFilePath).\(idx - 1)"
                try? fm.removeItem(atPath: dst)
                if fm.fileExists(atPath: src) {
                    try? fm.moveItem(atPath: src, toPath: dst)
                }
            }
        }
        let fd = Darwin.open(logFilePath, O_WRONLY | O_CREAT | O_APPEND, 0o644)
        guard fd >= 0 else { return nil }
        return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    }

    private func appendToLogFile(_ text: String) {
        appendToLogFile(Data(text.utf8))
    }

    private func appendToLogFile(_ data: Data) {
        logLock.lock()
        defer { logLock.unlock() }
        var offset = 0
        while offset < data.count {
            guard let handle = openAppendLogHandle() else { return }
            let size = Int((try? handle.seekToEnd()) ?? 0)
            let count = min(data.count - offset, max(1, contract.logMaxBytes - size))
            try? handle.write(contentsOf: data.subdata(in: offset..<(offset + count)))
            try? handle.close()
            offset += count
        }
    }

    private func startDaemon(completion: @escaping (Result<Void, Error>) -> Void) {
        // 检查和拉起在同一把锁里做完：退避重启、启动轮询、手动重启几条路同时进来，也只会拉起一个后台
        lock.lock()
        if isShuttingDown || isRestarting {
            lock.unlock()
            DispatchQueue.main.async { completion(.failure(Self.makeError(code: 7, message: "后台服务正在停止。"))) }
            return
        }
        let deadline = Date().addingTimeInterval(contract.startupBudgetSeconds)
        if let existing = spawnedProcess, existing.isRunning {
            lock.unlock()
            pollUntilReady(process: existing, deadline: deadline, completion: completion)
            return
        }
        let spawned = spawnProcessLocked()
        lock.unlock()

        switch spawned {
        case .success(let process):
            pollUntilReady(process: process, deadline: deadline, completion: completion)
        case .failure(let error):
            DispatchQueue.main.async { completion(.failure(error)) }
        }
    }

    /// 调用时必须已持有 lock：拉起子进程并登记到 spawnedProcess。登记要和 run() 在同一把锁里，
    /// 这样 terminationHandler（在后台线程）最快也要等登记完才能处理退出，不会漏掉或错判。
    private func spawnProcessLocked() -> Result<Process, Error> {
        guard let repoDir = resolveRepoDir() else {
            return .failure(Self.makeError(
                code: 1,
                message: "找不到 Fusa 仓库目录（请检查 AGENT_HUB_REPO_DIR 或重新运行 pnpm app:mac）"
            ))
        }

        guard let nodePath = resolveNodePath() else {
            return .failure(Self.makeError(
                code: 2,
                message: "找不到 Node.js 可执行文件（需要 Node 24+，请检查 AGENT_HUB_NODE）"
            ))
        }

        let stderrPipe = Pipe()
        let readHandle = stderrPipe.fileHandleForReading
        let collector = ProcessStderrCollector(
            maxBytes: contract.stderrTailMaxBytes,
            writeLog: { [weak self] data in self?.appendToLogFile(data) }
        )
        let pipeLock = NSLock()
        var pipeClosed = false

        readHandle.readabilityHandler = { handle in
            pipeLock.lock()
            defer { pipeLock.unlock() }
            guard !pipeClosed else { return }
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            collector.append(data)
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        let customEntry = ProcessInfo.processInfo.environment["AGENT_HUB_DAEMON_ENTRY"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        process.arguments = [customEntry?.isEmpty == false ? customEntry! : "src/daemon/main.ts"]
        process.currentDirectoryURL = URL(fileURLWithPath: repoDir)

        var env = ProcessInfo.processInfo.environment
        env["AGENT_HUB_HOME"] = homeDir
        env["AGENT_HUB_PORT"] = String(port)
        env[contract.supervisedEnv] = "fusa-macos"
        let nodeBinDir = (nodePath as NSString).deletingLastPathComponent
        let home = NSHomeDirectory()
        let extraPaths = [
            nodeBinDir,
            "\(home)/.local/share/mise/shims",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "\(home)/.local/bin",
            "\(home)/.npm-global/bin",
            "/usr/bin",
            "/bin",
        ]
        let existingPath = env["PATH"] ?? "/usr/bin:/bin"
        env["PATH"] = (extraPaths + [existingPath]).joined(separator: ":")
        process.environment = env

        let stdoutPipe = Pipe()
        let stdoutRead = stdoutPipe.fileHandleForReading
        stdoutRead.readabilityHandler = { [weak self] handle in
            pipeLock.lock()
            defer { pipeLock.unlock() }
            guard !pipeClosed else { return }
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil }
            else { self?.appendToLogFile(data) }
        }
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        process.terminationHandler = { [weak self] terminatedProcess in
            readHandle.readabilityHandler = nil
            pipeLock.lock()
            if !pipeClosed {
                pipeClosed = true
                let fd = readHandle.fileDescriptor
                let flags = fcntl(fd, F_GETFL)
                if flags >= 0 {
                    _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
                }
                var buf = [UInt8](repeating: 0, count: 4096)
                for _ in 0..<16 {
                    let n = Darwin.read(fd, &buf, buf.count)
                    if n > 0 {
                        collector.append(Data(buf[0..<n]))
                    } else {
                        break
                    }
                }
                try? readHandle.close()
            }
            stdoutRead.readabilityHandler = nil
            let outFD = stdoutRead.fileDescriptor
            let outFlags = fcntl(outFD, F_GETFL)
            if outFlags >= 0 { _ = fcntl(outFD, F_SETFL, outFlags | O_NONBLOCK) }
            var outBuffer = [UInt8](repeating: 0, count: 4096)
            for _ in 0..<16 {
                let n = Darwin.read(outFD, &outBuffer, outBuffer.count)
                if n <= 0 { break }
                self?.appendToLogFile(Data(outBuffer[0..<n]))
            }
            try? stdoutRead.close()
            pipeLock.unlock()
            self?.handleProcessTerminated(terminatedProcess, stderrCollector: collector)
        }

        do {
            try process.run()
            if let token = Self.signalToken(for: process) {
                signalTokens[ObjectIdentifier(process)] = token
            }
            spawnedProcess = process
            ownedInstanceId = nil
            return .success(process)
        } catch {
            readHandle.readabilityHandler = nil
            pipeLock.lock()
            pipeClosed = true
            try? readHandle.close()
            stdoutRead.readabilityHandler = nil
            try? stdoutRead.close()
            pipeLock.unlock()
            return .failure(error)
        }
    }

    private func pollUntilReady(
        process: Process,
        deadline: Date,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        probeIdentity { [weak self] probeResult in
            guard let self = self else { return }
            self.lock.lock()
            let cancelled = self.isShuttingDown || self.isRestarting
            self.lock.unlock()
            if cancelled {
                DispatchQueue.main.async { completion(.failure(Self.makeError(code: 7, message: "后台服务正在停止。"))) }
                return
            }
            switch probeResult {
            case .verified(let identity):
                let nextOwnership: DaemonOwnership
                self.lock.lock()
                if process.isRunning && self.spawnedProcess === process {
                    self.ownedInstanceId = identity.instanceId
                    nextOwnership = .owned(pid: process.processIdentifier, instanceId: identity.instanceId)
                } else {
                    nextOwnership = .external(instanceId: identity.instanceId)
                }
                self.ownership = nextOwnership
                self.conflictReason = nil
                self.lock.unlock()

                self.notifyConflictChange(nil)
                self.notifyOwnershipChange(nextOwnership)
                self.updateState(.running)
                DispatchQueue.main.async {
                    completion(.success(()))
                }

            case .conflict(let reason):
                self.lock.lock()
                if self.spawnedProcess === process {
                    self.spawnedProcess = nil
                    self.ownedInstanceId = nil
                    self.markIntentionalStopLocked(process)
                }
                self.ownership = .none
                self.conflictReason = reason
                self.lock.unlock()

                if process.isRunning {
                    self.signalOwned(process, SIGTERM)
                }
                self.notifyOwnershipChange(.none)
                self.notifyConflictChange(reason)
                let err = Self.makeError(code: 5, message: reason)
                DispatchQueue.main.async { completion(.failure(err)) }

            case .unreachable:
                if !process.isRunning {
                    let err = Self.makeError(
                        code: 3,
                        message: "守护进程启动后提前退出（\(Self.describeExit(of: process))），请查看日志：\(self.logFilePath)"
                    )
                    DispatchQueue.main.async { completion(.failure(err)) }
                    return
                }
                if Date() >= deadline {
                    self.lock.lock()
                    if self.spawnedProcess === process {
                        self.spawnedProcess = nil
                        self.ownedInstanceId = nil
                        self.ownership = .none
                        self.markIntentionalStopLocked(process)
                    }
                    self.lock.unlock()
                    if process.isRunning {
                        self.signalOwned(process, SIGTERM)
                    }
                    let budgetInt = Int(self.contract.startupBudgetSeconds.rounded())
                    let err = Self.makeError(
                        code: 4,
                        message: "等待守护进程就绪超时（\(budgetInt) 秒），请查看日志：\(self.logFilePath)"
                    )
                    DispatchQueue.main.async { completion(.failure(err)) }
                    return
                }
                DispatchQueue.global().asyncAfter(deadline: .now() + self.contract.pollIntervalSeconds) { [weak self] in
                    self?.pollUntilReady(process: process, deadline: deadline, completion: completion)
                }
            }
        }
    }

    private func handleProcessTerminated(_ process: Process, stderrCollector: ProcessStderrCollector) {
        let pid = process.processIdentifier
        let now = Date()

        lock.lock()
        signalTokens.removeValue(forKey: ObjectIdentifier(process))
        if spawnedProcess === process {
            spawnedProcess = nil
            ownedInstanceId = nil
            if case .owned(let ownedPid, _) = ownership, ownedPid == pid {
                ownership = .none
            }
        }
        let wasIntentional = intentionalStopPids.remove(pid) != nil || isShuttingDown
        if wasIntentional {
            lock.unlock()
            return
        }

        // 守护进程空闲排空后主动请求热重启（hub self-reload）：立即拉起新进程，不记崩溃、不退避、不计入熔断窗口
        if process.terminationReason == .exit && Int(process.terminationStatus) == contract.reloadExitCode {
            pendingRestartWorkItem?.cancel()
            pendingRestartWorkItem = nil
            let generation = UUID()
            restartGeneration = generation
            let currentOwn = ownership
            lock.unlock()
            let isoTime = ISO8601DateFormatter().string(from: now)
            appendToLogFile("\(isoTime) [agent-hub] 后台服务（pid \(pid)）空闲排空后请求热重启，立即拉起新进程。\n")
            notifyOwnershipChange(currentOwn)
            DispatchQueue.global().async { [weak self] in
                guard let self = self else { return }
                self.lock.lock()
                if self.isShuttingDown || self.isRestarting || self.restartGeneration != generation {
                    self.lock.unlock()
                    return
                }
                self.lock.unlock()
                self.ensureRunning { _ in }
            }
            return
        }

        let exitDescription = Self.describeExit(of: process)
        let tailLines = stderrCollector.tailLines(maxLines: contract.stderrSummaryMaxLines)
        let summaryReason = Self.buildMenuSummaryReason(
            exitDescription: exitDescription,
            stderrTailLines: tailLines,
            maxChars: contract.menuReasonMaxChars
        )
        let crashRecord = DaemonCrashRecord(
            timestamp: now,
            pid: pid,
            exitDescription: exitDescription,
            stderrTailLines: tailLines,
            menuSummaryReason: summaryReason
        )
        lastCrashRecord = crashRecord

        recentCrashTimestamps = recentCrashTimestamps.filter {
            now.timeIntervalSince($0) <= contract.crashWindowSeconds
        }
        recentCrashTimestamps.append(now)
        let crashCount = recentCrashTimestamps.count
        let shouldStopRetrying = crashCount >= contract.maxCrashesInWindow
        let delaySeconds = contract.backoffDelaySeconds(forCrashCount: crashCount)

        let nextState: DaemonSupervisorState
        if shouldStopRetrying {
            pendingRestartWorkItem?.cancel()
            pendingRestartWorkItem = nil
            nextState = .failed(
                crashCount: crashCount,
                windowSeconds: contract.crashWindowSeconds,
                lastCrash: crashRecord
            )
        } else {
            nextState = .restarting(
                attempt: crashCount,
                maxAttempts: contract.maxCrashesInWindow,
                delaySeconds: delaySeconds,
                lastCrash: crashRecord
            )
        }
        state = nextState
        let currentOwn = ownership
        let generation = UUID()
        restartGeneration = generation
        lock.unlock()

        writeCrashLog(
            now: now,
            pid: pid,
            exitDescription: exitDescription,
            stderrTailLines: tailLines,
            crashCount: crashCount,
            delaySeconds: delaySeconds,
            shouldStopRetrying: shouldStopRetrying
        )

        notifyOwnershipChange(currentOwn)
        notifyStateChange(nextState, lastCrash: crashRecord)

        guard !shouldStopRetrying else { return }

        let workItem = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            self.lock.lock()
            if self.isShuttingDown || self.isRestarting || self.restartGeneration != generation {
                self.lock.unlock()
                return
            }
            self.pendingRestartWorkItem = nil
            self.lock.unlock()

            self.ensureRunning { _ in }
        }

        lock.lock()
        guard restartGeneration == generation, !isShuttingDown, !isRestarting else {
            lock.unlock()
            return
        }
        pendingRestartWorkItem?.cancel()
        pendingRestartWorkItem = workItem
        lock.unlock()

        DispatchQueue.global().asyncAfter(deadline: .now() + delaySeconds, execute: workItem)
    }

    private func writeCrashLog(
        now: Date,
        pid: Int32,
        exitDescription: String,
        stderrTailLines: [String],
        crashCount: Int,
        delaySeconds: TimeInterval,
        shouldStopRetrying: Bool
    ) {
        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let isoTime = isoFormatter.string(from: now)
        let windowInt = Int(contract.crashWindowSeconds)
        let maxCount = contract.maxCrashesInWindow

        var lines: [String] = []
        lines.append("\(isoTime) [agent-hub] 守护进程（PID \(pid)）意外退出：\(exitDescription)")
        if stderrTailLines.isEmpty {
            lines.append("\(isoTime) [agent-hub] 最后 stderr 输出：（无）")
        } else {
            lines.append("\(isoTime) [agent-hub] 最后 \(stderrTailLines.count) 行 stderr：")
            for line in stderrTailLines {
                lines.append("  \(line)")
            }
        }
        if shouldStopRetrying {
            lines.append("\(isoTime) [agent-hub] \(windowInt) 秒内连续崩溃 \(crashCount) 次，已停止自动重启。请排查日志后在菜单栏点击“重启后台服务”。")
        } else {
            let delayText = String(format: "%.1f", delaySeconds)
            lines.append("\(isoTime) [agent-hub] 将在 \(delayText) 秒后自动重启（\(windowInt) 秒内第 \(crashCount)/\(maxCount) 次崩溃）…")
        }
        appendToLogFile(lines.joined(separator: "\n") + "\n")
    }

    private func recordConflict(_ reason: String) {
        let nextOwn: DaemonOwnership
        lock.lock()
        conflictReason = reason
        if spawnedProcess == nil {
            ownership = .none
        }
        nextOwn = ownership
        lock.unlock()
        notifyOwnershipChange(nextOwn)
        notifyConflictChange(reason)
    }

    private func clearConflict() {
        lock.lock()
        let hadConflict = conflictReason != nil
        conflictReason = nil
        lock.unlock()
        if hadConflict {
            notifyConflictChange(nil)
        }
    }

    private func updateState(_ newState: DaemonSupervisorState) {
        lock.lock()
        state = newState
        let crash = lastCrashRecord
        lock.unlock()
        notifyStateChange(newState, lastCrash: crash)
    }

    private func notifyStateChange(_ newState: DaemonSupervisorState, lastCrash: DaemonCrashRecord?) {
        let callback = onStateChange
        if Thread.isMainThread {
            callback?(newState, lastCrash)
        } else {
            DispatchQueue.main.async {
                callback?(newState, lastCrash)
            }
        }
    }

    private func notifyOwnershipChange(_ newOwnership: DaemonOwnership) {
        let callback = onOwnershipChange
        if Thread.isMainThread {
            callback?(newOwnership)
        } else {
            DispatchQueue.main.async {
                callback?(newOwnership)
            }
        }
    }

    private func notifyConflictChange(_ reason: String?) {
        let callback = onConflictChange
        if Thread.isMainThread {
            callback?(reason)
        } else {
            DispatchQueue.main.async {
                callback?(reason)
            }
        }
    }

    private static func makeError(code: Int, message: String) -> NSError {
        NSError(
            domain: "AgentHub.DaemonSupervisor",
            code: code,
            userInfo: [NSLocalizedDescriptionKey: message]
        )
    }

    static func describeExit(of process: Process) -> String {
        let status = process.terminationStatus
        switch process.terminationReason {
        case .uncaughtSignal:
            if let name = signalName(for: status) {
                return "信号 \(status) (\(name))"
            }
            return "信号 \(status)"
        case .exit:
            return "退出码 \(status)"
        @unknown default:
            return "退出码 \(status)"
        }
    }

    private static func signalName(for sig: Int32) -> String? {
        switch sig {
        case SIGHUP: return "SIGHUP"
        case SIGINT: return "SIGINT"
        case SIGQUIT: return "SIGQUIT"
        case SIGILL: return "SIGILL"
        case SIGABRT: return "SIGABRT"
        case SIGFPE: return "SIGFPE"
        case SIGKILL: return "SIGKILL"
        case SIGBUS: return "SIGBUS"
        case SIGSEGV: return "SIGSEGV"
        case SIGPIPE: return "SIGPIPE"
        case SIGALRM: return "SIGALRM"
        case SIGTERM: return "SIGTERM"
        default: return nil
        }
    }

    private static func buildMenuSummaryReason(
        exitDescription: String,
        stderrTailLines: [String],
        maxChars: Int
    ) -> String {
        guard !stderrTailLines.isEmpty else {
            return exitDescription
        }
        let chosenLine = stderrTailLines.last { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            return !trimmed.hasPrefix("at ") && trimmed != "}" && trimmed != "{"
        } ?? stderrTailLines.last!

        var cleaned = chosenLine.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.hasPrefix("[agent-hub] ") {
            cleaned = String(cleaned.dropFirst("[agent-hub] ".count))
        }
        if cleaned.isEmpty {
            return exitDescription
        }
        if cleaned.count > maxChars {
            let idx = cleaned.index(cleaned.startIndex, offsetBy: maxChars)
            cleaned = String(cleaned[..<idx]) + "…"
        }
        return "\(exitDescription)（\(cleaned)）"
    }
}
