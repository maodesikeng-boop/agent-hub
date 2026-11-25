import AppKit
import Foundation

// The traffic lights sit on the middle of the page's 40pt wood top bar, and stay there after AppKit lays the title bar
// out again. The window never comes on screen, so the test does not take focus.
// Build and run:
//   swiftc -framework AppKit -framework WebKit -framework UserNotifications \
//     apps/macos/MainWindowController.swift apps/macos/DaemonSupervisor.swift apps/macos/ShellNavigationPolicy.swift \
//     apps/macos/Tests/TrafficLightTests.swift -o /tmp/TrafficLightTests && /tmp/TrafficLightTests

@main
enum TrafficLightTestsMain {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        var failures: [String] = []
        func expect(_ ok: Bool, _ message: String) {
            print("\(ok ? "PASS" : "FAIL") \(message)")
            if !ok { failures.append(message) }
        }

        let top = MainWindowController.webTopBarHeight
        expect(MainWindowController.trafficLightOriginY(barHeight: 28, barIsFlipped: false, buttonHeight: 16) == 0,
               "a 16pt button in a 28pt bottom-up title bar sits at y 0, centered 20pt from the top")
        expect(MainWindowController.trafficLightOriginY(barHeight: 32, barIsFlipped: true, buttonHeight: 14) == (top - 14) / 2,
               "in a flipped title bar the origin is measured from the top")

        let root = (NSTemporaryDirectory() as NSString).appendingPathComponent("fusa-traffic-lights-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(atPath: root) }
        let supervisor = DaemonSupervisor(homeDir: root, port: 1)
        let controller = MainWindowController(supervisor: supervisor, onStatusUpdate: { _, _, _ in })
        let window = controller.window

        func centers() -> [CGFloat] {
            let frame = window.contentView?.superview
            frame?.layoutSubtreeIfNeeded()
            return [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].compactMap { type in
                guard let button = window.standardWindowButton(type), let superview = button.superview else { return nil }
                let inWindow = superview.convert(button.frame, to: nil)
                return window.frame.height - inWindow.midY
            }
        }

        controller.centerTrafficLights()
        let first = centers()
        expect(first.count == 3, "the window has all three traffic lights (\(first.count))")
        expect(first.allSatisfy { abs($0 - top / 2) < 0.5 }, "each light is centered \(top / 2)pt from the top (\(first))")

        window.setContentSize(NSSize(width: 1000, height: 700))
        let afterResize = centers()
        expect(afterResize.allSatisfy { abs($0 - top / 2) < 0.5 }, "a resize keeps them centered (\(afterResize))")

        if failures.isEmpty {
            print("ALL PASS")
            exit(0)
        }
        print("\(failures.count) FAILED")
        exit(1)
    }
}
