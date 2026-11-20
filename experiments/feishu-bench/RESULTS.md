# 飞书通道实测（2026-11-18，PR #350）

机器：Mac，10 核，跑测时 load average 5.7~6.6（同机还有别的 agent 在跑，两边结论都不受影响：瓶颈是模拟的网络延迟和限流间隔，不是 CPU）。

## 流式卡片：`node experiments/feishu-bench/stream.ts 300`

真账本 + 假传输层（`daemon/feishu/test-helpers.ts`），每次飞书调用加 80 ms 模拟网络延迟，按飞书规则限流：“流式更新文本”全应用 50 次/秒、每张卡 10 次/秒，同一个群发消息 5 次/秒，超了回 99991400 / 230020；同一张卡的 sequence 不递增记错。模型按 150 字/秒出字。

| 项 | 结果 |
| --- | --- |
| 第一块文字 → 群里出现流式卡片 | 中位 243 ms（5 次，241~248）。其中 240 ms 是建卡、发消息、回包三次模拟网络往返，守护进程自己约 3 ms |
| 一段 5,000 字（写 32 秒） | “流式更新文本”106 次，3.3 次/秒；定稿正文等于账本这段文字 |
| 三个项目经理同时流式 314 秒（65 段、144,484 字） | 推送 2,986 次，任一秒最多 12 次；限流错误 0；sequence 倒退 0；丢段 0（每段定稿正文都等于账本） |

手机上真正出字还要加飞书服务端推到客户端的时间，这里量不到，需在飞书真机客户端实测（架构见 `docs/feishu-design.md`）。

## 守护进程 RSS

同一个脚本里按顺序量（3 次短跑 + 1 次长跑，RSS 有 GC 抖动）：

| 阶段 | RSS |
| --- | --- |
| 只有账本 | 154~156 MB |
| 加上飞书通道（没配飞书，不加载官方 SDK） | +4~9 MB |
| 配了飞书，加载 `@larksuiteoapi/node-sdk` | 再 +42 MB |

实现里把 SDK 改成配了飞书才动态加载（`daemon/feishu/service.ts` 的 `transportFactory`）：没用飞书的人不付这 42 MB。长跑高峰 259 MB 里包括脚本自己留的全部调用记录（假传输层把 3,000 多次调用的卡片 JSON 都存着），不算通道的占用。

## hubCall 的访客拦截：`node experiments/feishu-bench/hubcall.ts 3000`

一个项目经理会话里 3,000 条已回复的用户消息，`GUARD_SQL=old` 和默认各跑 3 次交替：

| | 拦截查询 p50 | 整次 `hubCall status` p50 |
| --- | --- | --- |
| 按 `messages_session` 扫（最初的写法） | 0.245 ms | 0.27 ms |
| 部分索引 `messages_in_flight`（迁移 0034） | 0.0005 ms | 0.02 ms |

查询计划从 `SEARCH messages USING INDEX messages_session (session_id=? AND sender=?)` 变成 `... messages_in_flight (session_id=?)`，只碰在途的几行，会话再长也不变。
