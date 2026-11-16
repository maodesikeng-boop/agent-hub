# 要用户本人动手的事：系统挂卡、处理完接着派（方案）

## 1. 问题

任务图自动开工时目标厂商没登录、Worker 起来时报认证失败，守护进程当场就知道原因，却只发给项目经理，步骤显示 `Waiting on PM`。
项目经理不挂卡，用户就不知道要去登录；登录好了还要项目经理记得重派。

## 2. 数据形状

类型只在 `src/shared/user-blockers.ts` 定义：

```ts
type UserBlockerKind = "vendor_signed_out" | "vendor_not_installed";   // 等什么
interface UserBlockerCause { kind; vendor: AgentVendor; device: string } // 哪家、哪台设备
interface UserBlocker extends UserBlockerCause {
  id;
  recheckedAs: VendorAvailability | null;      // 点过“已处理”、重查还不能用时那次的状态
}
```

表（`migrations/0029_user_blockers.sql`）：

| 表 | 一行是什么 | 删除时 |
|---|---|---|
| `user_blockers` | 一个原因：同一家厂商在这台设备上只有一条在等（按 `vendor` 的部分唯一索引，`status = 'open'`）。每台守护进程只判断自己，设备是隐含的，存设备名只为卡上写清楚 | 删掉时下面三张表跟着删 |
| `user_blocker_cards` | 一张卡：被这个原因卡住的每个项目经理对话里一条提醒消息（主键 `(blocker_id, conversation_id)`） | 对话或那条消息删掉只删这张卡，阻塞和别的对话不受影响 |
| `user_blocker_steps` | 被卡住的步骤（不改步骤表的列） | 步骤删掉跟着删；步骤离开“等用户”由触发器 `task_graph_steps_user_blocker_clear` 删 |
| `user_blocker_workers` | 起不来的 Worker，带没送进去的消息编号 | Worker 删掉跟着删 |

- **谁在等**：`user_blocker_steps` 和 `user_blocker_workers`，可以跨项目经理。
- **在哪看得到**：每个受影响的项目经理对话里一张卡，都指回同一条阻塞（`meta.blockerRef.blockerId`）。
- **怎么解除**：用户在任意一张卡上点 `Done`，重查这家厂商在这台设备上的状态，`isSelectable` 就解开，所有卡、步骤、Worker 一起接着走。

厂商现在能不能用只有一个来源：守护进程的 `ModelCatalogs`（`daemon/driver/model-catalog.ts`）。守护进程把它原样传给账本（`createLedger` 的 `models`），
账本只读 `models.availability(vendor)`（`LedgerContext.vendorAvailability`）。会变旧的地方都在这一个对象里更新：

- agent 接口在 `hub worker start --vendor`、建图或推进图要自动开工前调 `ensureUsable`：还没问过（守护进程刚起来）或现在不能用的先问一次；
- 真跑的结果（会话起来了、认证失败）用 `report` 直接改；
- 点 `Done` 时界面服务先 `list({ vendor, refresh: true })` 重问。

所以上游步骤自动做完、在 Worker 汇报的事务里交棒给下游（没有 agent 接口那一步）时，读到的也是这台设备上最新知道的状态。

由它推出来的：

| 东西 | 从哪推 |
|---|---|
| 步骤状态 | `waiting` + `waitingFor: "user"`，`TaskNode.userBlocker` 不是 null；网页状态词仍是 `Waiting on you` |
| 卡 | `hub ask` 同一种消息（`meta.needsUser`），带 `blockerRef`，不进总助待决卡（不归项目经理关）；正文是 `userBlockerCardText` |
| `hub worker start` 拒绝的原因 | 同一个 `userBlockerText` |
| 重派 | 见第 4 节的 `resolveIn` |

## 3. 哪些情况挂卡

| 情况 | 怎么认出来 | 挂卡 |
|---|---|---|
| 任务图自动开工，目标厂商没登录 / 没装 | 账本派 Worker 时抛 `UserBlockedError`（带原因），不是字符串 | 是 |
| Worker 起不来，报认证失败 / 找不到程序 | `userBlockerKindOfFailure(原文, 厂商)`：`VENDOR_FAILURE_SIGNS` 的 `auth` / `missing` | 是 |
| 项目经理手动 `hub worker start --vendor` 选了不能用的 | 当场报错给项目经理（同一句话），它可以改派别家；报错会回滚事务，所以不挂卡 | 否 |
| 额度用完 | 重置靠时间，用户点了也解不开，系统也查不到额度回没回来 | 否 |
| 机器没有 OS 沙箱（只读 Worker 派不了） | 解除条件是装系统组件、重启守护进程，重查不是厂商状态 | 否 |

## 4. 流程

1. 挂卡（`raiseIn`，在派 Worker 或 Worker 失败的那个事务里）：找这家厂商在等的那条，没有就建；被卡住的那个项目经理对话里还没有这条的卡就挂一张。
   再把这一步或这个 Worker 记上去。项目经理照常收到一句说明（已挂卡、处理完自动接着派，不用它挂卡或重派）。
2. 用户点卡上的 `Done`：网页 `POST /api/user-blockers/:id/recheck`，界面服务先让 `ModelCatalogs` 重问这家（异步，事务外），再调 `ledger.recheckUserBlocker(id)`：
   - 还不能用：所有卡留着，正文后面补“刚查过，还是没登录。”，被卡住的图推一次变化，回 `{ resolved: false }`；
   - 能用：在一个事务里 `resolveIn`，回 `{ resolved: true }`。再点一次（或两个窗口、两个对话同时点）看到已解决，原样回，不重复派。
3. `resolveIn` 是“用户处理完、阻塞解除”这一次状态转换，卡、步骤、Worker、事件一起变：
   - 这条标 `resolved`，所有卡标已答（重查过的去掉“刚查过”那句）；
   - 被它卡住、还在等用户的步骤全部离开等用户（`task-graphs.ts` 的 `releaseUserBlockedStepsIn`）：没派出去的退回没轮到、重算整张图自动开工；
     挂着的 Worker 还开着的回到在干；Worker 已经收工的交给项目经理。每张受影响的图推一次 `task_graph.updated`；
   - 起不来的 Worker 接着跑（`workers.ts` 的 `resumeUserBlockedWorkerIn`）：没送进去、标了失败的消息重新排队；都已经不是失败了
     （用户在 Worker 对话里点了重试、厂商先回了一段报错文字）又没有在发的，发一句 `userBlockerResumeText` 叫它接着干。
   步骤和 Worker 各改各的，不互相等对方的结果，所以不会出现步骤还在等用户、阻塞却已经没了的“空拍板卡”。

## 5. 多设备与兼容

- 卡和步骤都在出问题那台守护进程上，网页经 `/d/<设备>/api/...` 转发到那台重查，状态也是那台的。
- 老服务端的步骤没有 `userBlocker`（字段可选），当 `null`，照旧当拍板卡。

## 6. 测试

- `test/e2e/user-blockers.test.ts`（真守护进程 + 假的未登录 agy）：冷启动第一次建图、上游 Worker 汇报做完后自动交棒给 agy 下游，都挂卡等用户；
  两个项目经理各一张卡、同一条阻塞；登录后点一次 `Done`，两边的步骤都开工、两张卡都标已答。
- `src/daemon/ledger/user-blockers.test.ts`（账本 + 真的 `ModelCatalogs` 配假来源）：自动开工没登录挂卡、两张图同一家只挂一张、重查还不行留卡、
  重查能用接着派且再点不重复派；Worker 起不来报认证失败挂卡并在解开后重发原消息；那条消息已经在重发或不是失败时步骤照样回到在干；
  第二个项目经理的 Worker 被同一家卡住也有自己的卡；清掉第一个项目经理不影响第二个。
- `test/migration.test.ts`：0029 建表、每个对话一张卡、删对话只删它的卡、触发器、回退 `user_version = 8 / 28` 重跑不丢。
- `src/daemon/driver/model-catalog.test.ts`：还没问过的厂商 `ensureUsable` 先问一次；`current()` 带现在的状态。
- `src/shared/user-blockers.test.ts`：失败原文的认法、卡上的话。
- `src/web/user-blocker.test.tsx`：步骤显示 `Waiting on you` 与提醒卡，点 `Done` 调重查接口。
