import AppKit
import UserNotifications

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private let supervisor = DaemonSupervisor()
    private var windowController: MainWindowController!
    private var statusBarController: StatusBarController!

    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
        setupMainMenu()

        statusBarController = StatusBarController(
            onOpenMainWindow: { [weak self] in
                self?.windowController.showWindow()
            },
            onRestartDaemon: { [weak self] in
                self?.restartBackend()
            },
            onQuitApp: {
                NSApp.terminate(nil)
            }
        )

        windowController = MainWindowController(
            supervisor: supervisor,
            onStatusUpdate: { [weak self] runningWorkers, askingCount, waitingCount in
                self?.statusBarController.updateStatus(
                    runningWorkers: runningWorkers,
                    askingCount: askingCount,
                    waitingCount: waitingCount
                )
            }
        )

        supervisor.onOwnershipChange = { [weak self] ownership in
            self?.statusBarController.updateOwnership(ownership)
        }

        supervisor.onConflictChange = { [weak self] reason in
            self?.statusBarController.updateConflict(reason)
        }

        supervisor.onStateChange = { [weak self] state, lastCrash in
            guard let self = self else { return }
            self.statusBarController.updateDaemonState(state, lastCrash: lastCrash)
            switch state {
            case .running:
                if self.windowController.isShowingErrorPage && self.supervisor.currentConflictReason == nil {
                    self.windowController.reload()
                }
            case .restarting:
                break
            case .failed(let crashCount, let windowSeconds, let crash):
                self.windowController.showStartupError(
                    "后台服务在 \(Int(windowSeconds)) 秒内连续崩溃 \(crashCount) 次，已停止自动重启。\n\(crash.menuTitle)"
                )
            }
        }

        windowController.showWindow()
        startAndLoad()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            windowController.showWindow()
        }
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard supervisor.currentOwnership.isOwned || supervisor.currentPid != nil else {
            supervisor.stopIfOwned()
            return .terminateNow
        }
        supervisor.stopOwned {
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        supervisor.stopIfOwned()
    }

    // MARK: - UNUserNotificationCenterDelegate

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .list])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let id = response.notification.request.content.userInfo["notificationId"] as? String ?? ""
        windowController.handleNotificationClicked(id: id)
        completionHandler()
    }

    // MARK: - Helpers

    private func startAndLoad() {
        supervisor.ensureRunning { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success:
                self.windowController.loadHub()
            case .failure(let error):
                self.windowController.showStartupError(error.localizedDescription)
            }
        }
    }

    private func restartBackend() {
        supervisor.restartDaemon { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success:
                self.windowController.reload()
            case .failure(let error):
                self.windowController.showStartupError(error.localizedDescription)
            }
        }
    }

    @objc private func handleOpenMainWindowMenu() {
        windowController.showWindow()
    }

    @objc private func handleReloadMenu() {
        if windowController.isShowingErrorPage {
            startAndLoad()
        } else {
            windowController.reload()
        }
    }

    private func setupMainMenu() {
        let mainMenu = NSMenu()

        // 应用菜单
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenuItem.submenu = appMenu
        appMenu.addItem(withTitle: "隐藏 Fusa", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "全部显示", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "彻底退出 Fusa", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        // 文件菜单
        let fileMenuItem = NSMenuItem()
        mainMenu.addItem(fileMenuItem)
        let fileMenu = NSMenu(title: "文件")
        fileMenuItem.submenu = fileMenu
        let openItem = NSMenuItem(title: "打开主窗口", action: #selector(handleOpenMainWindowMenu), keyEquivalent: "o")
        openItem.target = self
        fileMenu.addItem(openItem)
        fileMenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

        // 编辑菜单（保证 WKWebView 内 Cmd+C / Cmd+V / Cmd+A / Cmd+Z 正常工作）
        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "编辑")
        editMenuItem.submenu = editMenu
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        // 视图菜单
        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let viewMenu = NSMenu(title: "视图")
        viewMenuItem.submenu = viewMenu
        let reloadItem = NSMenuItem(title: "刷新页面", action: #selector(handleReloadMenu), keyEquivalent: "r")
        reloadItem.target = self
        viewMenu.addItem(reloadItem)

        // 窗口菜单
        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let windowMenu = NSMenu(title: "窗口")
        windowMenuItem.submenu = windowMenu
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")

        NSApp.mainMenu = mainMenu
        NSApp.windowsMenu = windowMenu
    }
}
