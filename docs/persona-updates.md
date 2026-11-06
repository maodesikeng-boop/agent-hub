# 改性格设定、模式不重启（PR #100）

项目经理的性格设定、模式写在系统提示词最后。改了以后不重启会话，在下一条写进 agent 的消息前面加一段【系统】说明（照 Claude Code 发现 `CLAUDE.md` 改了的做法：开头不动，后面追加）。模型、思考程度、文件夹、厂商变了照旧重启。

代码：`src/shared/driver.ts` 的“两轮之间自动重启”、`src/daemon/driver/persona-note.ts`、账本的 `personaUpdate`、`src/daemon/prompt.ts` 的 `personaUpdateNote`。

## 说明怎么带

- 每个会话记着 agent 已经看到的那一版（`persona_changes` 的编号），存在 `session_persona_seen` 表（迁移 0012），守护进程重启也接得上。
- 写每一行之前比一次：用户改的、撤销的带完整新内容；项目经理自己 `hub persona edit` 改的只说一句“已生效”。同一版只带一次，连改几次只带最新的。命令那一行不带，留给下一条。
- 没写成、停止时 agent 没取走、要重发的行，版本退回到这一行之前（取更早的那个），下一行再带。多带一次无害，漏了不行。
- 进程真起来（claude 的第一个 init、codex 线程建好、agy 的第一个 init）才定“看到了哪一版”，参数选错重试的那次不算数。
- 0012 之前的老会话没有记录，按 0 算：第一条带一次全文。

## 新进程算不算按最新的拼过（实测）

| 厂商 | 新会话 | 恢复会话 |
|---|---|---|
| claude 2.1.314 | `--session-id`：按最新的拼 | `--resume`：沿用会话**最初**的系统提示词，换了 `--append-system-prompt(-file)` 也不用 |
| codex 0.162 | `thread/start`：按最新的拼 | `thread/resume`：沿用**最初**的 `developerInstructions` |
| agy | 每个新进程第一条消息前面都重新带系统指令，算按最新的拼 | 同左 |

所以 claude、codex 闲置关闭后再起来、换模型、崩溃恢复之后，照样靠说明；只有开新会话（和 agy 的新进程）不再带。

实测办法（暗号）：第一次起进程时系统提示词写“暗号是 A”，第一轮不问暗号（免得对话历史带偏）；关掉进程，提示词改成“暗号是 B”，恢复同一个会话问暗号。

- claude（2026-11-06）：`claude -p --session-id … --append-system-prompt "暗号是 APPLE"`，之后两次 `--resume` 分别换成 BANANA、CHERRY，都答 APPLE。transcript 里存了第一次请求的 `api-request-shape`（带系统提示词），恢复时用它。
- codex（2026-11-06，gpt-5.6-luna）：冒烟 S30（`pnpm smoke S30`，`test/smoke/codex-resume.ts`），APPLE→BANANA 答 APPLE，KIWI→MANGO 答 KIWI。

厂商升级后重跑：codex 要是改成用新的说明，把 `persona-note.ts` 的 `CODEX_RESUME_REBAKES` 改成 true。

## 缓存（冒烟 S29，claude-haiku-5-5）

改完后第一次请求的缓存命中：重启方式（main）33451，本方式 33491，差不多。原因同上：claude `--resume` 本来就沿用老系统提示词，重启不让缓存失效，但新设定也送不到模型（重启方式的回复没按新设定做，本方式按了）。

## 已知的坑

挂、移除文件夹、建项目之后会 `--resume` 重启，但系统提示词里“你的项目”一节还是会话最初的。`RELAUNCH_NOTE` 已经改成“最新的以 `hub status`、`hub persona show` 为准”，提示词本身过期另行处理。
