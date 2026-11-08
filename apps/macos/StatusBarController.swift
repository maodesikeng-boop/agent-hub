import AppKit

final class StatusBarController: NSObject {
    private let statusItem: NSStatusItem
    private let summaryItem: NSMenuItem
    private let onOpenMainWindow: () -> Void
    private let onRestartDaemon: () -> Void
    private let onQuitApp: () -> Void

    init(
        onOpenMainWindow: @escaping () -> Void,
        onRestartDaemon: @escaping () -> Void,
        onQuitApp: @escaping () -> Void
    ) {
        self.statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        self.summaryItem = NSMenuItem(title: "后台服务运行中", action: nil, keyEquivalent: "")
        self.summaryItem.isEnabled = false
        self.onOpenMainWindow = onOpenMainWindow
        self.onRestartDaemon = onRestartDaemon
        self.onQuitApp = onQuitApp
        super.init()
        setupStatusItem()
    }

    private func setupStatusItem() {
        if let button = statusItem.button {
            if let image = NSImage(systemSymbolName: "bubble.left.and.bubble.right.fill", accessibilityDescription: "Agent Hub") {
                image.isTemplate = true
                button.image = image
                button.imagePosition = .imageLeading
            } else {
                button.title = "Hub"
            }
            button.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        }

        let menu = NSMenu()
        menu.addItem(summaryItem)
        menu.addItem(NSMenuItem.separator())

        let openItem = NSMenuItem(title: "打开主窗口", action: #selector(handleOpenMainWindow), keyEquivalent: "o")
        openItem.target = self
        menu.addItem(openItem)

        let restartItem = NSMenuItem(title: "重启后台服务", action: #selector(handleRestartDaemon), keyEquivalent: "")
        restartItem.target = self
        menu.addItem(restartItem)

        menu.addItem(NSMenuItem.separator())

        let quitItem = NSMenuItem(title: "彻底退出 Agent Hub", action: #selector(handleQuitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)

        statusItem.menu = menu
    }

    func updateStatus(runningWorkers: Int, askingCount: Int, waitingCount: Int) {
        var parts: [String] = []
        if runningWorkers > 0 {
            parts.append("\(runningWorkers) 个 Worker 在跑")
        }
        if askingCount > 0 {
            parts.append("\(askingCount) 项等你确定")
        }
        if waitingCount > 0 {
            parts.append("\(waitingCount) 项等你")
        }
        summaryItem.title = parts.isEmpty ? "后台服务运行中" : parts.joined(separator: " · ")

        if let button = statusItem.button {
            if askingCount > 0 {
                button.title = " \(askingCount)"
            } else if runningWorkers > 0 {
                button.title = " \(runningWorkers)"
            } else {
                button.title = ""
            }
        }

        let badgeCount = askingCount + waitingCount
        NSApp.dockTile.badgeLabel = badgeCount > 0 ? "\(badgeCount)" : nil
    }

    @objc private func handleOpenMainWindow() {
        onOpenMainWindow()
    }

    @objc private func handleRestartDaemon() {
        onRestartDaemon()
    }

    @objc private func handleQuitApp() {
        onQuitApp()
    }
}
