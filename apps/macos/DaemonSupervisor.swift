import Foundation

final class DaemonSupervisor {
    let homeDir: String
    let port: Int
    private var spawnedProcess: Process?
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
            self.port = defaultsPort > 0 ? defaultsPort : 4317
        }
    }

    var baseURL: URL {
        URL(string: "http://127.0.0.1:\(port)")!
    }

    var stateURL: URL {
        URL(string: "http://127.0.0.1:\(port)/api/state")!
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

    func readUiToken() -> String? {
        guard let data = FileManager.default.contents(atPath: uiTokenPath),
              let raw = String(data: data, encoding: .utf8) else {
            return nil
        }
        let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return token.isEmpty ? nil : token
    }

    /// 探测 http://127.0.0.1:4317/api/state（超时 500ms）；只要返回任何 HTTP 状态码（如 200 或 401）说明已在运行。
    func probe(completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: stateURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 0.5
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

    /// 确保守护进程在运行：已在跑则直接复用，未跑则后台拉起 node src/daemon/main.ts 并轮询就绪。
    func ensureRunning(completion: @escaping (Result<Void, Error>) -> Void) {
        probe { [weak self] running in
            guard let self = self else { return }
            if running {
                DispatchQueue.main.async {
                    completion(.success(()))
                }
                return
            }
            self.startDaemon(completion: completion)
        }
    }

    func restartDaemon(completion: @escaping (Result<Void, Error>) -> Void) {
        lock.lock()
        let proc = spawnedProcess
        spawnedProcess = nil
        lock.unlock()

        if let proc = proc, proc.isRunning {
            proc.terminate()
        }
        waitForShutdown(attemptsLeft: 20) { [weak self] in
            self?.ensureRunning(completion: completion)
        }
    }

    func stopIfOwned() {
        lock.lock()
        let proc = spawnedProcess
        spawnedProcess = nil
        lock.unlock()

        if let proc = proc, proc.isRunning {
            proc.terminate()
        }
    }

    private func waitForShutdown(attemptsLeft: Int, completion: @escaping () -> Void) {
        guard attemptsLeft > 0 else {
            completion()
            return
        }
        probe { [weak self] running in
            if !running {
                completion()
                return
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.15) {
                self?.waitForShutdown(attemptsLeft: attemptsLeft - 1, completion: completion)
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

    private func startDaemon(completion: @escaping (Result<Void, Error>) -> Void) {
        guard let repoDir = resolveRepoDir() else {
            let err = NSError(
                domain: "AgentHub.DaemonSupervisor",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "找不到 Agent Hub 仓库目录（请检查 AGENT_HUB_REPO_DIR 或重新运行 pnpm app:mac）"]
            )
            DispatchQueue.main.async { completion(.failure(err)) }
            return
        }

        guard let nodePath = resolveNodePath() else {
            let err = NSError(
                domain: "AgentHub.DaemonSupervisor",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "找不到 Node.js 可执行文件（需要 Node 24+，请检查 AGENT_HUB_NODE）"]
            )
            DispatchQueue.main.async { completion(.failure(err)) }
            return
        }

        let fm = FileManager.default
        let logDir = (logFilePath as NSString).deletingLastPathComponent
        try? fm.createDirectory(atPath: logDir, withIntermediateDirectories: true)
        if !fm.fileExists(atPath: logFilePath) {
            fm.createFile(atPath: logFilePath, contents: nil)
        }
        let logHandle = FileHandle(forWritingAtPath: logFilePath)
        logHandle?.seekToEndOfFile()

        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = ["src/daemon/main.ts"]
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
            process.standardError = logHandle
        }

        do {
            try process.run()
            lock.lock()
            spawnedProcess = process
            lock.unlock()
        } catch {
            DispatchQueue.main.async { completion(.failure(error)) }
            return
        }

        pollUntilReady(process: process, attemptsLeft: 100, completion: completion)
    }

    private func pollUntilReady(process: Process, attemptsLeft: Int, completion: @escaping (Result<Void, Error>) -> Void) {
        probe { [weak self] running in
            guard let self = self else { return }
            if running {
                DispatchQueue.main.async {
                    completion(.success(()))
                }
                return
            }
            if !process.isRunning {
                let err = NSError(
                    domain: "AgentHub.DaemonSupervisor",
                    code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "守护进程启动后提前退出（退出码 \(process.terminationStatus)），请查看日志：\(self.logFilePath)"]
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
                DispatchQueue.main.async { completion(.failure(err)) }
                return
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.15) {
                self.pollUntilReady(process: process, attemptsLeft: attemptsLeft - 1, completion: completion)
            }
        }
    }
}
