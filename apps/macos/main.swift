import AppKit
import Darwin

// 分发包无窗口自检（CI 冒烟用）：不起界面，跑完就退出
if CommandLine.arguments.dropFirst().contains(FusaSelfTest.flag) {
    exit(FusaSelfTest.run())
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
