# Changelog

Each `## vX.Y.Z` section becomes the GitHub release notes of that version and of its `vX.Y.Z-rc.N` candidates, followed by `.github/release-downloads.md`. A release tag fails until its version has a section here. See [Release flow](docs/release-flow-design.md#releasing).

## v0.4.0

- 设置页新增 **Resources**（资源）面板，桌面端和手机端都可使用，并在有待决定的项目时于设置按钮上显示提示点。面板列出数据库与文件占用、遗留的 Worker 进程、临时目录，以及 `hub/*` 分支和 worktree，可逐项选择保留或清理，也可一键清理。已合并（含 squash 合并）的 `hub/*` 分支会自动清理，未合并的分支保留并提醒。
- Worker 结束后，它留下的后台进程和临时目录会自动回收，不再占用内存与磁盘。可能被其他会话共用的服务进程（如 Gradle 守护进程）不会被自动停止，只在面板里标为“可能共享”，由你决定是否停止。
- 数据库按表和文件体积双重上限自动瘦身，长期运行不再无限增长。上传文件和已发送文件即使超出体积上限，也不会删除最近 3 天内的文件。Worker 会话被清理时，提示会同时说明 14 天和 300 个两条保留上限。
- 回合结果先落盘为回执再结算。守护进程在结算途中重启或出错后，Worker 回报和后台等待状态不再丢失，也不会让会话队列卡住。浏览器在守护进程重启后重连，会重新同步最新状态，不再漏掉离线期间发生的变化。
- 升级前会校验数据库迁移文件是否齐全，缺失或被改动时拒绝启动，避免跳过迁移造成数据损坏。账本数据库改为独占打开，其他进程占着数据库时不再卡住守护进程的请求；启动时若数据库已被占用，会直接报 `ledger_locked`。
- 飞书：多台电脑各自把待决定事项和简报发到你的 Router 单聊，卡片标明项目名，点击按钮会回传给产生它的那台电脑，对方离线时给出提示。不同电脑、或同一份交付物发到项目群和 Router 单聊时，文件消息不再被飞书去重吞掉。离线补收消息改为从旧到新，不再漏掉最早的消息；离线超过 15 分钟窗口且期间有你的消息时，机器人会请你重发一次。
- 飞书总助跨中继向其他在线电脑拉取项目经理和待拍板汇总时，单独留出建立中继连接的时间预算，不再因冷连接超过 1.5 秒把在线电脑误判成离线、漏掉它的待决定事项。
- 飞书项目群里，模型报错或会话在开轮前失败时，不再删掉空状态卡而显示成“撤回了一条消息”，而是直接在卡片上写明失败原因。跨电脑转发单次超时而被暂存的消息，会在目标电脑在线时自动重试补送；后发的新消息也会等暂存消息按顺序送完，群内提示不再误报电脑离线。
- 新电脑配对时，若批准方在新电脑连好中继之前就点了批准，对方连上中继或再次点击批准时会自动补发配对消息，不再卡住等 10 分钟超时。
- 新增 `hub project review-status --account <login>`。任务图的独立审查步骤得出结论后，守护进程可用指定的 GitHub 账号，在被审提交上自动写入 `bellwood/review` 提交状态；不在 GitHub 上或没有权限的项目会安静跳过。
- 每日定时任务在设备切换时区后不再提前触发或在同一天重复运行。
- 项目经理、Worker 和 Router 现在使用你的语言回复。Windows PowerShell 下 `hub` 命令传入中文不再变成问号。
- 内置给 Agent 的提示词和审查清单不再写死只适用于本仓的做法，例如主分支叫 `main`、用 `pnpm`、托管在 GitHub、只给 macOS 与 Linux 终端的写法。换成其他语言、其他代码托管、没有 CI 或在 Windows 上的项目，同样适用。
- 安装包按锁文件构建，每个安装包都带 GitHub 溯源证明。下载后可以用 `gh attestation verify` 核对安装包的来源。

### English

- **Settings** has a new **Resources** panel on desktop and mobile, with an amber dot on the Settings button when an item needs your decision. It lists database and file usage, leftover Worker processes, temp folders, and `hub/*` branches and worktrees. Keep or discard each item, or run cleanup in one click. Merged `hub/*` branches, including squash-merged ones, are deleted automatically, and unmerged branches are kept with a reminder.
- When a Worker ends, the background processes and temp folders it left behind are reclaimed automatically. Services that other sessions may share, such as a Gradle daemon, are never stopped automatically. They show as "Possibly shared" and stop only when you choose.
- The database slims itself with per-table and file-size caps, so long-running installs stop growing without bound. Upload and delivery folders over their size cap never lose files from the last 3 days. When a Worker conversation is purged, the notice now names both limits, 14 days and 300 Workers.
- A turn's outcome is now saved as a receipt before it settles. After a daemon restart or an error mid-settlement, Worker reports and background waits are no longer lost, and the session queue no longer stalls. A browser that reconnects after a daemon restart resyncs to the latest state instead of missing changes made while it was offline.
- Before upgrading the ledger, Bellwood checks that every database migration is present and unchanged, and refuses to start otherwise instead of skipping one. The ledger opens exclusively, so another process holding the database can no longer freeze the daemon's requests, and startup reports `ledger_locked` when the database is already in use.
- Feishu: each computer posts its own decision cards and briefings to your Router 1-on-1 chat, titled with the project name. Button taps go back to the computer that raised the card, with a notice when it is offline. File messages from two computers, or the same deliverable sent to a project group and the Router chat, are no longer swallowed by Feishu's de-duplication. Catch-up after a disconnect reads oldest first so the earliest missed messages are kept. When a chat was offline longer than the 15-minute window and you wrote in the gap, the bot asks you to resend once.
- When the Feishu general assistant pulls project managers and pending decisions from other online computers across the relay, it now reserves its own time budget for opening the relay connection. A cold connection that takes longer than 1.5 seconds no longer marks an online computer as offline and drops its pending decisions.
- In a Feishu project group, when the model errors or a session fails before its turn starts, the empty status card is no longer deleted and shown as "a message was recalled". The card now states the failure reason. A message held after a cross-computer forward timed out is retried automatically once the target computer is online, newer messages wait so held ones are delivered in order, and the group notice no longer wrongly reports the computer as offline.
- When you pair a new computer and the approver taps approve before the new computer has reached the relay, the pairing message is now resent as soon as it connects or the approver taps approve again. Pairing no longer stalls until the 10-minute timeout.
- New `hub project review-status --account <login>`. After a Task Graph's independent review step reaches a verdict, the daemon can use the given GitHub account to write the `bellwood/review` commit status on the reviewed commit. Projects that are not on GitHub or lack permission are skipped silently.
- Daily schedules no longer fire early or run twice on one day after the device changes time zone.
- Project managers, Workers, and the Router now reply in your language. Chinese text passed to `hub` through Windows PowerShell no longer turns into question marks.
- The built-in prompts and review checklist no longer assume this repository's own setup, such as a trunk named `main`, `pnpm`, GitHub hosting, or macOS and Linux shell syntax. They hold in projects with another language, another code host, no CI, or Windows.
- Installers are built from the lockfile, and each one carries a GitHub provenance attestation. After you download one, run `gh attestation verify` to check where it came from.

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
