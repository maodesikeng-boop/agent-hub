# 产品提示词的通道：厂商内部压缩后还在不在

2026-11-11 实测（agy 1.5.5、cursor-agent 2026.11.10-731fb78、dsh 0.2.2-rc.1）。脚本在 `experiments/system-prompt-channels/`，可重放。

## 1. 问题和统一做法

prompt.md（`daemon/launch.ts` 每次启动前写：角色说明、hub 命令表、项目经理性格设定；Router 的在 `daemon/router/sandbox.ts`）要交给 agent。
拼进新会话第 0 条用户消息的，厂商内部压缩对话时会被一起裁掉（agy 项目经理会话第 883 步压缩后原文全丢）。

每家在 `src/vendors/<厂商>/spec.ts` 的 `capabilities.systemPrompt` 写清楚走哪个通道（`src/vendors/types.ts` 有说明），公共代码只按声明走：

| 声明 | 含义 | 谁负责 |
|---|---|---|
| `resident` | 进厂商常驻的系统提示词区，压缩不裁 | 这家的驱动层把 prompt.md 放进去；ACP 底座不往消息里拼（`systemPromptInjection` 推成 `never`） |
| `first_message` | 厂商没有常驻入口，拼进新会话第一条消息 | ACP 底座：首轮拼；initialize 声明 `clientCapabilities.session.compaction`；收到 `compaction_update`（completed）后，下一条消息最前面再拼一次（读 prompt.md 当时的内容；记在会话上，压缩完进程闲置关了、恢复会话也补） |

项目经理、Worker、Router 三类会话都经各家驱动层，一起覆盖。接新厂商只在 spec 里补这一个字段（必填，类型检查查）。

| 厂商 | 声明 | 通道 |
|---|---|---|
| claude | resident | `--append-system-prompt-file`（不变） |
| codex | resident | app-server 的 `developerInstructions`（不变） |
| pi | resident | `--append-system-prompt`（不变） |
| agy | resident | 规则目录 + `--add-dir`（第 2 节） |
| deepseek | resident | `--patch` 改 `system-prompt` 行的 `personaSuffix`（第 3 节） |
| cursor | first_message | 首条消息 + 压缩信号后重拼（第 4 节） |

文件都写在守护进程自己的启动目录 `~/.agent-hub/state/launch/<会话>/` 下，不碰用户的项目目录和 worktree（git status 不多东西）。
只读 Worker 的沙箱哪里都能读（只禁密钥，`shared/readonly-policy.ts`；state/ 下只禁 `ui-token`），读得到。

## 2. agy：规则目录 + `--add-dir`

实测结论：

- agy 没有系统提示词参数（`agy --help`）。
- 每个工作区（cwd 和每个 `--add-dir`）的 `GEMINI.md`、`AGENTS.md`、`.agents/rules/*.md`（frontmatter `trigger: always_on`）都进**系统提示词**的
  `<user_rules>` 区。`/compact` 之后的那次请求（agy 对话库 `gen_metadata` 里存的完整请求）：`<user_rules>` 里规则原样都在，
  历史换成 `<CONTEXT_SUMMARY>`，第 0 条消息不再原样出现（短消息会出现在摘要的“最近用户请求”列表里，那是摘要的截断列表，长会话里会被挤掉）。
- 单个规则文件超过 **24,000 字节**的部分被截掉（`<truncated N bytes>`）。
- 所有规则（项目的、全局的、各 `--add-dir` 的）合起来约 **60,000 字节**的总预算，超了**从排在最前面的丢起**；
  项目工作目录的 `AGENTS.md` 排在 `--add-dir` 的规则前面，会先被丢。

做法（`src/vendors/agy/rules.ts`）：每次起进程把 prompt.md 按字节切块（每块 ≤ 20,000 字节、在换行处断），原子写到
`<启动目录>/agy-rules/.agents/rules/fusa-01.md…`，最多 3 块（`limits.ts`），`--add-dir <启动目录>/agy-rules` 放在会话自己的附加目录后面。
启动或续接时重新统计产品规则、工作区的 `AGENTS.md` / `GEMINI.md` / always_on 规则，以及 `~/.gemini` 和 `~/.gemini/config` 下的全局规则，按真实路径去重。
总量超过约 60,000 字节或单文件超过 24,000 字节时，在当前会话显示系统告警；阈值集中在 agy 的 `limits.ts`，不自动裁剪或调整顺序。
后台写交接复制的那份引用原会话写好的目录（不重写，前缀和原会话一样）。消息里不再拼提示词；以前每次新起进程都重发一遍 44KB，现在不发了。

## 3. deepseek（dsh）：`--patch` 的 `personaSuffix`

实测结论：

- dsh 的 ACP `initialize` 不声明 `sessionCapabilities.systemPrompt`，`session/new` 带 `additionalDirectories` 直接报错。
- 工作区的 `AGENTS.md`、`CLAUDE.md` 由 `dsh-agent-instructions` 读，但它们是**普通 user 消息**（README：“they replay, compact, and resume exactly like other history”），会被压缩，不能用。
- `system-prompt` 行的 `personaPrefix` / `personaSuffix` 进 system 消息（会话第 0 个节点）；`dsh-compaction` 只换掉历史（“compaction shrinks derived history, never the system prompt”）。
  用假 DeepSeek 接口（Anthropic Messages 格式）录下真实请求：调低自动压缩阈值触发压缩后，`system` 字段里探针每次都在，第 0 条消息里的对照短语消失。
- `--patch` 改一行时整行 config 被替换（`dsh-app-boot` 的 `applyPatches` 不合并），所以默认的 `personaPrefix` 要照抄。
- dsh 模板没有转义写法：`{{…}}` 一律当变量，不认识就启动失败。prompt.md 里的 `{{` 在两个 `{` 之间插零宽空格。该转换也会影响代码示例，不能把含该字符的示例逐字复制到代码里；这不是无损转义。已核对 dsh 0.2.2-rc.1 的 `interpolate`：只有 `{{…}}` 语法，没有其他模板分隔符，personaSuffix 配置没有关闭插值的选项。

做法（`src/vendors/deepseek/driver.ts`）：起进程时写 `<启动目录>/dsh-system-prompt.patch.json`，`--patch` 排在沙箱补丁后面。
提示词随新进程读新补丁，所以 `rebakesPersonaOnResume: true`。

## 4. cursor：只能拼进首条消息

实测结论：

- ACP `initialize` 只声明 `loadSession` 和 `sessionCapabilities.list`，没有 `systemPrompt`、`additionalDirectories`。
- 只读**会话工作目录**里的 `.cursor/rules/*.mdc`、`AGENTS.md`；`--add-dir` 目录、`--plugin-dir` 插件里的规则在 ACP 下都不读（探针答 NONE）。
  规则文件又不能写进用户的项目目录，所以没有常驻入口。
- ACP 层不发 `usage_update`、`compaction_update`。经 ACP 发 `/compact` 不是真压缩：模型自己回一段总结（会话库里模型的思考是“No compact tool is available”），
  第 0 条消息原样还在。
- cursor 服务端压缩前会让 CLI 执行 `preCompact` 钩子（带 auto/manual、上下文用量），但钩子只能配在 `~/.cursor/hooks.json`（用户全局）或项目的 `.cursor/hooks.json`。

做法：声明 `first_message`，ACP 底座首轮拼、声明 `session.compaction`、收到 `compaction_update` 重拼。**已知缺口**：cursor 现在不发压缩信号，
自动压缩后产品提示词仍会丢。保留信号重拼兜底，cursor 以后按 ACP 标准发 `compaction_update` 时生效；Fusa 不修改用户全局 `~/.cursor/hooks.json`。

## 5. 重放

```sh
E=experiments/system-prompt-channels
# agy：真实 rules.ts + buildAgyArgs + 只读策略，真跑 agy，/compact 后问探针；再看压缩后那次请求
LINES=380 NO_OS_SANDBOX=1 node $E/agy-compact.ts /tmp/p/launch/9443 /tmp/p/cwd
python3 -I $E/inspect-agy.py ~/.gemini/antigravity-cli/conversations/<conversation>.db
# dsh：真实 buildDeepSeekSystemPromptPatch 写补丁；假接口录请求；调低阈值触发自动压缩
LINES=380 node $E/dsh-patch.ts /tmp/p/ds.patch.json
node $E/mock-anthropic.mjs 18443 /tmp/p/mock.log &
printf '[{"id":"compaction-basic","config":{"thresholdRatio":0.019,"headroomTokens":0,"maxTokens":1000,"retainTokens":200}}]' > /tmp/p/compact.json
DSH_HOME=/tmp/p/dshhome DEEPSEEK_API_KEY=sk-fake DEEPSEEK_BASE_URL=http://127.0.0.1:18443/anthropic \
  node $E/acp-probe.mjs /tmp/p/ds-cwd '["<system_instructions>…对照…</system_instructions>","Story 1 …","Story 2 …","Story 3 …","Story 4 …","探针？"]' \
  dsh --profile acp --patch /tmp/p/ds.patch.json --patch /tmp/p/compact.json
python3 -I $E/inspect-dsh.py /tmp/p/mock.log
# cursor：真实 cursor 驱动起 cursor-agent acp，首条带探针
node $E/cursor-first-message.ts /tmp/p/launch/9444 /tmp/p/cur-cwd
```

## 6. 生命周期与权限审查

规则和补丁与同目录的 prompt.md 一起保留：重启原地更新，Worker 保留期清理和 PM 删除清理整个会话启动目录（目录名是会话编号，写的和删的都用 `src/shared/paths.ts` 的 `sessionLaunchDir`；以前删的是 `session-<编号>`，和写的对不上，从来没删掉过）；Router 每轮清理启动目录。
项目经理会话的启动目录里还有产品自带的任务图手册 `skills/fusa-task-graph/SKILL.md`（只有这一份文件；claude 的 `claude-plugin/skills` 软链到它，agy 规则目录里的 `.agents/skills/fusa-task-graph/SKILL.md` 是它的硬链接），见 `docs/orchestration-skill-design.md` 第 6 节；Worker、Router 的启动目录里没有。会话 ID 隔离，后台交接只读主会话规则，不重写它。
性格设定在进程内变更走现有 personaNote，下一次起进程重新生成规则。每会话最多三个规则文件和一个补丁，没有跨会话内存缓存。
规则目录权限为 0700，文件 0600。普通 Worker 的 writeScope 不因 `--add-dir` 扩大，只读策略也不增加可写路径；项目经理无 OS 写范围限制，同一用户身份仍能修改这些文件，目录权限不能阻止它。
