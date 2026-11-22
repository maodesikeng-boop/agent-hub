# Changelog

Each `## vX.Y.Z` section becomes the GitHub release notes of that version and of its `vX.Y.Z-rc.N` candidates, followed by `.github/release-downloads.md`. A release tag fails until its version has a section here. See [Release flow](docs/release-flow-design.md#releasing).

## v0.3.0

- 内置编码 Agent 扩至 8 家，新增 OpenCode 与 Kimi Code，连同 Claude Code、Antigravity、Codex、Pi、DeepSeek 和 Cursor。全部厂商均支持在设置页安装与登录，并在 macOS、Windows 与 Linux 上执行系统沙箱和只读审查隔离。
- 外接能力支持按项目和插件维度管理。设置页提供全局 **Project defaults**，单个项目可在项目资料页单独覆盖开关或恢复默认设置。同一插件的 MCP 服务与技能合并为一个开关，Worker 支持 `inherit`、`none`、`custom` 三档能力挂载。
- 多设备互联内置官方公共盲中继与公开 GitHub 登录默认配置，登录同一 GitHub 账号即可跨网络建立端到端加密连接，无需自建中继。项目资料页支持配置新建 `git worktree` 时自动执行的准备命令。
- 桌面打包版支持在设置页与侧栏检查新版本，并提供安装包与校验文件直链。前端升级移除旧异步分片时页面会自动刷新一次恢复，聊天列表改用动态高度虚拟滚动，长会话只挂载可视区域消息以降低渲染开销。

### English

- OpenCode and Kimi Code join Claude Code, Antigravity, Codex, Pi, DeepSeek, and Cursor for eight built-in coding agents. Every agent supports setup in **Settings**, OS sandboxes on macOS, Windows, and Linux, and read-only review isolation.
- You can now manage external capabilities per project and per plugin. **Project defaults** sets the baseline across projects, and each project can override items from its profile page or click **Reset to Project defaults**. MCP servers and skills from the same plugin share one toggle, and Workers accept `inherit`, `none`, or `custom` capability modes.
- Bellwood includes the official public blind relay and public GitHub sign-in defaults, so devices on one account connect with end-to-end encryption without a self-hosted relay. Project profiles also accept a **Worktree setup** command that runs in each new `git worktree`.
- Bundled desktop apps check for updates in **Settings** and the sidebar, with direct installer and checksum links. Open tabs reload once when a frontend upgrade removes an older lazy chunk, and the chat list virtualizes dynamic-height rows so long threads mount only visible messages.

## v0.2.0

- Fusa 更名为 Bellwood。Apple 芯片 Mac 和 Windows x64 均可安装原生桌面应用。
- 任务流图按依赖自动推进。项目经理可以把实现和审查分给使用不同模型的 Agent。
- 飞书群可以接收任务进度、完成拍板和查看验收结果。机器人通过出站长连接工作，无需公网入站端口。
- 同一账号下的可信设备使用端到端加密互联，支持局域网直连和中继。

### English

- Fusa is now Bellwood. Native desktop apps are available for Apple silicon Macs and Windows x64.
- Task graphs advance as dependencies finish. Project managers can assign implementation and review to agents that use different models.
- Follow progress, make decisions, and view verification results in Feishu groups. The bot connects outbound and needs no public inbound port.
- Trusted devices in the same account connect with end to end encryption over the LAN or through a relay.

## v0.1.0

- 首个公开预览版，以 Fusa 的名字发布，提供 Apple 芯片 Mac 和 Windows x64 的未签名安装包。

### English

- First public preview, released as Fusa, with unsigned installers for Apple silicon Macs and Windows x64.
