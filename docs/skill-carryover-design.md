# 换代时带上加载过的技能

## 要解决什么

项目经理的会话用到 400K token 会自动换代。旧会话写交接，新会话从零开始，上一代加载过的技能正文全部丢掉。poteto-mode 只能手打命令加载，不在模型的技能清单里，现在只靠性格设定里“每个会话开工先读全文”一句话维持。

用户定的做法：

- 技能被加载的那一刻由 Fusa 记下来。用户手打调用的、模型自己加载的都记。
- 换代时 Fusa 把记下的技能正文直接放进新会话的开场说明，不靠模型自觉去重读，也不让模型判断哪些该重读。
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

不带。`buildVendorSwitchPreamble` 回放本代的用户原话、项目经理文字、Worker 汇报和部分系统通知（`formatGenerationMessage`，`vendor-switch-context.ts:97-126`），取消息时排除了 `kind = 'tool'`（`handover.ts:471`）。模型用工具读进来的 `SKILL.md` 正文是工具结果，不在 `messages` 里。用户手打 `/poteto-mode` 时，正文由厂商命令行展开，Fusa 的 `messages` 里只有 `/poteto-mode 这个skill更新了` 这行原文（账本 `messages.id = 61781`）。所以切换厂商后，新厂商只看到“用户调用过 /poteto-mode”，看不到正文。（实测）

结论：切换厂商和普通换代一样要带，走同一段代码。

### 总助和 Worker

- 总助（`role = 'assistant'`）每条指令起一个临时会话，跑完一轮就结束（`src/daemon/router/prompt.ts:131` 的“跑完即焚”、`src/daemon/ledger/router.ts:1263-1280`）。自动换代只认 `role === "pm"`（`handover.ts:338`）。总助没有自动换代，不在范围内。（实测）
- Worker 的会话不自动换代（`limits.ts:107` 的注释）。（实测）

### 各家加载技能时 Fusa 收到什么

Fusa 已经把六家的工具调用统一成 `agent.tool` 事件（`name` 是厂商原工具名，`input` 是完整参数），账本在 `src/daemon/ledger/steps.ts:117` 收它写 `session_steps`。各家工具名到通用动作（`read`、`command`、`skill`……）的翻译已经在各家 `spec.ts` 的 `tools.actions` 里，`src/shared/step-labels.ts:190` 合成一张表。`step-labels.ts:70` 的 `SKILL_FILE_RE` 已经能从读文件的路径认出“在加载技能 X”，网页状态行的 “Loading skill frontend-rules” 就是它出的。

用户手打的命令都经过 Fusa：网页发来原文，驱动层把命令单独写进会话（`src/daemon/driver/base-driver.ts:303`、`:604`），codex 在发出前把 `/名字` 改成 `$名字`（`src/vendors/codex/composer.ts:100`）。

| 厂商 | 用户手打调用 | 模型用原生技能工具 | 模型读文件工具 | 模型用 shell 读 |
| --- | --- | --- | --- | --- |
| claude | `/poteto-mode 这个skill更新了`（`messages.id = 61781`，实测）。stream-json 只回放 `<command-name>/frontend-rules</command-name>`，不带技能路径（2026-11-16 用 `claude -p --replay-user-messages` 实测） | `Skill`，`input: {"skill":"frontend-rules"}`，结果是 `Launching skill: frontend-rules`（Worker 280 的会话记录，实测）；插件技能写成 `fusa:fusa-task-graph` | `Read`，`file_path: …/.agents/skills/poteto-mode/SKILL.md`（实测） | `Bash`，项目经理用 `cat .agents/skills/poteto-mode/SKILL.md` 读 poteto-mode（交接对话里项目经理自述，推断） |
| agy | `/名字`，同 claude 的输入框写法（推断，读 `src/vendors/agy/composer.ts`） | 没有 | `read_file`，`session_steps` 里 “Loading skill poteto-mode”“Loading skill unslop”（实测） | `run_command`，如 `wc -l $S/poteto-mode/SKILL.md`（实测，路径里有变量） |
| codex | Fusa 里是 `/名字`，发出前改成 `$名字`（读代码，实测） | 没有 | 没有 | `commandExecution`，`/bin/zsh -lc '…cat .agents/skills/poteto-mode/SKILL.m…'`（实测）。codex 自己的 `parsed_cmd` 只把单条命令认成 `read`，多行脚本是 `unknown`：本机记录里读 `SKILL.md` 的 97 次里 56 次是 `unknown`（实测） |
| pi | `/skill:名字`（`src/vendors/pi/composer.ts:2`，推断） | 没有 | `read`，“Loading skill frontend-rules: …/.agents/skills/frontend-rules/SKILL.md”（实测） | `bash`（推断） |
| deepseek | `/名字`（推断） | `skill`，参数 `{"name": "<技能名>"}`（读 `@deepseek-ai/dsh-tool-skill` 0.2.2-rc.1 源码，实测） | `read`（推断） | `bash`（推断） |
| cursor | `/名字`（`src/vendors/cursor/composer.ts:146` 扫的就是技能目录，推断） | 没有 | `Read`、`read_file`（推断） | `Shell`、`run_terminal_cmd`（推断） |

本机账本里 deepseek 没有会话，cursor 只有 4 个，这两家只能推断。

两个结论决定了做法：

1. 只有读文件工具和 shell 命令给的是路径。claude 的 `Skill`、deepseek 的 `skill`、所有用户手打的命令只给名字。所以要有一处“名字找 `SKILL.md`”的解析，六家共用。
2. `session_steps` 不能当记录来源。摘要截到 300 字、遮了密钥，`Read` 只留文件名，每个会话只留最近 `SESSION_STEPS_KEEP = 1_000` 条（`limits.ts:24`、`steps.ts:31`、`:105-113`）。

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
| A. 账本收 `agent.tool` 和 `message.processing` 事件时，用一个共享的识别函数认（推荐） | 六家已经统一成同一种事件，`input` 是完整参数；各家差异只剩 `spec.ts` 里几项声明；和写 `session_steps` 在同一个事务里，不会漏也不会多记 | 识别函数要懂 shell 命令 |
| B. 各家驱动各自发一个新的 `skill.loaded` 事件 | 每家能用自己最准的信号，比如 codex 的 `parsed_cmd` | 同一件事写六遍；codex 的 `parsed_cmd` 漏掉一半多行脚本，最后还是要共享的 shell 识别；以后每加一家都要记得写 |
| C. 从 `session_steps` 的摘要里认 | 不加代码路径 | 摘要截断、遮密钥、只留文件名、每会话只留 1000 条，认不全 |
| D. 换代时翻各家原始会话记录 | 不用实时记 | 六种格式，agy 是 sqlite 库别家读不了；用户已经否掉 |

推荐 A。B 的好处在 A 里也拿得到：哪家有更准的信号，就在它的 `buildCodexToolInput` 这类已有函数里把参数补全，识别函数不变。

### 记录存在哪

| 做法 | 好处 | 问题 |
| --- | --- | --- |
| E. 新表 `loaded_skills`，一个技能一行，按对话和代数归属（推荐） | 去重、排序、裁剪都是一条 SQL；行数等于用过的不同技能数，不随消息涨；删项目经理时和别的会话表一起删 | 加一个迁移 |
| F. `agent_sessions` 上加一个 JSON 列 | 不加表 | 每次加载都要读出整列改写；换代要把列抄进下一代，行数跟着代数涨 |
| G. 记在 `session_steps` 里加一种 `kind` | 不加表 | 被每会话 1000 条的修剪删掉，正是要防的“隔一段就丢” |

推荐 E。

## 方案

### 数据形状

新迁移 `0028_loaded_skills.sql`（main 上最新是 `0027_vendor_switch.sql`；任务图 #18 如果先合进一个 0028，就顺延）：

```sql
CREATE TABLE loaded_skills (
  conversation_id INTEGER NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  skill_key       TEXT    NOT NULL, -- SKILL.md 的真实路径（realpath），软链和原文件算同一个技能
  name            TEXT    NOT NULL, -- 规整后的技能名，显示用
  path            TEXT    NOT NULL, -- 最近一次认到的路径，原样
  source          TEXT    NOT NULL CHECK (source IN ('user', 'model')), -- 最近一次是谁加载的
  generation      INTEGER NOT NULL, -- 最近一次加载或被带进的那一代
  loaded_at       INTEGER NOT NULL, -- 最近一次真正加载的时间；被带进下一代时不改
  PRIMARY KEY (conversation_id, skill_key)
) STRICT;
CREATE INDEX loaded_skills_generation ON loaded_skills (conversation_id, generation, loaded_at DESC);
```

- 归属是项目经理的私有对话（`conversation_id`）加代数。换代本来就按对话进行，`agent_sessions.generation` 每次换代加一，换厂商也加一（`handover.ts:561`）。
- “第 N 代加载过的技能”就是 `generation = N` 的行。
- 去重键是 `(conversation_id, skill_key)`。同一个技能再加载一次，`INSERT … ON CONFLICT DO UPDATE` 改 `path`、`source`、`generation`、`loaded_at`。仓库里 `.claude/skills` 是指向 `.agents/skills` 的软链，按真实路径去重，同一个技能不会记成两行。
- 解析不到 `SKILL.md` 的不记。没有路径就没法在换代时读正文，记了也带不过去。

### 识别规则

新模块 `src/shared/skill-loads.ts` 是唯一的定义，六家共用：

1. **从工具调用认。** 用 `step-labels.ts` 已有的合成表把工具名翻成通用动作，再按动作取参数：
   - `skill`：技能名在 `spec.skillSignals.toolNameKeys` 声明的参数里（claude 是 `skill`；deepseek 的键名实现时实测后填）。
   - `read`：路径在 `STEP_INPUT_KEYS` 里那几个路径键（`file_path`、`AbsolutePath`、`TargetFile`、`Path`、`path`），六家已经共用。
   - `command`：命令在 `command` 或 `CommandLine`。用 `shell-quote`（npm 上成熟的 shell 分词库）把命令拆成一段段，先拆开 `sh|bash|zsh -c/-lc '<脚本>'` 和 PowerShell `-Command` 这层包装，再按换行、`;`、`&&`、`||`、`|` 分段。某一段的命令是读文件的（`cat`、`head`、`tail`、`sed`、`nl`、`less`、`more`、`bat`、`Get-Content`、`gc`、`type`），它的参数里的技能路径就算加载。带 `>` 重定向的段和 `sed -i` 是在写，不算。`ls`、`wc`、`grep`、`find`、`stat` 不读正文，不算。参数里有没展开的变量（如 `$S/poteto-mode/SKILL.md`）认不出，不记。
   - 相对路径按工具参数里的 `cwd`（codex 有）或会话的工作目录解析。
   - 子代理里的调用（`parentToolUseId` 有值）不记，和 `session_steps` 一样，那不是项目经理自己的上下文。
2. **从用户消息认。** 一批消息开始处理（`message.processing`）时，看其中 `sender = 'user'`、`kind = 'text'` 的消息，用 `commandNameOf(text, 开头)`（`src/vendors/types.ts`，输入框也用它）取命令名，再按 `spec.skillSignals.userTriggers` 额外认 codex 的 `$名字`。记在真正处理它的那一代上；换代时被挪到新会话的消息因此记在新一代。
3. **名字规整。** `skillNameOf(raw)`（`src/shared/skill-names.ts`）去掉命名空间：`fusa:fusa-task-graph`、`skill:frontend-rules` 都取最后一段。状态行、任务图技能的隐藏判断、这里共用这一个函数。
4. **名字找路径。** `resolveSkillFile(name, session)` 按顺序在这些目录里找 `<名字>/SKILL.md`，第一个存在的就是：
   - 这个会话启动目录里的产品技能目录（`launch/<会话>/skills`，任务图手册在这里）；
   - 工作目录和每个附加目录下，这家 `VendorSyncAdapter.skillTarget(ctx, { kind: "project" })` 给的目录（`mode: "native"` 就是 `<目录>/.agents/skills`），再加 `<目录>/.agents/skills`；
   - `skillTarget(ctx, { kind: "global" })` 给的全局目录，再加 `~/.agents/skills`。

   这份目录清单已经是 vendor-sync 每家必写的声明（`src/vendors/daemon-types.ts:221`），claude 是 `.claude/skills` 和 `~/.claude/skills`，agy 全局是 `~/.gemini/config/skills`，pi 全局是 `~/.pi/agent/skills`，其余三家是 `.agents/skills`。不另起一张目录表。

   claude 插件里的技能（如 `slack:block-kit`）在 `~/.claude/plugins/…` 下，这份清单找不到，不记。claude 的 `system init` 事件里有插件的路径（实测），以后要补就从那里取，这次不做。

**只认技能目录下的 `SKILL.md`，不认任何 `SKILL.md`。** 规则沿用 `SKILL_FILE_RE`：路径形如 `…/skills/<名字>/SKILL.md`。理由有三条。六家的技能目录都叫 `skills`，这是 Agent Skills 的标准布局。目录名就是技能名，用户手打和 `Skill` 工具给的名字能和它对上，同一个技能不管怎么加载都去重成一行。别处碰巧叫 `SKILL.md` 的文件（依赖包里的文档、测试夹具）不该被当成技能带进新会话。

**各家差异只放在 `spec.ts` 里。** 新增一个块：

```ts
skillSignals?: {
  /** 用户手打调用技能的开头，默认 [composer.commandPrefix]；codex 另认 "$"。 */
  userTriggers?: readonly string[];
  /** 原生技能工具里放技能名的参数键；没有原生技能工具的不写。 */
  toolNameKeys?: readonly string[];
};
```

工具名到动作的翻译（`tools.actions`）和技能目录（`sync.ts` 的 `skillTarget`）是每家本来就要写的。加一家新厂商，照常写这两处，有特殊写法再填 `skillSignals`。`src/shared/skill-loads.test.ts` 的样例表按 `Record<AgentVendor, …>` 写，每家至少一条“用户手打”和一条“模型加载”，新厂商不填样例类型检查就不过。

### 带进新会话

`switchIn` 里加一步 `carrySkills(p, conversationId, fromGeneration, toGeneration, session)`，普通换代、手动开新会话、切换厂商都走它。读盘也在这里，和 `switchIn` 已经调的 `transcriptOf(old)` 一样，是换代那一刻的最新版本。

1. 取 `generation = 旧代` 的行，按 `loaded_at` 从新到旧排。
2. 一个个读 `path`。读不到的用 `resolveSkillFile(name, 新会话)` 按名字再找一次（任务图手册在每个会话自己的启动目录里，换代后路径会变）。还是没有的，记进“找不到”名单。
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
文件已经没有了：old-skill（/…/SKILL.md）。
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

- **记录条数。** 行数等于这个对话用过的不同技能数，不随消息数、代数涨。按跑一个月、3 万条消息算，每个项目经理也就几十行；就算十个项目经理都满，也只有 2000 行。每次加载只写一行，换代时多一次带索引的查询。
- **换代时读盘。** 只读旧一代的行，一般十来个文件，最多 200 次 `stat`；正文读到合计上限就停，最多读约 8 万字。单个文件按 `SKILL_CARRYOVER_SKILL_MAX_CHARS` 的 4 倍字节封顶，防止误认到一个大文件。和 `switchIn` 里已有的 `findTranscript` 是同一量级，毫秒级。
- **开场体积。** 新会话开场现在占 77K～92K token（实测）。这一节最多多出约 2 万 token（英文技能；中文技能 1 字约 1 token，同样字数会更多），在 400K 阈值里占 5%。窗口小于 400K 的厂商当项目经理时本来就会先撞上自己的窗口（交接对话里已经说过），这一节让它早一点撞上，量级不变。
- **清理。** 删项目经理时，`src/daemon/ledger/persona.ts:715-795` 那串按对话删的语句里加一行 `DELETE FROM loaded_skills WHERE conversation_id IN …`，外键也写了 `ON DELETE CASCADE`。归档项目经理不删，取消归档后接着用。
- **缓存四件事。** 这张表是会随时间变多的列表：
  1. 失效：不缓存正文，每次换代从磁盘读；文件没了当场跳过并注明。
  2. 上限：上面四个数。
  3. 前端引用稳定：不推给网页，不涉及。
  4. 验证：实现 PR 用 pstack 的 `benchmark-checklist` 量 `switchIn` 加这一步前后的耗时、开场说明的字数，写进 PR。

### 删掉什么

照“先减后加”，被新做法取代的在实现 PR 里一起删：

1. `src/daemon/ledger/ledger.ts:201-205`：`liveActiveGraphsSection` 给未完结的任务图后面接一行 `taskGraphManual(sessionId)`。这是“换代后叫模型去重读任务图手册”的旧说法。上一代加载过手册的，新做法把正文直接带过去；没加载过的，系统提示词第 2 步（`src/daemon/prompt.ts:109-117`）和 `hub graph` 的回执里本来就有手册路径。删掉后 `src/daemon/task-graph-skill.ts:28`、`:54-57` 注释里“换新会话的开场说明”那一处，和 `docs/orchestration-skill-design.md` 第 7 节里“开场说明带手册路径”这一道一起改掉。
2. `src/shared/task-graph-skill.ts:15-23` 的 `INTERNAL_SKILL_COMMAND_NAMES`：写死的 `fusa:`、`skill:` 前缀表删掉，`isInternalSkillCommand` 改成 `skillNameOf(name) === TASK_GRAPH_SKILL_NAME`。
3. `src/shared/step-labels.ts:69-77` 的 `SKILL_FILE_RE` 和 `skillName()`：搬进 `src/shared/skill-names.ts`（不引别的模块，`step-labels.ts`、`task-graph-skill.ts`、`skill-loads.ts` 都引它，避免 `skill-loads.ts` 和 `step-labels.ts` 互相引用），不留第二份。
4. `src/vendors/_common/composer.ts:27-31` 闭包里的 `commandNameOf`，和 `src/vendors/codex/composer.ts` 的 `rewriteCodexSkillCommand` 里另写的一份：合成 `src/vendors/types.ts` 的纯函数 `commandNameOf(text, 开头)`，输入框、codex 的 `$` 改写、记录用户调用都用它，不留三套解析。
5. 项目经理性格设定里“每个会话开工先读 SKILL.md 全文”：合并后由项目经理用 `hub persona edit` 删掉，不再留一句叫模型重读的提示词。

不删的：驱动层把命令单独写进会话（`base-driver.ts:303`、`:604`）是厂商命令行认命令的前提，和这件事无关。

### 要改的文件

- `migrations/0028_loaded_skills.sql`：新表。
- `src/shared/skill-names.ts`（新）：`SKILL_FILE_RE`、`skillNameOf`、`skillNameOfFile`。
- `src/shared/skill-loads.ts`（新）：`toolSkillLoads(vendor, toolName, input)`、`userSkillCommandOf(vendor, text)`。纯函数，不碰磁盘。
- `src/daemon/skill-files.ts`（新）：认到的加载落到哪个 `SKILL.md`（按名字找的目录清单、相对路径、`realpath`）、换代时读正文。守护进程按 `launchDir`、用户目录、环境变量建好传给账本（`LedgerOptions.skillFiles`），测试用临时目录里的真文件。
- `src/vendors/types.ts`、各家 `spec.ts`：`skillSignals`。
- `src/daemon/ledger/loaded-skills.ts`（新）：收事件记录、`carryIn`（即上文的 `carrySkills`）、渲染那一节。
- `src/daemon/ledger/handover.ts`：`switchIn` 调 `carrySkills`；`sessionPreambleText`、`handoverRequestText`、`sessionPreamble` 带上这一节；文件开头第 4 步的说明改成新的开场组成。
- `src/daemon/ledger/vendor-switch-context.ts`：`buildVendorSwitchPreamble` 收 `skills`。
- `src/daemon/ledger/persona.ts`：删项目经理时清表。
- `src/shared/limits.ts`：四个数。
- `src/shared/step-labels.ts`、`src/shared/task-graph-skill.ts`、`src/vendors/_common/composer.ts`、`src/daemon/ledger/ledger.ts`：见“删掉什么”。
- `package.json`：加 `shell-quote`（和 `@types/shell-quote`），`AGENTS.md` 的“我们用的组件”同一个 PR 里补上。
- 文档：`docs/background-handover-design.md` 里开场说明的组成，`docs/orchestration-skill-design.md` 第 7 节。

### 测试

先提交会失败的测试，再实现：

- `src/shared/skill-loads.test.ts`：每家至少一个“用户手打”和一个“模型加载”的样例被认出，用上面表里的真实参数形状：claude `Skill`、`Read`、`Bash cat`、`/poteto-mode`；agy `read_file`、`run_command`；codex `/bin/zsh -lc '…cat …/SKILL.md…'`（单行和多行脚本）、`/名字` 和 `$名字`；pi `read`、`/skill:名字`；deepseek `skill`、`read`；cursor `Read`、`Shell`。不该认的：`ls`、`wc`、`grep`、`cat > SKILL.md`、`sed -i`、不在 `skills/<名字>/` 下的 `SKILL.md`、带变量的路径、子代理里的调用。
- `src/daemon/ledger/loaded-skills.test.ts`：软链去重；单个截断和合计裁剪（裁掉的进名单、留在旧代）；跨两代继承（第 1 代加载、第 2 代没再加载、第 3 代开场里还在）；文件缺失跳过并注明；任务图手册换了启动目录后按名字重新找到；超过 `SKILL_CARRYOVER_RECORDS_MAX` 删最旧的；删项目经理后表里没有这个对话的行。
- `src/daemon/ledger/handover.test.ts`：普通换代、手动开新会话、切换厂商三条路的开场说明都带这一节，位置在说明头后面；开场说明里不再有任务图手册那一行。
- 本机照 `AGENTS.md` 跑 `pnpm typecheck` 和这些测试文件；这次不涉及写入范围，不用跑 `src/shared/write-scope.test.ts`。

### 验收方法

照 `test/smoke/auto-renew.ts` 的做法，新加 `test/smoke/skill-carryover.ts`，手动跑 `node test/smoke/skill-carryover.ts claude codex`：

1. 在临时数据目录里起守护进程：`AGENT_HUB_HOME` 指向临时目录，`startDaemon({ autoRenew: { contextTokens: 1, idleMs: … } })`。小阈值只从这个测试专用的参数注入（`HandoverOptions.autoRenew`，`handover.ts:66`），不改默认值。
2. 项目文件夹里放两个测试技能，正文里各写一个暗号：`.agents/skills/carry-user/SKILL.md`、`.agents/skills/carry-model/SKILL.md`。
3. 用户发 `/carry-user 记住它`；再发一句让模型自己读 `carry-model` 技能。
4. 等空闲后自动换代，从账本 `handovers.preamble`（切换厂商看 `skills_section`）里打印“上一个会话加载过的技能”那一节，确认两个暗号都在。
5. 问新会话两个暗号，答得出来。
6. 再触发一次换代，第三代开场里两个技能还在（传下去）。
7. 把 `carry-model` 删掉再换代，开场里写着“文件已经没有了”。

至少 claude 和另一家（codex 或 agy）各跑一次，把开场里那一节的片段贴进 PR。

## 用户会感觉到的变化

- 项目经理换代后，上一代用过的技能（包括你手打的 `/poteto-mode`、它自己读过的技能）会原样出现在新会话里，不用再靠它自己记得去读。
- 切换厂商时也一样带过去。现在切换厂商会丢掉技能正文。
- 每次换代多占约 2 万 token 的上下文，和交接加原话的 4 万多相比不大。
- 用过很多技能时，只带最近的几个，其余的列个名字，要用时它自己再加载。
- 性格设定里“每个会话开工先读全文”那句会删掉。
