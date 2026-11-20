import AppKit
import Darwin

if CommandLine.arguments.dropFirst().contains(FusaSelfTest.flag) {
    exit(FusaSelfTest.run())
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
