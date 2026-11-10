import AppKit

final class StatusBarController: NSObject {
    private let statusItem: NSStatusItem
    private let summaryItem: NSMenuItem
    private let conflictItem: NSMenuItem
    private let lastCrashItem: NSMenuItem
    private let restartItem: NSMenuItem
    private let quitItem: NSMenuItem
    private let onOpenMainWindow: () -> Void
    private let onRestartDaemon: () -> Void
    private let onQuitApp: () -> Void

    private var daemonState: DaemonSupervisorState = .running
    private var ownership: DaemonOwnership = .none
    private var conflictReason: String?
    private var lastRunningWorkers: Int = 0
    private var lastAskingCount: Int = 0
    private var lastWaitingCount: Int = 0

    init(
        onOpenMainWindow: @escaping () -> Void,
        onRestartDaemon: @escaping () -> Void,
        onQuitApp: @escaping () -> Void
    ) {
        self.statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        self.summaryItem = NSMenuItem(title: "后台服务运行中", action: nil, keyEquivalent: "")
        self.summaryItem.isEnabled = false
        self.conflictItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        self.conflictItem.isEnabled = false
        self.conflictItem.isHidden = true
        self.lastCrashItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        self.lastCrashItem.isEnabled = false
        self.lastCrashItem.isHidden = true
        self.restartItem = NSMenuItem(title: "重启后台服务", action: nil, keyEquivalent: "")
        self.quitItem = NSMenuItem(title: "彻底退出 Fusa", action: nil, keyEquivalent: "q")
        self.onOpenMainWindow = onOpenMainWindow
        self.onRestartDaemon = onRestartDaemon
        self.onQuitApp = onQuitApp
        super.init()
        setupStatusItem()
    }

    var currentSummaryTitle: String {
        summaryItem.title
    }

    var currentConflictTitle: String {
        conflictItem.title
    }

    var isConflictVisible: Bool {
        !conflictItem.isHidden
    }

    var currentLastCrashTitle: String {
        lastCrashItem.title
    }

    var isLastCrashVisible: Bool {
        !lastCrashItem.isHidden
    }

    var currentButtonTitle: String {
        statusItem.button?.title ?? ""
    }

    var isRestartEnabled: Bool {
        restartItem.isEnabled
    }

    var currentRestartTitle: String {
        restartItem.title
    }

    var currentQuitTitle: String {
        quitItem.title
    }

    private func setupStatusItem() {
        if let button = statusItem.button {
            if let image = NSImage(systemSymbolName: "bubble.left.and.bubble.right.fill", accessibilityDescription: "Fusa") {
                image.isTemplate = true
                button.image = image
                button.imagePosition = .imageLeading
            } else {
                button.title = "Fusa"
            }
            button.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        }

        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.addItem(summaryItem)
        menu.addItem(conflictItem)
        menu.addItem(lastCrashItem)
        menu.addItem(NSMenuItem.separator())

        let openItem = NSMenuItem(title: "打开主窗口", action: #selector(handleOpenMainWindow), keyEquivalent: "o")
        openItem.target = self
        menu.addItem(openItem)

        restartItem.action = #selector(handleRestartDaemon)
        restartItem.target = self
        menu.addItem(restartItem)

        menu.addItem(NSMenuItem.separator())

        quitItem.action = #selector(handleQuitApp)
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    func updateStatus(runningWorkers: Int, askingCount: Int, waitingCount: Int) {
        lastRunningWorkers = runningWorkers
        lastAskingCount = askingCount
        lastWaitingCount = waitingCount
        refreshDisplay()
    }

    func updateDaemonState(_ state: DaemonSupervisorState, lastCrash: DaemonCrashRecord?) {
        daemonState = state
        if let crash = lastCrash {
            lastCrashItem.title = crash.menuTitle
            lastCrashItem.toolTip = crash.stderrTailLines.isEmpty ? nil : crash.stderrTailLines.joined(separator: "\n")
            lastCrashItem.isHidden = false
        }
        refreshDisplay()
    }

    func updateOwnership(_ newOwnership: DaemonOwnership) {
        ownership = newOwnership
        refreshDisplay()
    }

    func updateConflict(_ reason: String?) {
        conflictReason = reason
        if let reason = reason, !reason.isEmpty {
            let maxChars = SupervisorConfig.menuReasonMaxChars
            let truncated: String
            if reason.count > maxChars {
                let idx = reason.index(reason.startIndex, offsetBy: maxChars)
                truncated = String(reason[..<idx]) + "…"
            } else {
                truncated = reason
            }
            conflictItem.title = truncated
            conflictItem.toolTip = reason
            conflictItem.isHidden = false
        } else {
            conflictItem.title = ""
            conflictItem.toolTip = nil
            conflictItem.isHidden = true
        }
        refreshDisplay()
    }

    private func refreshDisplay() {
        if conflictReason != nil {
            summaryItem.title = "后台端口冲突或协议不兼容"
            restartItem.title = "重新检测后台服务"
            restartItem.isEnabled = true
            quitItem.title = "彻底退出 Fusa"
            statusItem.button?.title = " !"
            NSApp.dockTile.badgeLabel = "!"
            return
        }

        if ownership.isExternal {
            restartItem.title = "重启后台服务（外部管理）"
            restartItem.isEnabled = false
            quitItem.title = "退出 Fusa（保留外部后台）"
        } else {
            restartItem.title = "重启后台服务"
            restartItem.isEnabled = true
            quitItem.title = "彻底退出 Fusa"
        }

        switch daemonState {
        case .running:
            var parts: [String] = []
            if lastRunningWorkers > 0 {
                parts.append("\(lastRunningWorkers) 个 Worker 在跑")
            }
            if lastAskingCount > 0 {
                parts.append("\(lastAskingCount) 项等你确定")
            }
            if lastWaitingCount > 0 {
                parts.append("\(lastWaitingCount) 项等你")
            }
            let baseTitle = parts.isEmpty ? "后台服务运行中" : parts.joined(separator: "，")
            summaryItem.title = ownership.isExternal ? "\(baseTitle)（外部管理）" : baseTitle

            if let button = statusItem.button {
                if lastAskingCount > 0 {
                    button.title = " \(lastAskingCount)"
                } else if lastRunningWorkers > 0 {
                    button.title = " \(lastRunningWorkers)"
                } else {
                    button.title = ""
                }
            }
            let badgeCount = lastAskingCount + lastWaitingCount
            NSApp.dockTile.badgeLabel = badgeCount > 0 ? "\(badgeCount)" : nil

        case .restarting(let attempt, let maxAttempts, let delaySeconds, _):
            let delayInt = max(1, Int(delaySeconds.rounded()))
            summaryItem.title = "后台意外退出，\(delayInt) 秒后自动重启（\(attempt)/\(maxAttempts)）…"
            statusItem.button?.title = " …"

        case .failed(let crashCount, _, _):
            summaryItem.title = "后台服务异常停止（连续崩溃 \(crashCount) 次，已停止重试）"
            statusItem.button?.title = " !"
            NSApp.dockTile.badgeLabel = "!"
        }
    }

    @objc private func handleOpenMainWindow() {
        onOpenMainWindow()
    }

    @objc private func handleRestartDaemon() {
        guard restartItem.isEnabled else { return }
        onRestartDaemon()
    }

    @objc private func handleQuitApp() {
        onQuitApp()
    }
}
