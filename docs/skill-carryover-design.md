# 换代时带上加载过的技能

## 要解决什么

项目经理的会话用到 400K token 会自动换代。旧会话写交接，新会话从零开始，上一代加载过的技能正文全部丢掉。poteto-mode 只能手打命令加载，不在模型的技能清单里，现在只靠性格设定里“每个会话开工先读全文”一句话维持。

用户定的做法：

- 技能被加载的那一刻由 Bellwood 记下来。用户手打调用的、模型自己加载的都记。
- 换代时 Bellwood 把记下的技能正文直接放进新会话的开场说明，不靠模型自觉去重读，也不让模型判断哪些该重读。
- 照 Claude Code 2.1.325 的做法：用过就带，按最近加载排序，单个和合计都有上限，超了不带。

不做：不改交接阈值 400K，不改切换厂商的回放上限，不做 Worker 换人接手的技能继承，不改写已有账本数据。

下文“实测”是在本机代码、账本 `~/.agent-hub/state/hub.sqlite` 或真实进程上核对过的；“推断”是读代码或文档得出、没有真实样例的。

## 现状

### 换代怎么触发，开场说明在哪拼

- 项目经理一轮结束（`turn.ended`）时，会话用量到 `handoverTokenThresholdOf(vendor)`（默认 `HANDOVER_TOKEN_THRESHOLD = 400_000`，`src/shared/limits.ts:109`、`src/shared/vendors.ts:304`）就登记一行 `handovers`（`src/daemon/ledger/handover.ts:1044-1047`）。资料页“开新会话”走 `renewSession`（同文件 `:719`），资料页换厂商走 `switchVendorIn`（`:759`）。（实测，读代码）
- 三条路最后都进 `switchIn`（`:539`）。它在一个写事务里建下一代会话（`generation + 1`），对普通换代拼好开场说明存进 `handovers.preamble`（`:591-614`）；换厂商的行 `preamble` 是 `NULL`。（实测）
- 驱动层往新会话写第一条消息前调 `sessionPreamble(sessionId)`（`:1060`）。普通换代取存好的 `preamble`；换厂商当场用 `buildVendorSwitchPreamble` 拼（`src/daemon/ledger/vendor-switch-context.ts:206`）。两种都在末尾接上“未完结的任务图”（`:1110-1113`）。agent 读到后 `message.processing` 带 `preamble: true`，账本记 `session_preamble_seen`，之后不再拼（`:999-1003`）。（实测）
- 开场说明现在由这几块组成（`sessionPreambleText`，`:138-170`）：说明头、交接全文、交接前约 3 万字原话（`HANDOVER_RECENT_CHARS`）、切点后的 Worker 汇报目录、未完结的任务图和一行任务图手册路径（`src/daemon/ledger/ledger.ts:201-205`）。没有技能正文。（实测）

### 切换厂商带不带技能正文

不带。`buildVendorSwitchPreamble` 回放本代的用户原话、项目经理文字、Worker 汇报和部分系统通知（`formatGenerationMessage`，`vendor-switch-context.ts:97-126`），取消息时排除了 `kind = 'tool'`（`handover.ts:471`）。模型用工具读进来的 `SKILL.md` 正文是工具结果，不在 `messages` 里。用户手打 `/poteto-mode` 时，正文由厂商命令行展开，Bellwood 的 `messages` 里只有 `/poteto-mode 这个skill更新了` 这行原文（账本 `messages.id = 61781`）。所以切换厂商后，新厂商只看到“用户调用过 /poteto-mode”，看不到正文。（实测）

结论：切换厂商和普通换代一样要带，走同一段代码。

### 总助和 Worker

- 总助（`role = 'assistant'`）每条指令起一个临时会话，跑完一轮就结束（`src/daemon/router/prompt.ts:131` 的“跑完即焚”、`src/daemon/ledger/router.ts:1263-1280`）。自动换代只认 `role === "pm"`（`handover.ts:338`）。总助没有自动换代，不在范围内。（实测）
- Worker 的会话不自动换代（`limits.ts:107` 的注释）。（实测）

### 各家加载技能时 Bellwood 收到什么

Bellwood 已经把六家的工具调用统一成 `agent.tool` 事件（`name` 是厂商原工具名，`input` 是完整参数），工具跑完是 `agent.tool_result`。各家工具名到通用动作（`read`、`command`、`skill`……）的翻译在各家 `spec.ts` 的 `tools.actions` 里，`src/shared/step-labels.ts` 合成一张表。

用户手打的命令都经过 Bellwood：网页发来原文，驱动层把命令单独写进会话（`src/daemon/driver/base-driver.ts:303`、`:604`），codex 在发出前把 `/名字` 改成 `$名字`（`src/vendors/codex/composer.ts`）。

| 厂商 | 用户手打调用 | 模型用原生技能工具 | 模型读文件工具 | 模型用 shell 读 |
| --- | --- | --- | --- | --- |
| claude | `/poteto-mode 这个skill更新了`（`messages.id = 61781`，实测） | `Skill`，`input: {"skill":"frontend-rules"}`，返回只有 `Launching skill: frontend-rules`（实测）；插件技能写成 `fusa:fusa-task-graph` | `Read` | `Bash` |
| agy | `/名字`（推断，读 `src/vendors/agy/composer.ts`） | 没有 | `read_file`，路径在 `Path` | `run_command`，命令在 `CommandLine` |
| codex | Bellwood 里是 `/名字`，发出前改成 `$名字`（读代码，实测） | 没有 | 没有 | `commandExecution` |
| pi | `/skill:名字`（`src/vendors/pi/composer.ts:2`，推断） | 没有 | `read` | `bash` |
| deepseek | `/名字`（推断） | `skill`，参数 `{"name": "<技能名>"}`（读 `@deepseek-ai/dsh-tool-skill` 源码） | `read` | `bash` |
| cursor | `/名字`（推断） | 没有 | `Read`、`read_file` | `Shell`、`run_terminal_cmd` |

工具跑完，实时流里带不带返回原文（2026-11-16 核对）：

| 厂商 | 返回原文在哪 | 读文件工具的返回里有没有正文 | 怎么核对的 |
| --- | --- | --- | --- |
| claude | `user` 事件里 `tool_result` 块的 `content` | 有，每行前面是行号加制表符（`1\t---`） | `claude -p --output-format stream-json` 实跑 `Read` |
| codex | `item/completed` 的 `item.aggregatedOutput` | 没有读文件工具；`commandExecution` 的输出原文在这里 | `codex app-server generate-ts` 生成的官方类型（`v2/ThreadItem.ts`）；本机原始记录 |
| agy | `step_update.tool_info.output` | **没有**：`read_file` 只回 `14 lines, 310 bytes`；`run_command` 有完整输出，前面带 `Created At`、`Command output:` 几行，正文行尾是 `\r\n` | agy 1.5.9 实跑抓的流（测试夹具 `src/vendors/agy/fixtures/skill-read-stream.jsonl`） |
| pi | `tool_execution_end` 的 `result.content[].text` | 有，不带行号 | `pi --mode rpc` 实跑 `read` |
| deepseek | ACP `tool_call_update` 的 `content[].content.text` | 有，每行前面是 `1: `，外面包 `<content>` | 读 `@deepseek-ai/dsh-acp` 的 `toolResultUpdate`、`dsh-tool-fs` 的 `formatReadOutput`；本机没有会话，推断 |
| cursor | ACP `tool_call_update` 的 `rawOutput`：读文件是 `{content}`，shell 是 `{exitCode, stdout, stderr}`；`content` 只放改文件的 diff | 有 | 读 `cursor-agent` 2026.11.10 的 `extractToolCallOutput`；本机没有会话，推断 |

现在账本收的 `agent.tool_result` 只有 `toolUseIds`，返回原文在驱动层就丢了。

`session_steps` 不能当记录来源。摘要截到 300 字、遮了密钥，`Read` 只留文件名，每个会话只留最近 `SESSION_STEPS_KEEP = 1_000` 条（`limits.ts`、`steps.ts`）。

### 怎么认出“读了技能”：先检验前提

前两轮验收（PR #331 的两条 FAIL 评论）都栽在同一个前提上：从命令文本还原出模型读了哪个文件，就能知道它加载了哪个技能。第一轮用 `shell-quote` 栽在注释、heredoc、变量替换和 `..`；第二轮用 `tree-sitter-bash` 栽在 `cd` 之后的相对路径、子 shell 和软链。再补 cwd、子 shell、realpath，就是在仓库里写一个 shell 模拟器。

检验办法：`scripts/skill-load-replay.ts` 只读打开账本和各家原始记录，拿工具真实的返回内容当事实对照（提交 `984c7933` 那一版比了三种认法）：

- A：解析 shell 命令（当时的实现）。
- B：返回内容里出现某个已知技能 `SKILL.md` 的开头。
- C：已知技能名单加上对工具输入的简单文本匹配（输入里有 `<名字>/SKILL.md`）。

项目经理的历史记录，以 B 为准，A、C 少记 / 多记的条数：

| 项目经理 | B 认到 | A 少记 / 多记 | C 少记 / 多记 |
| --- | --- | --- | --- |
| claude | 49 | 27 / 2 | 8 / 42 |
| codex | 21 | 4 / 0 | 4 / 14 |
| agy | 203 | 0 / 0 | 0 / 35 |
| pi | 0 | 0 / 0 | 0 / 5 |

- A 漏掉 `cd …/skills && cat x/SKILL.md`、`for f in …` 循环、`$S/x/SKILL.md` 变量、模型去读 Claude 存下的超长输出文件；多记 `sed … | grep`（只输出了 grep 的结果）和读当时不存在的文件。
- C 多记的是 `hub worker start <<EOF` 派活正文、`hub persona edit`、`wc -l`。
- B 逐条核对都对。本机 91 个技能都以 `---` 加 `name: <名字>` 开头。

结论：去掉“从命令文本还原文件”这个条件，看返回内容。只有一处例外：agy 的 `read_file` 在实时流里只回行数和字节数（上一节），返回里没有正文。它的路径是工具自己的结构化参数（`Path`），不是从 shell 文本里猜的，按路径认，规则见下文。

实现以后，重放脚本改成直接调生产代码（识别函数和每个会话自己的已知技能名单），只用实时流拿得到的东西（返回原文按 `outputField` 取、按上限截；agy 的 `read_file` 只看路径参数和读没读成功），和原始记录里的完整返回对照：

- 项目经理：7,223 次有返回的读文件和命令，不一致 0 处。另有 16 处返回里有任务图手册的开头，但那些会话的启动目录已经清掉了，拿今天的磁盘重放找不到这个文件；当时它在名单里。
- 全部角色：44,354 次，不一致 1 处，是这个 Worker 自己排查时用 `strings` 导出 agy 会话库，输出里是 `1: ---` 这种行号，claude 的 `Bash` 没有声明这种前缀，按规则不算加载。另有 235 处是 worktree、启动目录已经删掉。

### 仓库里已经零散处理技能的地方

| 位置 | 做什么 | 这次怎么处理 |
| --- | --- | --- |
| `src/shared/step-labels.ts:70` `SKILL_FILE_RE`、`:73` `skillName()` | 从路径认技能、去掉命名空间 | 搬进新的技能模块，状态行改成引用它 |
| `src/shared/task-graph-skill.ts:19-27` `INTERNAL_SKILL_COMMAND_NAMES` | 写死 `fusa:`、`skill:` 两种前缀，判断是不是任务图技能 | 改用同一个名字规整函数，删掉写死的前缀表 |
| `src/vendors/_common/composer.ts:27` 闭包里的 `commandNameOf` | 认用户原文是不是命令 | 提到 `VendorComposerBase` 上，记录用户调用时直接用，不另写一个解析 |
| `src/daemon/ledger/ledger.ts:201-205` | 开场说明里“未完结的任务图”后面每次都接一行任务图手册路径，提醒新会话去读 | 删掉。见“删掉什么” |
| 项目经理的性格设定 | “每个会话开工先读 SKILL.md 全文” | 合并后由项目经理用 `hub persona edit` 删掉这句。它是用户数据，不在 PR 里 |

## 比较过的做法

### 在哪一层认出“加载了技能”

| 做法 | 好处 | 问题 |
| --- | --- | --- |
| A. 账本收 `agent.tool`、`agent.tool_result` 和 `message.processing` 事件时，用一个共享的识别函数认（推荐） | 六家已经统一成同一种事件；各家差异只剩 `spec.ts` 里几项声明；和写 `session_steps` 在同一个事务里，不会漏也不会多记 | `agent.tool_result` 要带上返回原文，六家驱动都要传 |
| B. 各家驱动各自发一个新的 `skill.loaded` 事件 | 每家能用自己最准的信号 | 同一件事写六遍，以后每加一家都要记得写 |
| C. 从 `session_steps` 的摘要里认 | 不加代码路径 | 摘要截断、遮密钥、只留文件名、每会话只留 1000 条，认不全 |
| D. 换代时翻各家原始会话记录 | 不用实时记 | 六种格式，agy 是 sqlite 库别家读不了；用户已经否掉 |

推荐 A。驱动只管把返回原文按 spec 声明的字段取出来，认不认、怎么认都在共享的识别函数里。

### 记录存在哪

| 做法 | 好处 | 问题 |
| --- | --- | --- |
| E. 新表 `loaded_skills`，一个技能一行，按对话和代数归属（推荐） | 去重、排序、裁剪都是一条 SQL；行数等于用过的不同技能数，不随消息涨；删项目经理时和别的会话表一起删 | 加一个迁移 |
| F. `agent_sessions` 上加一个 JSON 列 | 不加表 | 每次加载都要读出整列改写；换代要把列抄进下一代，行数跟着代数涨 |
| G. 记在 `session_steps` 里加一种 `kind` | 不加表 | 被每会话 1000 条的修剪删掉，正是要防的“隔一段就丢” |

推荐 E。

## 方案

### 数据形状

**工具结果事件带上返回原文。** `src/shared/driver.ts`：

```ts
export interface AgentToolResultEvent {
  type: "agent.tool_result";
  toolUseIds: string[];
  /** 工具的返回原文，按 toolUseId，最多 SKILL_LOAD_SCAN_MAX_CHARS 字。驱动拿不到的不写。 */
  outputs?: Readonly<Record<string, string>>;
}
```

- 只用来认技能加载。账本不存进数据库（`messages`、`session_steps` 都不写它），不进状态快照，不进给网页的任何响应。
- 驱动按 spec 声明的字段取（下文 `skillSignals.outputField`），用共享的 `toolOutputText`（`src/vendors/_common/tool-output.ts`）摊平成文字：字符串原样；数组逐项接起来；对象取 `text`，没有就取 `content`，再没有取 `stdout`。claude 的块数组、pi 的 `{content: [...]}`、ACP 的 `[{type: "content", content: {text}}]`、cursor 的 `{content}` 和 `{stdout}` 都是这一个函数。摊平时到上限就停，超出的部分不认，事件也不会背着几兆的输出走。

**记录表**，新迁移 `0031_loaded_skills.sql`（main 上 0028～0030 已被 `review_workers`、`user_blockers`、`deliverables` 占了）：

```sql
CREATE TABLE loaded_skills (
  conversation_id INTEGER NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  skill_key       TEXT    NOT NULL, -- SKILL.md 的真实路径（realpath），软链和原文件算同一个技能
  name            TEXT    NOT NULL, -- 规整后的技能名，显示用
  path            TEXT    NOT NULL, -- 枚举技能目录时得到的路径
  source          TEXT    NOT NULL CHECK (source IN ('user', 'model')), -- 最近一次是谁加载的
  generation      INTEGER NOT NULL, -- 最近一次加载或被带进的那一代
  loaded_at       INTEGER NOT NULL, -- 最近一次真正加载的时间；被带进下一代时不改
  PRIMARY KEY (conversation_id, skill_key)
) STRICT;
CREATE INDEX loaded_skills_generation ON loaded_skills (conversation_id, generation, loaded_at DESC);
```

- 归属是项目经理的私有对话（`conversation_id`）加代数。换代本来就按对话进行，`agent_sessions.generation` 每次换代加一，换厂商也加一。
- “第 N 代加载过的技能”就是 `generation = N` 的行。
- 去重键是 `(conversation_id, skill_key)`。同一个技能再加载一次，`INSERT … ON CONFLICT DO UPDATE` 改 `path`、`source`、`generation`、`loaded_at`。仓库里 `.claude/skills` 是指向 `.agents/skills` 的软链，按真实路径去重，同一个技能不会记成两行。
- 只记已知技能名单里的技能（下一节）。不在名单里的不记，记了换代时也读不了。

### 已知技能名单

认技能、换代读正文都只用这份名单，`src/daemon/skill-files.ts` 的 `catalog(session)` 给。它枚举这些技能目录（按名字找时先到先得；名字是目录项，身份是真实路径，同一个名字指同一个文件只留一条，跨名软链按两个名字各留一条，别名不遮蔽原名）：

1. 这个会话启动目录里的产品技能目录（`launch/<会话>/skills`，任务图手册在这里）；
2. 工作目录和每个附加目录下，这家 `VendorSyncAdapter.skillTarget(ctx, { kind: "project" })` 给的目录，再加 `<目录>/.agents/skills`；
3. 这家 `skillTarget(ctx, { kind: "global" })` 给的全局目录，再加 `~/.agents/skills`；
4. 别的几家在项目和全局声明的技能目录。切换厂商以后上一家目录里的技能还要能读，模型也会去读别家目录里的技能。

这份目录清单是 vendor-sync 每家必写的声明（`src/vendors/daemon-types.ts` 的 `skillTarget`）：claude 是 `.claude/skills` 和 `~/.claude/skills`，agy 全局是 `~/.gemini/config/skills`，pi 全局是 `~/.pi/agent/skills`，其余三家是 `.agents/skills`。不另起一张目录表。

边界只有一条，写在 `skillFileIn` 上：真实路径恰好是 `<可信根>/<合法技能名>/SKILL.md` 的普通文件才进名单。可信根是锚点（启动目录、用户主目录、各项目目录）先求真实路径，再按字面拼上技能子路径（如 `.claude/skills`），拼的这一段不跟随软链；环境变量把厂商配置目录指到主目录外面时，那个目录自己是锚点。合法技能名是一段目录名（不是 `.`、`..`，不带 `/`、`\`）。软链指到另一个可信根里面照常收：`.claude/skills → ../.agents/skills` 这种整目录软链、vendor-sync 在 `~/.gemini/config/skills/<名字>` 建的逐项软链（指到 `~/.agents/skills/<名字>`）。技能子路径的任何一段、单个技能目录、`SKILL.md` 本身是软链，指到技能目录外面或仓库里别的目录的，都不进名单。威胁模型：仓库和 worktree 里可以放任意软链；不防能在检查和读取之间换文件的本机进程。换代读正文读核对过的真实路径；上一代记下的技能这一代过不了边界的，和文件没了一样注明没带过来。名单里每个技能记名字、枚举到的路径、真实路径、文件身份（设备号加 inode），和从文件开头读出的“开头”：

- frontmatter 开头：文件头两个非空行（`---`、`name: <名字>`）；
- 正文开头：frontmatter 之后的头两个非空行（跳过 frontmatter 只读正文的也认）。

claude 插件里的技能（如 `slack:block-kit`）在 `~/.claude/plugins/…` 下，不在名单里，不记。

名单按会话缓存。每次取之前看一眼各技能目录的修改时间，新加、删掉技能时目录会变，马上重建；只改了某个 `SKILL.md` 的内容，最晚 `SKILL_CATALOG_TTL_MS` 后重读。换代时不用缓存、现枚举。不缓存时建一次名单约 9 毫秒（本机，约 100 个技能）。

### 识别规则

新模块 `src/shared/skill-loads.ts` 是唯一的定义，六家共用。它只看名单和事件，不碰磁盘、不解析 shell：

1. **工具返回内容里出现某个已知技能的开头，就算加载了。** 只看读文件（`read`）和跑命令（`command`）两类动作，动作按 `tools.actions` 翻。返回原文取前 `SKILL_LOAD_SCAN_MAX_CHARS` 字，按行切开（`\r\n` 和 `\n` 都算），每行去掉这家声明的行号前缀（`outputLinePrefix`）、行尾空白，丢掉空行；相邻两行和某个技能的开头一样，就是读了它。读了中段、输出被 `grep` 过滤、文件不存在的，返回里没有开头，不算。
2. **返回里没有正文的读文件工具，按它的路径参数认。** 只有声明在 `readByPath` 里的工具走这条（现在只有 agy 的 `read_file`）。返回要匹配声明的“读成功”样子（agy 是 `14 lines, 310 bytes`），而且是从头读的（`StartLine` 没给或不大于 1，`ByteOffset` 没给或是 0）；路径参数按会话工作目录解析，和名单里的技能是同一个文件（设备号加 inode 相同）才算：软链、硬链都认。agy 不跟软链，任务图手册是硬链进启动目录 `agy-rules/.agents/skills/` 的（`src/vendors/agy/rules.ts`），这个目录不在名单里，按同一个文件认得到；换代读正文仍然只读名单里的路径。路径是工具自己的结构化参数，不是从命令文本里猜的。
3. **原生技能工具。** 动作是 `skill` 的，技能名在 `toolNameKeys` 声明的参数里（claude 的 `Skill` 是 `skill`，deepseek 的 `skill` 是 `name`），调用那一刻按名字在名单里找。
4. **用户手打的命令。** 一批消息开始处理（`message.processing`）时，看其中 `sender = 'user'`、`kind = 'text'` 的消息，用 `commandNameOf(text, 开头)`（`src/vendors/types.ts`，输入框也用它）取命令名，再按 `userTriggers` 额外认 codex 的 `$名字`，按名字在名单里找。记在真正处理它的那一代上。
5. **名字规整。** `skillNameOf(raw)`（`src/shared/skill-names.ts`）去掉命名空间：`fusa:fusa-task-graph`、`skill:frontend-rules` 都取最后一段。状态行、任务图技能的隐藏判断、这里共用这一个函数。
6. 子代理里的调用（`parentToolUseId` 有值）不记，和 `session_steps` 一样，那不是项目经理自己的上下文。

调用和返回是两个事件。账本收到读文件、跑命令的 `agent.tool` 时，把工具名和参数按 `toolUseId` 先放在内存里（最多 `SKILL_LOAD_PENDING_TOOLS_MAX` 个，返回到了就取走），等 `agent.tool_result` 来了一起认。守护进程重启时还没返回的那几个认不到，这一步不补。

**各家差异只放在 `spec.ts` 里。** 每家都要写一个块：

```ts
skillSignals: {
  /** 驱动从工具结果的哪个字段取返回原文（toolOutputText 摊平）。 */
  outputField: string;
  /** 读文件工具给返回的每一行加的行号，认之前去掉。 */
  outputLinePrefix?: RegExp;
  /** 返回里没有正文、按路径参数认的读文件工具：键是工具名，ok 是读成功时返回的样子，fromStart 是“从头读”的参数上限。 */
  readByPath?: Readonly<Record<string, { ok: RegExp; fromStart?: Readonly<Record<string, number>> }>>;
  /** 用户手打调用技能的开头，默认 [composer.commandPrefix]；codex 另认 "$"。 */
  userTriggers?: readonly string[];
  /** 原生技能工具里放技能名的参数键；没有原生技能工具的不写。 */
  toolNameKeys?: readonly string[];
};
```

| 厂商 | `outputField` | `outputLinePrefix` | `readByPath` | 其余 |
| --- | --- | --- | --- | --- |
| claude | `content`（`tool_result` 块） | `/^\s*\d+\t/` | | `toolNameKeys: ["skill"]` |
| codex | `aggregatedOutput`（`item`） | | | `userTriggers: ["/", "$"]` |
| agy | `output`（`tool_info`） | | `read_file: { ok: /^\d+ lines?, \d+ bytes?$/, fromStart: { StartLine: 1, ByteOffset: 0 } }` | |
| pi | `result`（`tool_execution_end`） | | | |
| deepseek | `content`（`tool_call_update`） | `/^\d+: /` | | `toolNameKeys: ["name"]` |
| cursor | `rawOutput`（`tool_call_update`） | | | |

`skillSignals` 是必填的：加一家新厂商不写它类型检查就不过。`src/shared/skill-loads.test.ts` 的样例表按 `Record<AgentVendor, …>` 写，每家至少一条“用户手打”和一条“模型加载”，新厂商不填样例类型检查也不过。

### 带进新会话

`switchIn` 里加一步 `carrySkills(p, conversationId, fromGeneration, toGeneration, session)`，普通换代、手动开新会话、切换厂商都走它。读盘也在这里，和 `switchIn` 已经调的 `transcriptOf(old)` 一样，是换代那一刻的最新版本。

1. 取 `generation = 旧代` 的行，按 `loaded_at` 从新到旧排。
2. 现枚举新会话的已知技能名单（不用缓存），每行先按真实路径（`skill_key`）在名单里找，找不到再按名字找（任务图手册在每个会话自己的启动目录里，换代后路径会变）。名单里没有的，记进“读不到了（文件没了或不在技能目录里）”。只读名单里的文件：读之前再核一次它的真实路径没变，从模型可控的文本里拼出来的路径一律不打开。
3. 去掉 YAML frontmatter。单个超过 `SKILL_CARRYOVER_SKILL_MAX_CHARS` 的从前往后截，末尾写“（后面省略 N 字，全文在 <路径>）”。
4. 累计超过 `SKILL_CARRYOVER_TOTAL_MAX_CHARS` 时，放不下的那个和之后的都不带正文，只进“没带正文”名单。不为了塞进去再截短，照 Claude Code 的做法。
5. 带上正文的行改成 `generation = 新代`，`loaded_at` 不变，所以下一代仍按真正加载的先后排。没带上的留在旧代，不再往下传。
6. 拼好的一节存进 `handovers` 新加的 `skills_section` 列。普通换代把它拼进 `preamble`；切换厂商时 `sessionPreamble` 读这一列传给 `buildVendorSwitchPreamble`。

这一节放在开场说明的说明头后面、交接之前。技能是长期照着做的规矩，放前面；对话放最后，离新消息最近。切换厂商时同样放在说明头后面、“本代起点摘要”之前。

它的身份是“上一代会话加载过的技能”，是引用的资料，不是系统指令：

```text
## 上一个会话加载过的技能

下面是上一个会话里加载过的技能正文，按最近加载排在前面，系统换会话时从磁盘读的最新版本。它们算你已经加载过，照上一个会话里一样用，不用再读一遍。

<skill name="poteto-mode" path="/…/.agents/skills/poteto-mode/SKILL.md" loaded-by="user">
…正文…
</skill>

<skill name="frontend-rules" path="/…/SKILL.md" loaded-by="model">
…正文…
</skill>

没带正文（篇幅超了）：principle-model-the-domain（/…/SKILL.md）、…。要用时自己加载。
读不到了（文件没了或不在技能目录里）：old-skill（/…/SKILL.md）。
```

用 `<skill>` 标签包正文，不用代码块：技能正文里常有 ``` 代码块，套代码块会提前闭合。“没带正文”名单最多列 `SKILL_CARRYOVER_SKIPPED_LIST_MAX` 个名字。

交接提示词（`handoverRequestText` 里“新会话手里只有”那一串，`handover.ts:106-111`）加一项“上一个会话加载过的技能正文（系统自动带上，交接里不用写）”，免得旧会话把篇幅花在列技能上。开场说明头（`sessionPreambleText`、`buildVendorSwitchPreamble` 的头几行）同样提一句下面附了技能正文。

### 传下去

被带进新一代的行在第 5 步改成了新一代的代数，所以新一代换代时它们又会被取出来。新一代里自己又加载一次，只是更新 `loaded_at` 和 `source`。连着两代都被预算挤掉的技能才会丢，和 Claude Code 一样。

### 上限和性能

准备写进 `src/shared/limits.ts` 的数：

| 名字 | 值 | 为什么 |
| --- | --- | --- |
| `SKILL_CARRYOVER_SKILL_MAX_CHARS` | `30_000` | 本机 59 个仓库技能里最大的是 poteto-mode，24,946 字，几乎全是英文，约 6～7K token；中位数 2,614 字（实测）。Claude Code 的单个 5000 token 约合 2 万英文字，会把 poteto-mode 的后半截掉，而它正是这件事的起因。3 万字给它留了余量 |
| `SKILL_CARRYOVER_TOTAL_MAX_CHARS` | `80_000` | 英文为主时约 2 万 token，和 Claude Code 合计 25000 token 相当。按 poteto-mode 加十来个 2～3 千字的原则技能算放得下 |
| `SKILL_CARRYOVER_RECORDS_MAX` | `200` | 每个对话最多记这么多行，超了按 `loaded_at` 删最旧的。本机仓库里 59 个、用户目录里 33 个，有重名，合计不到 92 个（实测），200 够用 |
| `SKILL_CARRYOVER_SKIPPED_LIST_MAX` | `20` | “没带正文”名单最多列的名字数 |
| `SKILL_LOAD_SCAN_MAX_CHARS` | `64_000` | 一次工具返回最多看这么多字，驱动摊平时就截在这里，后面的不认。重放本机全部历史（项目经理和 Worker），技能开头在返回原文里最远出现在第 48,353 字（一条命令接连 `cat` 好几个技能）；Claude 的 `Bash` 输出本身在 3 万字左右截断。留了约三分之一的余量 |
| `SKILL_CATALOG_TTL_MS` | `30_000` | 已知技能名单按会话缓存多久。新装、删掉技能看目录修改时间马上重建；只改 `SKILL.md` 内容的最晚 30 秒后重读；换代时不用缓存 |
| `SKILL_CATALOG_CACHE_MAX` | `32` | 最多缓存几个会话的名单。只有项目经理的会话会建，同时在跑的不过几个 |
| `SKILL_CATALOG_MAX_SKILLS` | `1_000` | 一份名单最多多少个技能。本机所有技能目录合起来 91 个不同的技能 |
| `SKILL_HEAD_READ_BYTES` | `16_384` | 建名单时每个 `SKILL.md` 只读开头这么多字节算“开头”。本机最长的 frontmatter 1,101 字节 |
| `SKILL_LOAD_PENDING_TOOLS_MAX` | `256` | 调用发出、返回还没到的读文件和命令，内存里最多记几个。返回到了就取走；并行的工具调用一般只有几个 |

- **记录条数。** 行数等于这个对话用过的不同技能数，不随消息数、代数涨。按跑一个月、3 万条消息算，每个项目经理也就几十行；就算十个项目经理都满，也只有 2000 行。每次加载只写一行，换代时多一次带索引的查询。
- **换代时读盘。** 现枚举一次名单（本机约 100 个 `SKILL.md`，每个读开头 16KB），再读旧一代的行，一般十来个文件；正文读到合计上限就停，最多读约 8 万字。单个文件按 `SKILL_CARRYOVER_SKILL_MAX_CHARS` 的 4 倍字节封顶。毫秒级。
- **认工具返回。** 只认项目经理主会话里读文件、跑命令的返回，在账本事务里同步跑：返回按行切开，相邻两行查一张“开头 → 技能”的表，和返回长度成正比，和技能个数无关。重放本机全部历史（`node scripts/skill-load-replay.ts --role all`）：44,354 次工具返回共 1.34 秒，平均每次 30µs；项目经理的 7,223 次共 0.17 秒，平均 23µs。
- **开场体积。** 新会话开场现在占 77K～92K token（实测）。这一节最多多出约 2 万 token（英文技能；中文技能 1 字约 1 token，同样字数会更多），在 400K 阈值里占 5%。窗口小于 400K 的厂商当项目经理时本来就会先撞上自己的窗口（交接对话里已经说过），这一节让它早一点撞上，量级不变。
- **清理。** 删项目经理时，`src/daemon/ledger/persona.ts:715-795` 那串按对话删的语句里加一行 `DELETE FROM loaded_skills WHERE conversation_id IN …`，外键也写了 `ON DELETE CASCADE`。归档项目经理不删，取消归档后接着用。
- **缓存四件事。** 这张表是会随时间变多的列表：
  1. 失效：不缓存正文，每次换代从磁盘读；文件没了当场跳过并注明。名单缓存 30 秒过期，换代时现枚举。
  2. 上限：上面的数。名单缓存有个数上限和过期时间；还没返回的工具调用有个数上限；工具返回原文不进库、不进快照、不进网页响应。
  3. 前端引用稳定：不推给网页，不涉及。
  4. 验证：实现 PR 用 pstack 的 `benchmark-checklist` 量 `switchIn` 加这一步前后的耗时、开场说明的字数，写进 PR。

### 删掉什么

照“先减后加”，被新做法取代的在实现 PR 里一起删：

1. `src/daemon/ledger/ledger.ts:201-205`：`liveActiveGraphsSection` 给未完结的任务图后面接一行 `taskGraphManual(sessionId)`。这是“换代后叫模型去重读任务图手册”的旧说法。上一代加载过手册的，新做法把正文直接带过去；没加载过的，系统提示词第 2 步（`src/daemon/prompt.ts:109-117`）和 `hub graph` 的回执里本来就有手册路径。删掉后 `src/daemon/task-graph-skill.ts:28`、`:54-57` 注释里“换新会话的开场说明”那一处，和 `docs/orchestration-skill-design.md` 第 7 节里“开场说明带手册路径”这一道一起改掉。
2. `src/shared/task-graph-skill.ts:15-23` 的 `INTERNAL_SKILL_COMMAND_NAMES`：写死的 `fusa:`、`skill:` 前缀表删掉，`isInternalSkillCommand` 改成 `skillNameOf(name) === TASK_GRAPH_SKILL_NAME`。
3. `src/shared/step-labels.ts:69-77` 的 `SKILL_FILE_RE` 和 `skillName()`：搬进 `src/shared/skill-names.ts`（不引别的模块，`step-labels.ts`、`task-graph-skill.ts`、`skill-loads.ts` 都引它，避免 `skill-loads.ts` 和 `step-labels.ts` 互相引用），不留第二份。
4. `src/vendors/_common/composer.ts:27-31` 闭包里的 `commandNameOf`，和 `src/vendors/codex/composer.ts` 的 `rewriteCodexSkillCommand` 里另写的一份：合成 `src/vendors/types.ts` 的纯函数 `commandNameOf(text, 开头)`，输入框、codex 的 `$` 改写、记录用户调用都用它，不留三套解析。
5. 项目经理性格设定里“每个会话开工先读 SKILL.md 全文”：合并后由项目经理用 `hub persona edit` 删掉，不再留一句叫模型重读的提示词。

不再引入的：前两轮为了从命令文本还原文件加的 `shell-quote`、`tree-sitter-bash`、`web-tree-sitter`、`src/shared/shell-syntax.ts`、`skill-loads.ts` 里整套 shell 解析和它们的测试、打包时裁 `tree-sitter-bash` 的那几行，都从这个 PR 里拿掉，`AGENTS.md` 的“我们用的组件”不加它们。

不删的：驱动层把命令单独写进会话（`base-driver.ts:303`、`:604`）是厂商命令行认命令的前提，和这件事无关。

### 要改的文件

- `migrations/0031_loaded_skills.sql`：新表。
- `src/shared/driver.ts`：`AgentToolResultEvent.outputs`。
- `src/vendors/_common/tool-output.ts`（新）：`toolOutputText(value)`，按上限摊平返回原文。
- 各家驱动（`claude/protocol.ts`、`codex/driver.ts`、`agy/driver.ts`、`pi/driver.ts`、`_common/acp/driver.ts`）：发 `agent.tool_result` 时按 `skillSignals.outputField` 带上 `outputs`。
- `src/vendors/types.ts`、各家 `spec.ts`：`skillSignals`。
- `src/shared/skill-names.ts`（新）：`SKILL_FILE_RE`、`skillNameOf`、`skillNameOfFile`、`isSkillName`。
- `src/shared/skill-loads.ts`（新）：名单的形状和“开头”的算法（`skillHeads`、`createSkillCatalog`），`skillOfToolCall`、`skillsOfToolResult`、`awaitsToolResult`、`userSkillCommandOf`。纯函数，不碰磁盘。
- `src/daemon/skill-files.ts`（新）：枚举技能目录建名单（缓存）、`atPath` 的同一个文件比对、换代时读正文。守护进程按 `launchDir`、用户目录、环境变量建好传给账本（`LedgerOptions.skillFiles`），测试用临时目录里的真文件。
- `src/daemon/ledger/loaded-skills.ts`（新）：收事件记录、`carryIn`（即上文的 `carrySkills`）、渲染那一节。
- `src/daemon/ledger/handover.ts`：`switchIn` 调 `carrySkills`；`sessionPreambleText`、`handoverRequestText`、`sessionPreamble` 带上这一节；文件开头第 4 步的说明改成新的开场组成。
- `src/daemon/ledger/vendor-switch-context.ts`：`buildVendorSwitchPreamble` 收 `skills`。
- `src/daemon/ledger/persona.ts`：删项目经理时清表。
- `src/shared/limits.ts`：上面的数。
- `src/shared/step-labels.ts`、`src/shared/task-graph-skill.ts`、`src/vendors/_common/composer.ts`、`src/daemon/ledger/ledger.ts`：见“删掉什么”。
- `scripts/skill-load-replay.ts`：重放历史，直接调生产代码的识别函数，和返回内容对照。
- 文档：`docs/background-handover-design.md` 里开场说明的组成，`docs/orchestration-skill-design.md` 第 7 节。

### 测试

先提交会失败的测试，再实现：

- `src/shared/skill-loads.test.ts`：每家至少一个“用户手打”和一个“模型加载”的样例被认出，返回原文用实时流里的真实形状：claude `Read`（带 `1\t` 行号）、`Bash`、`Skill`、`/poteto-mode`；agy `read_file`（`14 lines, 310 bytes`，按路径）、`run_command`（带元信息头、`\r\n`）；codex `commandExecution`、`/名字` 和 `$名字`；pi `read`、`/skill:名字`；deepseek `skill`、`read`（`1: ` 行号）；cursor `Read`（`rawOutput.content`）、`Shell`（`rawOutput.stdout`）。不该认的：只读中段、输出被过滤、文件不存在、超过扫描上限才出现的开头、agy 从中间读的 `read_file`、agy 读失败、名单外的路径。两份 FAIL 评论里的复现全部覆盖：`${H%% *}`、heredoc 里的模板字符串、`#` 注释后面的读取、`hub worker start --stdin <<EOF` 派活正文、`cd …/skills && cat <名字>/SKILL.md`、`(cd /tmp && ls); cat …`、`\<换行>` 续行、`Skill: "../../.."`、`skills/../SKILL.md`。
- `src/daemon/skill-files.test.ts`：名单只收技能目录里的 `SKILL.md`；`.claude/skills → ../.agents/skills` 和逐项软链照常能用；一张表把软链位置（技能子路径每一段、单个技能目录、`SKILL.md` 本身，项目、全局、启动目录都有）× 指向（外面、仓库里的 `docs`、另一个可信根）列全，前两种不收，第三种收；锚点本身是软链时按真实锚点算；建完名单后整个技能目录掉包成软链，现枚举不收、旧的也不读；`atPath` 只认真实路径相等的。
- 各家驱动的测试：`agent.tool_result` 带上 `outputs`；agy 用实跑抓的流裁成的夹具。
- `src/daemon/ledger/loaded-skills.test.ts`：按返回认、按路径认、调用和返回分开到；软链去重；单个截断和合计裁剪；跨两代继承；文件缺失跳过并注明；合法加载后目录掉包成指到外面的软链，换代不读外面的文件、同样注明；任务图手册换了启动目录后按名字重新找到；超过 `SKILL_CARRYOVER_RECORDS_MAX` 删最旧的；删项目经理后表里没有这个对话的行；返回原文不进 `messages`、`session_steps`。
- `src/daemon/ledger/handover.test.ts`：普通换代、手动开新会话、切换厂商三条路的开场说明都带这一节，位置在说明头后面；开场说明里不再有任务图手册那一行。
- 重放：`node scripts/skill-load-replay.ts --role all`，生产代码和返回内容对照零分歧。
- 本机照 `AGENTS.md` 跑 `pnpm typecheck` 和这些测试文件；这次不涉及写入范围，不用跑 `src/shared/write-scope.test.ts`。

### 验收方法

照 `test/smoke/auto-renew.ts` 的做法，新加 `test/smoke/skill-carryover.ts`，手动跑 `node test/smoke/skill-carryover.ts claude codex`：

1. 在临时数据目录里起守护进程：`AGENT_HUB_HOME` 指向临时目录，`startDaemon({ autoRenew: { contextTokens: 1, idleMs: … } })`。小阈值只从这个测试专用的参数注入（`HandoverOptions.autoRenew`，`handover.ts:66`），不改默认值。
2. 项目文件夹里放两个测试技能，正文里各写一个暗号：`.agents/skills/carry-user/SKILL.md`、`.agents/skills/carry-model/SKILL.md`。
3. 用户发 `/carry-user 记住它`；再发一句让模型自己读 `carry-model` 技能。
4. 等空闲后自动换代，从账本 `handovers.preamble`（切换厂商看 `skills_section`）里打印“上一个会话加载过的技能”那一节，确认两个暗号都在。
5. 问新会话两个暗号，答得出来。
6. 再触发一次换代，第三代开场里两个技能还在（传下去）。
7. 把 `carry-model` 删掉再换代，开场里写着“读不到了（文件没了或不在技能目录里）”。

至少 claude 和另一家（codex 或 agy）各跑一次，把开场里那一节的片段贴进 PR。

## 用户会感觉到的变化

- 项目经理换代后，上一代用过的技能（包括你手打的 `/poteto-mode`、它自己读过的技能）会原样出现在新会话里，不用再靠它自己记得去读。
- 切换厂商时也一样带过去。现在切换厂商会丢掉技能正文。
- 每次换代多占约 2 万 token 的上下文，和交接加原话的 4 万多相比不大。
- 用过很多技能时，只带最近的几个，其余的列个名字，要用时它自己再加载。
- 性格设定里“每个会话开工先读全文”那句会删掉。
- 认得更全也更准（按本机历史重放）：项目经理在 claude 上多记 27 次、codex 上多记 4 次以前漏掉的真实加载（`cd` 进技能目录再读、循环读、变量路径）；只读了中段、输出被 `grep` 过滤、文件当时不存在的，不再算加载（项目经理历史上 2 次）。
