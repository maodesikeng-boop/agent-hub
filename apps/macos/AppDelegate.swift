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
                    "The daemon crashed \(crashCount) times within \(Int(windowSeconds)) seconds. Automatic restarts are stopped.\n\(crash.menuTitle)"
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

        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenuItem.submenu = appMenu
        appMenu.addItem(withTitle: "Hide Bellwood", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit Bellwood", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let fileMenuItem = NSMenuItem()
        mainMenu.addItem(fileMenuItem)
        let fileMenu = NSMenu(title: "File")
        fileMenuItem.submenu = fileMenu
        let openItem = NSMenuItem(title: "Open Main Window", action: #selector(handleOpenMainWindowMenu), keyEquivalent: "o")
        openItem.target = self
        fileMenu.addItem(openItem)
        fileMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

        // The Edit menu is what routes Cmd+C/V/A/Z into WKWebView.
        let editMenuItem = NSMenuItem()
        mainMenu.addItem(editMenuItem)
        let editMenu = NSMenu(title: "Edit")
        editMenuItem.submenu = editMenu
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let viewMenuItem = NSMenuItem()
        mainMenu.addItem(viewMenuItem)
        let viewMenu = NSMenu(title: "View")
        viewMenuItem.submenu = viewMenu
        let reloadItem = NSMenuItem(title: "Reload Page", action: #selector(handleReloadMenu), keyEquivalent: "r")
        reloadItem.target = self
        viewMenu.addItem(reloadItem)

        let windowMenuItem = NSMenuItem()
        mainMenu.addItem(windowMenuItem)
        let windowMenu = NSMenu(title: "Window")
        windowMenuItem.submenu = windowMenu
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")

        NSApp.mainMenu = mainMenu
        NSApp.windowsMenu = windowMenu
    }
}
