import Darwin
import Foundation

/// 守护进程监管器的可调常量集中在此处，避免魔法数字散落各处。
enum SupervisorConfig {
    /// 默认界面端口（与 src/shared/limits.ts 的 DEFAULT_UI_PORT 一致）
    static let defaultPort: Int = 4317
    /// 单次 HTTP 探活超时（秒）
    static let probeTimeoutSeconds: TimeInterval = 0.5
    /// 启动或停止轮询间隔（秒）
    static let pollIntervalSeconds: TimeInterval = 0.15
    /// 启动就绪最大轮询次数（100 * 0.15s = 15s）
    static let startupPollMaxAttempts: Int = 100
    /// 停止等待最大轮询次数（20 * 0.15s = 3s）
    static let shutdownPollMaxAttempts: Int = 20

    /// 意外退出自动重启：初始退避间隔（秒）
    static let restartInitialBackoffSeconds: TimeInterval = 1.0
    /// 意外退出自动重启：退避倍增系数（1s, 2s, 4s, 8s, 16s...）
    static let restartBackoffMultiplier: Double = 2.0
    /// 意外退出自动重启：最大退避间隔封顶（秒）
    static let restartMaxBackoffSeconds: TimeInterval = 30.0
    /// 连续崩溃统计时间窗口（秒）：1 分钟
    static let crashWindowSeconds: TimeInterval = 60.0
    /// 时间窗口内最大连续崩溃次数（如 1 分钟内 5 次后停止自动重试）
    static let maxCrashCountInWindow: Int = 5

    /// 捕获子进程 stderr 尾部缓冲最大字节数
    static let stderrTailMaxBytes: Int = 4096
    /// 写入崩溃日志时附带的最后 stderr 行数上限
    static let stderrTailMaxLines: Int = 8
    /// 菜单栏展示上次崩溃原因里单行摘要最大字符数
    static let menuReasonMaxChars: Int = 60

    /// desktop-daemon.log 的大小上限（字节）：每次拉起前超过就改名成 .log.1（覆盖旧的），磁盘上最多两份；
    /// 同一个进程一次运行里写进去的也不超过它（超了丢弃并留一句说明），日志不会无限变大
    static let logMaxBytes: Int = 2 * 1024 * 1024
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
    private let logMaxBytes: Int
    private let logHandle: FileHandle?
    private var loggedBytes = 0

    init(maxBytes: Int, logMaxBytes: Int, logHandle: FileHandle?) {
        self.maxBytes = maxBytes
        self.logMaxBytes = logMaxBytes
        self.logHandle = logHandle
    }

    func append(_ data: Data) {
        guard !data.isEmpty else { return }
        lock.lock()
        if loggedBytes < logMaxBytes {
            loggedBytes += data.count
            try? logHandle?.write(contentsOf: data)
            if loggedBytes >= logMaxBytes {
                try? logHandle?.write(contentsOf: Data("\n[agent-hub] 这次运行的 stderr 超过日志上限，后面的不再写入文件。\n".utf8))
            }
        }
        buffer.append(data)
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

final class DaemonSupervisor {
    let homeDir: String
    let port: Int
    var onStateChange: ((DaemonSupervisorState, DaemonCrashRecord?) -> Void)?

    private var spawnedProcess: Process?
    private var intentionalStopPids: Set<Int32> = []
    private var isShuttingDown = false
    private var recentCrashTimestamps: [Date] = []
    private var lastCrashRecord: DaemonCrashRecord?
    private var state: DaemonSupervisorState = .running
    private var pendingRestartWorkItem: DispatchWorkItem?
    /// 用户点“重启后台服务”后到旧进程退出这段时间：别的路径（退避重启、启动轮询）不许拉起新进程，免得和旧进程抢端口
    private var isRestarting = false
    private let lock = NSLock()

    init() {
        let env = ProcessInfo.processInfo.environment
        if let customHome = env["AGENT_HUB_HOME"]?.trimmingCharacters(in: .whitespacesAndNewlines), !customHome.isEmpty {
            self.homeDir = (customHome as NSString).expandingTildeInPath
        } else {
            self.homeDir = (NSHomeDirectory() as NSString).appendingPathComponent(".agent-hub")
        }

        if let envPortStr = env["AGENT_HUB_PORT"], let envPort = Int(envPortStr), envPort > 0 {
            self.port = envPort
        } else {
            let defaultsPort = UserDefaults.standard.integer(forKey: "AgentHubPort")
            self.port = defaultsPort > 0 ? defaultsPort : SupervisorConfig.defaultPort
        }
    }

    var baseURL: URL {
        URL(string: "http://127.0.0.1:\(port)")!
    }

    var probeURL: URL {
        URL(string: "http://127.0.0.1:\(port)/api/auth/status")!
    }

    var cookieName: String {
        "agent_hub_ui_\(port)"
    }

    var uiTokenPath: String {
        (homeDir as NSString).appendingPathComponent("state/ui-token")
    }

    var logFilePath: String {
        (homeDir as NSString).appendingPathComponent("state/logs/desktop-daemon.log")
    }

    var currentPid: Int32? {
        lock.lock()
        defer { lock.unlock() }
        guard let proc = spawnedProcess, proc.isRunning else { return nil }
        return proc.processIdentifier
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

    /// 探测 http://127.0.0.1:4317/api/auth/status（超时 500ms，轻量无需查库）；只要返回任何 HTTP 状态码说明已在运行。
    func probe(completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: probeURL)
        request.httpMethod = "GET"
        request.timeoutInterval = SupervisorConfig.probeTimeoutSeconds
        request.cachePolicy = .reloadIgnoringLocalCacheData

        let task = URLSession.shared.dataTask(with: request) { _, response, _ in
            if let http = response as? HTTPURLResponse, http.statusCode > 0 {
                completion(true)
            } else {
                completion(false)
            }
        }
        task.resume()
    }

    /// 确保守护进程在运行：已在跑则直接复用（不接管），未跑则后台拉起 node src/daemon/main.ts 并轮询就绪。
    func ensureRunning(completion: @escaping (Result<Void, Error>) -> Void) {
        probe { [weak self] running in
            guard let self = self else { return }
            if running {
                self.updateState(.running)
                DispatchQueue.main.async {
                    completion(.success(()))
                }
                return
            }
            self.startDaemon(completion: completion)
        }
    }

    /// 用户主动点菜单“重启后台服务”：该次退出标记为主动停止，不计入崩溃，同时重置连续崩溃计数。
    func restartDaemon(completion: @escaping (Result<Void, Error>) -> Void) {
        lock.lock()
        pendingRestartWorkItem?.cancel()
        pendingRestartWorkItem = nil
        recentCrashTimestamps.removeAll()
        isRestarting = true
        let proc = spawnedProcess
        spawnedProcess = nil
        if let proc = proc {
            intentionalStopPids.insert(proc.processIdentifier)
        }
        lock.unlock()

        if let proc = proc, proc.isRunning {
            proc.terminate()
        }
        waitForShutdown(process: proc, attemptsLeft: SupervisorConfig.shutdownPollMaxAttempts) { [weak self] in
            self?.lock.lock()
            self?.isRestarting = false
            self?.lock.unlock()
            self?.ensureRunning(completion: completion)
        }
    }

    /// 外壳退出时停止由本应用拉起的守护进程（不计入崩溃）；外部终端 pnpm start 起的进程因 spawnedProcess 为 nil 不会受影响。
    func stopIfOwned() {
        lock.lock()
        isShuttingDown = true
        pendingRestartWorkItem?.cancel()
        pendingRestartWorkItem = nil
        let proc = spawnedProcess
        spawnedProcess = nil
        if let proc = proc {
            intentionalStopPids.insert(proc.processIdentifier)
        }
        lock.unlock()

        if let proc = proc, proc.isRunning {
            proc.terminate()
        }
    }

    private func waitForShutdown(process: Process?, attemptsLeft: Int, completion: @escaping () -> Void) {
        guard attemptsLeft > 0 else {
            if let proc = process, proc.isRunning {
                kill(proc.processIdentifier, SIGKILL)
            }
            completion()
            return
        }
        if let proc = process, proc.isRunning {
            DispatchQueue.global().asyncAfter(deadline: .now() + SupervisorConfig.pollIntervalSeconds) { [weak self] in
                self?.waitForShutdown(process: process, attemptsLeft: attemptsLeft - 1, completion: completion)
            }
            return
        }
        probe { [weak self] running in
            if !running {
                completion()
                return
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + SupervisorConfig.pollIntervalSeconds) {
                self?.waitForShutdown(process: process, attemptsLeft: attemptsLeft - 1, completion: completion)
            }
        }
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
        if let size = (try? fm.attributesOfItem(atPath: logFilePath))?[.size] as? Int, size > SupervisorConfig.logMaxBytes {
            let rotated = logFilePath + ".1"
            try? fm.removeItem(atPath: rotated)
            try? fm.moveItem(atPath: logFilePath, toPath: rotated)
        }
        let fd = Darwin.open(logFilePath, O_WRONLY | O_CREAT | O_APPEND, 0o644)
        guard fd >= 0 else { return nil }
        return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    }

    private func appendToLogFile(_ text: String) {
        guard let handle = openAppendLogHandle(),
              let data = text.data(using: .utf8) else { return }
        try? handle.write(contentsOf: data)
        try? handle.close()
    }

    private func startDaemon(completion: @escaping (Result<Void, Error>) -> Void) {
        // 检查和拉起在同一把锁里做完：退避重启、启动轮询、手动重启几条路同时进来，也只会拉起一个后台
        lock.lock()
        if isShuttingDown || isRestarting {
            lock.unlock()
            return
        }
        if let existing = spawnedProcess, existing.isRunning {
            lock.unlock()
            pollUntilReady(process: existing, attemptsLeft: SupervisorConfig.startupPollMaxAttempts, completion: completion)
            return
        }
        let spawned = spawnProcessLocked()
        lock.unlock()

        switch spawned {
        case .success(let process):
            pollUntilReady(process: process, attemptsLeft: SupervisorConfig.startupPollMaxAttempts, completion: completion)
        case .failure(let error):
            DispatchQueue.main.async { completion(.failure(error)) }
        }
    }

    /// 调用时必须已持有 lock：拉起子进程并登记到 spawnedProcess。登记要和 run() 在同一把锁里，
    /// 这样 terminationHandler（在后台线程）最快也要等登记完才能处理退出，不会漏掉或错判。
    private func spawnProcessLocked() -> Result<Process, Error> {
        guard let repoDir = resolveRepoDir() else {
            return .failure(NSError(
                domain: "AgentHub.DaemonSupervisor",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "找不到 Fusa 仓库目录（请检查 AGENT_HUB_REPO_DIR 或重新运行 pnpm app:mac）"]
            ))
        }

        guard let nodePath = resolveNodePath() else {
            return .failure(NSError(
                domain: "AgentHub.DaemonSupervisor",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "找不到 Node.js 可执行文件（需要 Node 24+，请检查 AGENT_HUB_NODE）"]
            ))
        }

        let logHandle = openAppendLogHandle()
        let stderrPipe = Pipe()
        let readHandle = stderrPipe.fileHandleForReading
        let collector = ProcessStderrCollector(
            maxBytes: SupervisorConfig.stderrTailMaxBytes,
            logMaxBytes: SupervisorConfig.logMaxBytes,
            logHandle: logHandle
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

        if let logHandle = logHandle {
            process.standardOutput = logHandle
        }
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
                while true {
                    let n = Darwin.read(fd, &buf, buf.count)
                    if n > 0 {
                        collector.append(Data(buf[0..<n]))
                    } else {
                        break
                    }
                }
                try? readHandle.close()
            }
            pipeLock.unlock()
            try? logHandle?.close()
            self?.handleProcessTerminated(terminatedProcess, stderrCollector: collector)
        }

        do {
            try process.run()
            spawnedProcess = process
            return .success(process)
        } catch {
            readHandle.readabilityHandler = nil
            pipeLock.lock()
            pipeClosed = true
            try? readHandle.close()
            pipeLock.unlock()
            try? logHandle?.close()
            return .failure(error)
        }
    }

    private func pollUntilReady(process: Process, attemptsLeft: Int, completion: @escaping (Result<Void, Error>) -> Void) {
        probe { [weak self] running in
            guard let self = self else { return }
            if running && process.isRunning {
                self.updateState(.running)
                DispatchQueue.main.async {
                    completion(.success(()))
                }
                return
            }
            if !process.isRunning {
                let err = NSError(
                    domain: "AgentHub.DaemonSupervisor",
                    code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "守护进程启动后提前退出（\(Self.describeExit(of: process))），请查看日志：\(self.logFilePath)"]
                )
                DispatchQueue.main.async { completion(.failure(err)) }
                return
            }
            if attemptsLeft <= 0 {
                let err = NSError(
                    domain: "AgentHub.DaemonSupervisor",
                    code: 4,
                    userInfo: [NSLocalizedDescriptionKey: "等待守护进程就绪超时（15 秒），请查看日志：\(self.logFilePath)"]
                )
                if process.isRunning {
                    process.terminate()
                }
                DispatchQueue.main.async { completion(.failure(err)) }
                return
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + SupervisorConfig.pollIntervalSeconds) {
                self.pollUntilReady(process: process, attemptsLeft: attemptsLeft - 1, completion: completion)
            }
        }
    }

    private func handleProcessTerminated(_ process: Process, stderrCollector: ProcessStderrCollector) {
        let pid = process.processIdentifier
        let now = Date()

        lock.lock()
        if spawnedProcess === process {
            spawnedProcess = nil
        }
        let wasIntentional = intentionalStopPids.remove(pid) != nil || isShuttingDown
        if wasIntentional {
            lock.unlock()
            return
        }

        let exitDescription = Self.describeExit(of: process)
        let tailLines = stderrCollector.tailLines(maxLines: SupervisorConfig.stderrTailMaxLines)
        let summaryReason = Self.buildMenuSummaryReason(exitDescription: exitDescription, stderrTailLines: tailLines)
        let crashRecord = DaemonCrashRecord(
            timestamp: now,
            pid: pid,
            exitDescription: exitDescription,
            stderrTailLines: tailLines,
            menuSummaryReason: summaryReason
        )
        lastCrashRecord = crashRecord

        recentCrashTimestamps = recentCrashTimestamps.filter {
            now.timeIntervalSince($0) <= SupervisorConfig.crashWindowSeconds
        }
        recentCrashTimestamps.append(now)
        let crashCount = recentCrashTimestamps.count
        let shouldStopRetrying = crashCount >= SupervisorConfig.maxCrashCountInWindow

        let rawDelay = SupervisorConfig.restartInitialBackoffSeconds * pow(
            SupervisorConfig.restartBackoffMultiplier,
            Double(max(0, crashCount - 1))
        )
        let delaySeconds = min(SupervisorConfig.restartMaxBackoffSeconds, rawDelay)

        let nextState: DaemonSupervisorState
        if shouldStopRetrying {
            pendingRestartWorkItem?.cancel()
            pendingRestartWorkItem = nil
            nextState = .failed(
                crashCount: crashCount,
                windowSeconds: SupervisorConfig.crashWindowSeconds,
                lastCrash: crashRecord
            )
        } else {
            nextState = .restarting(
                attempt: crashCount,
                maxAttempts: SupervisorConfig.maxCrashCountInWindow,
                delaySeconds: delaySeconds,
                lastCrash: crashRecord
            )
        }
        state = nextState
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

        notifyStateChange(nextState, lastCrash: crashRecord)

        guard !shouldStopRetrying else { return }

        var workItem: DispatchWorkItem!
        workItem = DispatchWorkItem { [weak self] in
            guard let self = self, !workItem.isCancelled else { return }
            self.lock.lock()
            if self.isShuttingDown {
                self.lock.unlock()
                return
            }
            self.pendingRestartWorkItem = nil
            self.lock.unlock()

            self.ensureRunning { _ in }
        }

        lock.lock()
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
        let windowInt = Int(SupervisorConfig.crashWindowSeconds)
        let maxCount = SupervisorConfig.maxCrashCountInWindow

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

    private static func buildMenuSummaryReason(exitDescription: String, stderrTailLines: [String]) -> String {
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
        if cleaned.count > SupervisorConfig.menuReasonMaxChars {
            let idx = cleaned.index(cleaned.startIndex, offsetBy: SupervisorConfig.menuReasonMaxChars)
            cleaned = String(cleaned[..<idx]) + "…"
        }
        return "\(exitDescription)（\(cleaned)）"
    }
}
