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
  id; askMessageId: MessageId | null;          // 卡：项目经理对话里那条提醒消息
  recheckedAs: VendorAvailability | null;      // 点过“已处理”、重查还不能用时那次的状态
}
```

- **谁在等**：被卡住的步骤（`user_blocker_steps`，不改步骤表的列）和起不来的 Worker（`user_blocker_workers`，带没送进去的消息编号）。
- **怎么解除**：重查这家厂商在这台设备上的状态（`ModelCatalogs.list({ vendor, refresh: true })`），`isSelectable` 就解开。
- 同一家厂商在这台设备上只有一条在等（`user_blockers` 上按 `vendor` 的部分唯一索引，`status = 'open'`）。每台守护进程只判断自己，所以设备是隐含的，存设备名只为卡上写清楚。

由它推出来的：

| 东西 | 从哪推 |
|---|---|
| 步骤状态 | `waiting` + `waitingFor: "user"`，`TaskNode.userBlocker` 不是 null；网页状态词仍是 `Waiting on you` |
| 卡 | `hub ask` 同一种消息（`meta.needsUser`），带 `blockerRef`，不进总助待决卡（不归项目经理关）；正文是 `userBlockerText` |
| `hub worker start` 拒绝的原因 | 同一个 `userBlockerText`（替掉原来的 `vendorUnavailableMessage`） |
| 重派 | 解开时：没派出去的步骤退回没轮到、重算整张图（自动开工）；起不来的 Worker 把失败的消息重新排队、步骤回到在干 |

步骤离开“等用户”（换人、跳过、放行……）时，触发器 `task_graph_steps_user_blocker_clear` 删掉它在 `user_blocker_steps` 里的那一行，
各处改步骤状态的代码不用记得清它。

## 3. 哪些情况挂卡

| 情况 | 怎么认出来 | 挂卡 |
|---|---|---|
| 任务图自动开工，目标厂商没登录 / 没装 | 账本派 Worker 时抛 `UserBlockedError`（带原因），不是字符串 | 是 |
| Worker 起不来，报认证失败 / 找不到程序 | `userBlockerKindOfFailure(原文, 厂商)`：`VENDOR_FAILURE_SIGNS` 的 `auth` / `missing` | 是 |
| 项目经理手动 `hub worker start --vendor` 选了不能用的 | 当场报错给项目经理（同一句话），它可以改派别家；报错会回滚事务，所以不挂卡 | 否 |
| 额度用完 | 重置靠时间，用户点了也解不开，系统也查不到额度回没回来 | 否 |
| 机器没有 OS 沙箱（只读 Worker 派不了） | 解除条件是装系统组件、重启守护进程，重查不是厂商状态 | 否 |

## 4. 流程

1. 挂卡（`raiseIn`，在派 Worker 或 Worker 失败的那个事务里）：找这家厂商在等的那条，没有就建，并在被卡住的那个项目经理对话里发卡；
   有就只把这一步或这个 Worker 挂上去，不再发卡。项目经理照常收到一句说明（已挂卡、处理完自动接着派，不用它挂卡或重派）。
2. 用户点卡上的 `Done`：网页 `POST /api/user-blockers/:id/recheck`，界面服务先重查这家厂商（异步，事务外），再调 `ledger.recheckUserBlocker(id, 状态)`：
   - 还不能用：卡留着，正文后面补“刚查过，还是没登录。”，回 `{ resolved: false }`；
   - 能用：这条标 `resolved`、卡标已答，按第 2 节重派，回 `{ resolved: true }`。再点一次（或两个窗口同时点）看到已解决，原样回，不重复派。

## 5. 多设备与兼容

- 卡和步骤都在出问题那台守护进程上，网页经 `/d/<设备>/api/...` 转发到那台重查，状态也是那台的。
- 老服务端的步骤没有 `userBlocker`（字段可选），当 `null`，照旧当拍板卡。

## 6. 测试

- `src/daemon/ledger/user-blockers.test.ts`：自动开工没登录挂卡、两张图同一家只挂一张、重查还不行留卡、重查能用接着派且再点不重复派、
  Worker 起不来报认证失败挂卡并在解开后重发原消息。
- `src/shared/user-blockers.test.ts`：失败原文的认法、卡上的话。
- `src/web/user-blocker.test.tsx`：步骤显示 `Waiting on you` 与提醒卡，点 `Done` 调重查接口。
