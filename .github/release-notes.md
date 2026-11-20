## Bellwood v0.3.0

- 内置编码 Agent 扩至 8 家，新增 OpenCode 与 Kimi Code，连同 Claude Code、Antigravity、Codex、Pi、DeepSeek 和 Cursor。全部厂商均支持在设置页安装与登录，并在 macOS、Windows 与 Linux 上执行系统沙箱和只读审查隔离。
- 外接能力支持按项目和插件维度管理。设置页提供全局 **Project defaults**，单个项目可在项目资料页单独覆盖开关或恢复默认设置。同一插件的 MCP 服务与技能合并为一个开关，Worker 支持 `inherit`、`none`、`custom` 三档能力挂载。
- 多设备互联内置官方公共盲中继与公开 GitHub 登录默认配置，登录同一 GitHub 账号即可跨网络建立端到端加密连接，无需自建中继。项目资料页支持配置新建 `git worktree` 时自动执行的准备命令。
- 桌面打包版支持在设置页与侧栏检查新版本，并提供安装包与校验文件直链。前端升级移除旧异步分片时页面会自动刷新一次恢复，聊天列表改用动态高度虚拟滚动，长会话只挂载可视区域消息以降低渲染开销。

### English

- OpenCode and Kimi Code join Claude Code, Antigravity, Codex, Pi, DeepSeek, and Cursor for eight built-in coding agents. Every agent supports setup in **Settings**, OS sandboxes on macOS, Windows, and Linux, and read-only review isolation.
- You can now manage external capabilities per project and per plugin. **Project defaults** sets the baseline across projects, and each project can override items from its profile page or click **Reset to Project defaults**. MCP servers and skills from the same plugin share one toggle, and Workers accept `inherit`, `none`, or `custom` capability modes.
- Bellwood includes the official public blind relay and public GitHub sign-in defaults, so devices on one account connect with end-to-end encryption without a self-hosted relay. Project profiles also accept a **Worktree setup** command that runs in each new `git worktree`.
- Bundled desktop apps check for updates in **Settings** and the sidebar, with direct installer and checksum links. Open tabs reload once when a frontend upgrade removes an older lazy chunk, and the chat list virtualizes dynamic-height rows so long threads mount only visible messages.

### 下载与校验 / Downloads and checksums

| 平台 / Platform | 安装包 / Installer | 校验文件 / Checksum |
| --- | --- | --- |
| Apple 芯片 Mac / Apple silicon Mac (macOS 13+) | `Bellwood-macos-arm64.dmg` | `Bellwood-macos-arm64.dmg.sha256` |
| Windows x64 | `Bellwood-windows-x64-setup.exe` | `Bellwood-windows-x64-setup.exe.sha256` |

安装包为未签名预览版。验证校验值后，macOS 如阻止启动，可在「系统设置 → 隐私与安全性」中选择「仍要打开」。Windows 如弹出 SmartScreen，可选「更多信息 → 仍要运行」。

These installers are unsigned previews. After checking the checksum, use **Open Anyway** in macOS **Privacy & Security** or **More info**, then **Run anyway** in Windows SmartScreen if the system blocks the app.

- macOS: `shasum -a 256 -c Bellwood-macos-arm64.dmg.sha256`
- Windows: `Get-FileHash Bellwood-windows-x64-setup.exe -Algorithm SHA256`. Compare `Hash` with the value in the `.sha256` file.
