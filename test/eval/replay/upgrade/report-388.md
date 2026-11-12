用户的目标是将本机（macOS arm64）上 Fusa 支持的全部 6 家 Agent CLI 升级或补装至最新可用版本，保证正在运行的 `agy` 会话不受影响，并确认最新模型目录与可用性状态就绪。用户和项目经理在派发新会话或查看模型列表时，将直接用到最新版本的各家 CLI 与最新模型目录，维护者无需改动任何仓库文件即可在当前环境运行全部 6 家驱动。

**应用的原则。**
- 阅读并应用了 [`principle-sequence-verifiable-units`](~/agent-hub/.agents/skills/principle-sequence-verifiable-units/SKILL.md)。先采集全部 6 家升级前基线并只读审计 `agy` 安装脚本，再对共享 mise 全局 `node_modules` 的 `pi`、`dsh`、`codex` 逐个串行升级与校验，避免并发写冲突。
- 阅读并应用了 [`principle-prove-it-works`](~/agent-hub/.agents/skills/principle-prove-it-works/SKILL.md)。除核对全部 6 家的解析路径、软链目标与 `--version` 外，针对 npm 11 默认跳过安装脚本的提示，实测执行了 `dsh` 的 `ensure-spawn-helper.mjs`、核对了 `node-pty` `spawn-helper` 的 `0755` 权限与 `koffi` 原生模块加载、跑通了 `dsh --profile acp` 的 JSON-RPC `initialize` 握手，并直接调用 [`createVendorCatalogSources`](~/agent-hub/src/daemon/vendors/index.ts#L57-L71) 与 [`createModelCatalogs`](~/agent-hub/src/daemon/driver/model-catalog.ts#L109-L128) 实测 6 家探测结果。

**升级前后版本与探测状态对比。**

| 厂商 | 升级前路径与版本 | 升级后解析路径（及软链目标） | 升级后 `--version` | 实测探测状态 |
| :--- | :--- | :--- | :--- | :--- |
| `claude` | `~/.local/bin/claude` -> `.../2.1.314`，`2.1.314 (Claude Code)` | `~/.local/bin/claude` -> `~/.local/share/claude/versions/2.1.322` | `2.1.322 (Claude Code)` | `available`（`vendor`，默认 `Opus 5.5`，13 个模型） |
| `agy` | `~/.local/bin/agy`，`1.5.5` | `~/.local/bin/agy`（跳过重装，与远端一致） | `1.5.5` | `available`（`vendor`，6 个模型） |
| `codex` | PATH 未装（回退 `ChatGPT.app` 内 `0.167.0-alpha.3.2`） | `~/.local/share/mise/shims/codex`（`ChatGPT.app` 原文件未动） | `codex-cli 0.167.1` | `available`（`vendor`，默认 `gpt-6.1-sol`，8 个模型） |
| `pi` | `~/.local/share/mise/shims/pi`，`1.5.0` | `~/.local/share/mise/shims/pi`（已跑 `pi update --models`） | `1.5.2` | `signed_out`（`bundled`，6 个模型） |
| `deepseek` (`dsh`) | 未安装 | `~/.local/share/mise/shims/dsh`（命中 [`fallbackPaths`](~/agent-hub/src/vendors/deepseek/paths.ts#L12-L24)） | `0.2.2-rc.1` | `signed_out`（已从 `not_installed` 变为已安装未登录，`bundled`，2 个模型） |
| `cursor` (`cursor-agent`) | `~/.local/bin/cursor-agent` -> `.../2026.10.22-27dcf5f/cursor-agent` | `~/.local/bin/cursor-agent` -> `~/.local/share/cursor-agent/versions/2026.11.10-731fb78/cursor-agent` | `2026.11.10-731fb78` | `available`（`vendor`，默认 `auto`，42 个模型） |

**关键核查说明。**
- `agy` 安全检查中，只读拉取了 `https://antigravity.google/cli/install.sh` 与远端 `darwin_arm64.json` 清单，实测远端最新版本号即为 `1.5.5`（且官方脚本在重新安装分支使用的是非原子的 `cp` 覆写）。本机已是最新 `1.5.5`，已按要求直接跳过，零触碰运行中的二进制。
- `git status --short` 实测输出为空，主仓库工作区 100% 干净。
- 实测执行 `hub models --refresh` 返回退出码 1（`Worker 只能用 hub status，不能用 hub models`），原因是 [`HUB_COMMAND_ROLES`](~/agent-hub/src/shared/hub.ts#L89-L112) 将 `models` 限定为仅 `pm` 角色可用。守护进程自带可执行文件 [`vendorCatalogFingerprint`](~/agent-hub/src/shared/paths.ts#L254-L270) 变更自动失效机制，项目经理验收时再运行一次 `hub models --refresh` 即可立即强制刷新守护进程内存缓存。

=== 汇报 ===
状态: 做完了
摘要: 已完成本机 claude (2.1.322)、pi (1.5.2 并刷新本地模型目录)、cursor-agent (2026.11.10-731fb78)、dsh (0.2.2-rc.1)、codex (0.167.1) 的升级/补装，核实 agy 已是最新 1.5.5 安全跳过，主仓库工作区 100% 干净。
提交: 无
测试: 单条命令核验全部 6 家解析路径、realpath 与 --version 均符合预期；dsh --profile acp JSON-RPC initialize 握手通过；调用 createModelCatalogs({ refresh: true }) 实测 6 家探测全部识别（claude/agy/codex/cursor 为 available，pi/deepseek 为 signed_out）；git status --short 为空。
问题: hub models --refresh 受 src/shared/hub.ts 的 HUB_COMMAND_ROLES 限制仅允许 pm 角色调用（Worker 调用按规矩被拒），请项目经理验收时直接运行一次 hub models --refresh 刷新守护进程内存缓存。
=== 汇报结束 ===
