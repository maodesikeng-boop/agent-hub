# Security policy

**English** | [中文](#安全策略)

## Supported versions

We support the latest `0.3.x` release and the latest commit on `main`. This policy covers the daemon, web UI, Worker sandboxes, macOS and Windows desktop shells, `fusa-win-helper`, account mesh and relays, and the Feishu integration.

Report vulnerabilities in vendor CLIs or dependencies to their maintainers. Bellwood assumes that you control your OS account and that your devices are physically secure.

## Report a vulnerability privately

1. Open [GitHub's private vulnerability report form](https://github.com/maodesikeng-boop/agent-hub/security/advisories/new).
2. Include the affected version or commit, the impact, and the steps to reproduce the issue. Keep vulnerability details out of public issues and pull requests.

This project handles reports as time permits. Allow time for a fix before disclosing the issue publicly.

## Local UI and sockets

- The web UI listens on `127.0.0.1:4317` by default. The daemon checks `Host` against `127.0.0.1` or `localhost` and the actual port on every request. Requests that change state and WebSocket upgrades also require a local HTTP `Origin` on that port. Keep this listener on loopback.
- The daemon stores the UI master token in `state/ui-token` with mode `0600`. Treat any login URL that contains the token as a credential. Browser sessions use an `HttpOnly`, `SameSite=Strict` cookie. The database stores only the session token's SHA-256 digest. Signing out all browsers also rotates the master token.
- Agents use `run/hub.sock` with a random `HUB_TOKEN` that expires when the session ends. Local administration, including the account and Feishu CLIs, uses `run/admin.sock` and requires the UI master token as a bearer token. On Unix, both sockets have mode `0600` in a directory with mode `0700`. Windows uses separate local named pipes for the same endpoints.

These checks protect local endpoints from other users and browser origins. Processes with access to your OS account can read your local data and credentials.

## Worker sandboxes and read only mode

- A regular Worker can write only to its assigned worktree inside the protected roots. Those roots include Bellwood's data directory, which defaults to `~/.agent-hub`, and any worktree roots on other volumes. Outside these roots, a regular Worker keeps your OS user's read, write, and network permissions. Project managers run as your OS user without a sandbox.
- Regular and read only Workers cannot read the `~/.agent-hub` data directory, including `state/` and `backups/`. They can read only `worktrees/`, `uploads/`, `tools/`, `run/bin/`, and their own session launch directory, and can connect only to `run/hub.sock`. The UI token, provider and Feishu secrets, mesh keys, SQLite ledger, logs, backups, project manager memory, and `run/admin.sock` stay out of reach.
- macOS uses `sandbox-exec`. Linux uses `bubblewrap`. Windows uses `fusa-run.exe` with a Job Object for the process tree, a restricted token, and explicit deny write and deny read NTFS ACLs across protected roots and the data directory.
- Read only mode allows writes only to a private session temp directory and required vendor runtime paths. Allowed workspaces and the network remain accessible. The data directory, including the SQLite ledger and logs, and known user credential paths are unreadable. File pattern coverage varies by platform and vendor. MCP connectors allow only tools that declare `readOnlyHint: true` without `destructiveHint: true`, subject to explicit allow and deny rules.
- On Windows 11 24H2 or later, outer read only enforcement uses the `@microsoft/mxc-sdk` ProcessContainer when the capability probe succeeds. When MXC is unavailable, including on older Windows versions, a read only Worker that needs the outer sandbox falls back to the restricted token with data directory NTFS ACLs and tool checks. Bellwood shows a warning because this fallback does not enforce full filesystem read only access or block reads of all external credential paths.

## Account mesh and relays

- GitHub Device Flow uses a public client ID and requires no server side client secret. The daemon and relay use the GitHub access token to verify the account and register the device. They discard it after use and do not write it to disk.
- To approve another device, compare the six digit short authentication string (SAS) and confirm the match on both devices. Devices sign trust and revocation statements. The local trust file, `state/peers.json` version 2, records trusted devices and revocations.
- LAN and relay connections use mutual TLS 1.3 with ALPN `fusa-mesh/1`. Each device checks the pinned SHA-256 fingerprint of the other device's self signed Ed25519 certificate. Both the Cloudflare relay and the Node relay forward the encrypted data stream without access to its contents. Relays still handle control traffic and see connection metadata.
- `isAllowedDirectHost` restricts LAN candidates to private IPv4 addresses, IPv6 unique local addresses, and valid IPv6 link local addresses. The allowlist blocks loopback and cloud metadata addresses to limit server side request forgery (SSRF).

## Feishu and project groups

The bot opens an outbound WebSocket to Feishu for messages and card actions. It requires no public inbound port. Bellwood stores the app credentials in `state/feishu-secrets.json` with mode `0600`. In a mesh account, the eligible device that holds the Feishu lease runs the bot's long connection. Another eligible device can take over when the lease changes hands.

The owner sets a guest tier for each project group:

| Tier | Guest access |
| --- | --- |
| Read only (`observer`) | Read group messages. A guest message does not start a project manager turn. Bellwood can include it as context when the owner starts a turn. |
| Chat only (`chat_only`, default) | Mention the bot to talk to the project manager. Decision cards, stopping work, and attachments are reserved for the owner. |
| Collaborator (`collaborator`) | Chat, answer decision cards, stop work, and send attachments. |

Only the owner can change group settings. During a turn initiated by a guest, the ledger rejects commands reserved for the owner, such as creating projects, attaching or detaching folders, editing setup commands, and changing personas.

Use Chat only and Collaborator with people you trust. Guest messages can instruct an unsandboxed project manager through prompt injection. The owner only checks in the ledger do not constrain shell commands that the project manager runs as your OS user.

## 安全策略

[English](#security-policy) | **中文**

### 支持版本

我们支持最新的 `0.3.x` 发行版与 `main` 的最新提交。范围包括守护进程、网页界面、Worker 沙箱、macOS 和 Windows 桌面外壳、`fusa-win-helper`、账号组网与中继，以及飞书集成。

厂商 CLI 或依赖本身的漏洞请报告给上游维护者。Bellwood 假定你的系统账号由你控制，设备也有物理访问保护。

### 私下报告漏洞

1. 打开 [GitHub 私密漏洞报告表单](https://github.com/maodesikeng-boop/agent-hub/security/advisories/new)。
2. 提供受影响的版本或提交号、影响和复现步骤。请勿把漏洞细节贴到公开 Issue 或 Pull Request。

项目尽力处理报告。公开披露前，请留出修复时间。

### 本机界面与 Socket

- 网页端默认监听 `127.0.0.1:4317`。守护进程检查每个请求的 `Host` 是否为 `127.0.0.1` 或 `localhost` 加实际端口，以防 DNS 重绑定。修改状态的请求与 WebSocket 握手还须带该端口的本机 HTTP `Origin`。请保持仅监听回环。
- 界面主令牌保存在 `state/ui-token`，文件权限为 `0600`。含该令牌的登录链接也是凭据。浏览器会话使用 `HttpOnly`、`SameSite=Strict` Cookie，数据库只保存会话令牌的 SHA-256 摘要。让所有浏览器退出登录时，守护进程也会轮换主令牌。
- Agent 使用 `run/hub.sock` 和会话结束即作废的随机 `HUB_TOKEN`。账号组网和飞书命令等本机管理操作使用 `run/admin.sock`，以界面主令牌作 Bearer 凭据。Unix 上两个 Socket 的权限均为 `0600`，所在目录为 `0700`。Windows 用两个独立的本机命名管道提供相同接口。

这些检查针对其他系统用户与浏览器来源。能以你的系统账号运行的进程仍可读取本机数据与凭据。

### Worker 系统沙箱与只读模式

- 在受保护根目录内，普通 Worker 只能写分给自己的 worktree。受保护根包含 Bellwood 数据目录和其他卷上的 worktree 根。在这些根目录之外，普通 Worker 拥有当前系统用户的读写与联网权限。项目经理以当前系统用户身份运行，不进沙箱。
- Worker（普通与只读）读不到数据目录，只能读 `worktrees/`、`uploads/`、`tools/`、`run/bin/` 与本会话的启动目录，只能连 `run/hub.sock`。界面令牌、各类密钥、账本数据库、日志、备份、项目经理记忆与 `run/admin.sock` 都在边界之外。
- macOS 使用 `sandbox-exec`。Linux 使用 `bubblewrap`。Windows 使用 `fusa-run.exe`，以 Job Object 管理进程树，并通过受限令牌与 NTFS ACL 实施数据目录的禁写与禁读。
- 只读策略仅允许写会话私有临时目录和厂商运行所需的路径，并限制读取已知凭据路径与整个数据目录。文件通配规则的覆盖因平台和厂商而异。网络仍可访问。MCP 连接器默认放行声明 `readOnlyHint: true` 且未声明 `destructiveHint: true` 的工具，并可以通过显式规则调整。
- Windows 11 24H2 或更新版本在能力探测通过时可使用 `@microsoft/mxc-sdk` 的 ProcessContainer 实施外层只读沙箱。旧版 Windows 或 MXC 不可用时，需要外层沙箱的只读 Worker 会降级为受限令牌和工具层检查。Bellwood 会显示告警，因为降级路径无法保证全盘只读或禁止读取所有配置的凭据路径。

### 账号组网与盲转中继

- GitHub Device Flow 使用公开的客户端 ID，无需服务端客户端密钥。守护进程与中继使用 GitHub access token 核验账号并注册设备。令牌用完即弃，不写入磁盘。
- 批准另一台设备时，请比较两端显示的 6 位核对码（SAS），并在两端确认一致。设备对信任与撤销声明签名。本机的 `state/peers.json` v2 记录可信设备和撤销记录。
- 局域网直连与中继连接均使用双向 TLS 1.3，ALPN 为 `fusa-mesh/1`。双方检查对方 Ed25519 自签证书的 SHA-256 钉扎指纹。Cloudflare 和 Node 中继只转发加密数据流，无法解密其内容。中继仍处理控制消息，可以看到连接元数据。
- `isAllowedDirectHost` 仅允许私有 IPv4、IPv6 唯一本地地址和合法的 IPv6 链路本地地址作为直连候选。白名单拦截回环和云元数据地址，以限制服务端请求伪造（SSRF）。

### 飞书与团队项目群

机器人通过出站 WebSocket 长连接接收消息和卡片操作，无需公网入站端口。应用凭据保存在 `state/feishu-secrets.json`，权限为 `0600`。启用账号组网后，由持有飞书租约的合格设备维持长连接。租约转移时，另一台合格设备可以接管。

主人可以为每个项目群设置访客档位：

| 档位 | 访客权限 |
| --- | --- |
| 只读（`observer`） | 可看群消息。访客发言不会唤醒项目经理，主人发起对话时可将访客发言一并作为背景。 |
| 仅对话（`chat_only`，默认） | 可 @ 机器人与项目经理对话。拍板卡、停止与发送附件仅限主人。 |
| 协作者（`collaborator`） | 可对话、回答拍板卡、停止与发送附件。 |

群设置仅主人可改。在访客触发的轮次中，账本会硬拦截建项目、挂卸文件夹、修改准备命令、修改性格设定等主人专属操作。

「仅对话」和「协作者」仅适用于互信团队。请勿向不可信外部人员开放这两档权限。访客有可能通过提示词注入影响未受沙箱限制的项目经理，账本对主人专属操作的拦截无法限制项目经理以你的系统用户身份运行的 shell 命令。
