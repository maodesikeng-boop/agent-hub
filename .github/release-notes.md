## Bellwood v0.2.0

- Fusa 更名为 Bellwood。Apple 芯片 Mac 和 Windows x64 均可安装原生桌面应用。
- 任务流图按依赖自动推进。项目经理可以把实现和审查分给使用不同模型的 Agent。
- 飞书群可以接收任务进度、完成拍板和查看验收结果。机器人通过出站长连接工作，无需公网入站端口。
- 同一账号下的可信设备使用端到端加密互联，支持局域网直连和中继。

### English

- Fusa is now Bellwood. Native desktop apps are available for Apple silicon Macs and Windows x64.
- Task graphs advance as dependencies finish. Project managers can assign implementation and review to agents that use different models.
- Follow progress, make decisions, and view verification results in Feishu groups. The bot connects outbound and needs no public inbound port.
- Trusted devices in the same account connect with end to end encryption over the LAN or through a relay.

### 下载与校验 / Downloads and checksums

| 平台 / Platform | 安装包 / Installer | 校验文件 / Checksum |
| --- | --- | --- |
| Apple 芯片 Mac / Apple silicon Mac (macOS 13+) | `Bellwood-macos-arm64.dmg` | `Bellwood-macos-arm64.dmg.sha256` |
| Windows x64 | `Bellwood-windows-x64-setup.exe` | `Bellwood-windows-x64-setup.exe.sha256` |

安装包为未签名预览版。验证校验值后，macOS 如阻止启动，可在「系统设置 → 隐私与安全性」中选择「仍要打开」。Windows 如弹出 SmartScreen，可选「更多信息 → 仍要运行」。

These installers are unsigned previews. After checking the checksum, use **Open Anyway** in macOS **Privacy & Security** or **More info**, then **Run anyway** in Windows SmartScreen if the system blocks the app.

- macOS: `shasum -a 256 -c Bellwood-macos-arm64.dmg.sha256`
- Windows: `Get-FileHash Bellwood-windows-x64-setup.exe -Algorithm SHA256`. Compare `Hash` with the value in the `.sha256` file.
