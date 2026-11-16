# 审查只查不修：用代码强制

状态：已实现（任务图 #18 第 2 步，Worker #586，2026-11-16；第 4 步 Worker #590 堵上了 3.1 节写的两处退成普通 Worker 的口子）。方案由 Worker #584 写，实现时的出入写在对应小节里。用户原话：“审查只查不修，这是规则，用代码强制”。

起因：#16 的审查 #574、#17 的审查 #580 都直接往实现分支提交了修复，判的 PASS 验的是自己的代码。根子在设计：审查步骤和实现共用一个 worktree 和分支，清单还明写“直接修、推上去”。

## 1. 现在是什么样

**审查拿到哪个目录**：`task-graphs.ts` 的 `resolveWorkspacePlan` 不区分审查步骤。实现 → 审查是一条直线，审查就拿到 `inherit`：同一个 worktree、同一条分支（`workers.ts` 的 `dispatchStepWorkerIn` 把上游的 `worktree_path`、`branch`、`base_commit` 原样抄给新 Worker）。改了文件、`git commit`、`git push` 都直接进实现分支和 PR。

**清单怎么注入**：节点 `review: true` 时，`task-graph-handoff.ts` 的 `renderGraphStepTask` 把 `STEP_REVIEW_CHECKLIST` 拼在“你这一步”开头，写进 `workers.task`，进系统提示词。清单第 4 条是“发现问题直接在这条分支上修……推上去”。项目经理那边，`task-graph-skill.ts` 第 62 行写“接手实现的分支直接修”。

**汇报怎么走**：`onWorkerTurnReportIn` 只看“状态”和“偏离”：做完了 + 无偏离就自动 done，往下走。审查和实现用的是同一套判断，没有“结论”这个概念。

**`--readonly` 在三个平台限了什么**（`docs/readonly-worker-design.md`、`docs/write-scope.md`）：哪都不能写，只有会话私有临时目录和几个厂商运行时、缓存目录能写；禁读 `~/.ssh`、`~/.config/gh` 这类凭据；**不限网络**。
- macOS：claude 用自带沙箱，codex 用自带 readOnly，agy 外层包只读 seatbelt。
- Linux：claude、codex 用自带沙箱，agy 外层包只读 bwrap（`--ro-bind / /`）。
- Windows：codex 用自带 readOnly，其余 5 家 Win11 24H2+ 用 MXC 只读容器，低版本退回写受限令牌加工具层规则。

## 2. 三种办法比较

| | A. 独立 detached worktree + 禁推 + 收尾核对 | B. 直接用 `--readonly` | C. 只事后检测 |
|---|---|---|---|
| 改不了实现的工作目录 | 能。实现的 worktree 在数据目录里，普通 Worker 沙箱本来就只让写自己的目录（三平台都有） | 能 | 不能 |
| 提交进不了实现分支 | 能。审查目录不挂分支，`git commit` 只落在 detached HEAD；`git checkout <实现分支>` 被 git 拒（分支已签出在别的 worktree） | 能（哪都写不了） | 不能 |
| 推不到 PR | 拦住常规推送（pre-push 钩子拒绝）；故意绕过（`--no-verify`、`gh api`）拦不住，但收尾核对一定发现，步骤停下 | **拦不住**：只读不限网络，`git push` 不用写本地文件；`gh` 读不了 `~/.config/gh` 只是碰巧 | 拦不住，发现时已经上了 PR，要强推回滚（撤不回来） |
| 跑测试、写构建产物 | 能（自己的目录可写） | **不能**：vitest 缓存、`dist/`、`tsbuildinfo` 都写不了 | 能 |
| 临时改文件、换回旧版本证明测试会挂 | 能 | **不能** | 能 |
| checkout 指定 SHA | 能（只写主仓库 `.git/worktrees/<名>/`，在数据目录外） | **不能**（要写 `HEAD`、`index`） | 能 |
| 用 gh 在 PR 上评论 | 能 | **不能**（`~/.config/gh` 禁读） | 能 |
| 三平台、6 家一样 | 一样：全是 git 和账本逻辑，不碰沙箱；禁推走 `LaunchFiles.env`，6 家同一个入口 | 不一样：每家每平台一套只读实现，Windows 低版本还是降级档 | 一样 |

B 的结论是看代码得出的，没起真进程试推送。只读本来就不限网络，不用实测也能下这个结论。

**推荐 A**。B 挡不住推送，还把审查要做的事全挡了。C 是 A 的最后一层，单用等于事后救火。

## 3. 推荐做法（A）

### 3.1 审查拿独立 worktree，detached 在实现的 head 上

- `StepWorkspacePlan` 加一种 `{ kind: "review"; branch; implWorktreePath }`。“是不是审查”只看节点的 `review`：`resolveWorkspacePlan` 遇到 `review === 1` 的步骤只走 `resolveReviewPlan`，要么返回 `review`，要么报错，不会返回 `fresh`、`inherit`、`fork`。派活时按 plan 写 `workers.review_json`，所以审查步骤的每个 Worker 都有被审目标，独立目录、禁推钩子、验证提交校验和收尾核对都由它决定。
- 被审分支（被审目标）从哪来：步骤的 `base` 写了就是它（补建的单步审查图、多路合流后的审查都这么写）；没写就沿唯一上游链往上找最近一个在 worktree 分支上干活的 Worker，用它的分支。`base` 的意思统一成“这一步的工作目录从哪开始”：普通步骤只能写 `"main"`，审查步骤写被审分支名，不能是 `"main"`。
- 找不到被审分支的拒绝，不降级成普通 Worker：
  - 建图、改图时：审查步骤没写 `base`，又没有唯一的上一步（没有上一步、多路合流），直接报错（`assertReviewStepsHaveTarget`）。
  - 开工时：上一步在主文件夹里干的（链上找不到 worktree 分支），自动开工失败，步骤停在等项目经理处理，提示给它写 `base`；`hub worker start --node` 直接报同样的错。
  - 审查步骤用 `--no-worktree` 派活直接拒绝。
- 派活时仍然先把还开着的实现 Worker 收工（沿用 `inherit` 现有的那段），防止审查期间实现还在推。
- 审查 Worker 的记录：`branch = NULL`，`worktree_path` 是新目录，新增一列 `review_json`（`shared/review.ts` 的 `ReviewTarget`）：`{ branch, snapshot: { sha, remote, pr } }`。迁移 `0028` 重建 `workers` 表，把 CHECK 放宽成“worktree 要么有分支、要么有 review_json”。分支为空，现有按分支查 PR、找可接手目录的代码会自动跳过它。
- `worktree.create` 动作：`WorktreeTask.checkout` 是 `{ kind: "review", branch }`，`addWorktree` 的 `branch` 传 null，跑 `git worktree add --detach <路径> refs/heads/<实现分支>`，得到的 `baseCommit` 就是被审 SHA。同一个动作里现查 origin 上的同名分支（`remoteBranchHead`：没有 origin 是不核对、origin 上没有这个分支记 null）和 PR，交给账本的 `recordReviewSnapshot` 写进 `review_json.snapshot`。
- 首条消息（`workerWorkspaceSection`）讲清楚：你在 detached worktree，被审的是分支 X 的提交 S、PR P；本地随便改、随便提交，推不上去，收工就删。

### 3.2 禁止推送：git 自己的钩子，经环境变量注入

- 用 git 官方的 `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`（git 2.31 起）只设一项：`core.hooksPath=<state>/review-hooks`。目录里只有一个 `pre-push`，打印“审查步骤只查不修，不能推送”，退出 1。环境变量的优先级高于仓库配置，git 每个子命令都认。
- 钩子写在会话启动目录 `state/launch/<会话>/review-hooks/pre-push`，每次启动准备都重写一遍：Worker 读得到（git 要执行它），写不了（数据目录里只有自己的工作目录能写）。脚本用 `#!/bin/sh`，Git for Windows 自带 sh，三平台同一份。
- 不用 `remote.origin.pushurl` 置空：它是多值项，用户自己配过 pushurl 时只会多出一个地址，原来那个照样能推。
- 代价：审查目录里仓库自己的钩子（pre-commit 等）不跑。审查的本地提交本来就是一次性的，没有影响。

### 3.3 结论格式

- 汇报八栏不变，审查步骤多两栏：`结论: PASS | PASS+NOTES | FAIL`、`验证提交: <SHA>`。`parseWorkerReport` 认这两栏，两栏都去掉首尾标点（行内代码的反引号、句号、加粗），非审查步骤不要求写。
- 两栏记进步骤产物（`TaskArtifact` 的 `reviewVerdict`、`verifiedCommit`），`hub graph show` 和交付单里看得到；每次审查汇报整个换掉，不留前任审查的。
- 后台的判断：
  - FAIL：不管“状态”写什么都进 waiting:pm，复现写在“问题”里原样转给项目经理。修复由项目经理另派 Worker，后台不自动加步骤。
  - PASS / PASS+NOTES：先核对（3.4），通过才 done；PASS+NOTES 的“问题”照现有规则抄送项目经理。
  - 没写结论、写错，“验证提交”和 `review_json.sha` 对不上，或审查目录没记下开审时的提交：进 waiting:pm，附一句原因。审查 Worker 一定有被审目标（3.1），提交号每次都核对。

### 3.4 收尾核对：`review.verify` 动作

账本事务里不做 I/O，所以审查步骤的汇报到了以后不直接定，步骤先保持 running，再登记一个 `review.verify` 动作（跟 `worktree.create` 一样走执行器）。动作核对：

1. 本地：`git rev-parse refs/heads/<分支>` 还等于 `sha`（挡 `git update-ref`、`branch -f`）。
2. 远端：`git ls-remote` 还等于开审时记的（挡 `--no-verify` 推送、`gh api` 直接改分支）。
3. PR：用 `git/pr.ts` 现有的查询看状态还和开审时一样（挡 `gh pr merge`、关 PR）。PR 的 head 就是 origin 上的分支，第 2 项已经核对。开审时没有 PR 或 gh 查不了，不核对这一项。

结果交给账本的 `onReviewVerified`。动作参数带汇报那条 agent 消息的编号，账本按它找回汇报原文、带着核对结果再走一遍汇报处理；汇报之后项目经理又给它发了话的，这次结果作废（新的一轮会再核对）。git 出错由执行器重试，次数用完当成“核对没跑成”。都没变就按 3.3 定结论；任一项变了，进 waiting:pm，写明“被审分支在审查期间从 S 变成 S'，结论作废”。查不了（断网、没装 gh）也进 waiting:pm 并写明原因，第 1 项是本地 git，总能核对。

### 3.5 下游怎么接

审查判 FAIL 后，项目经理在审查后面加修复步骤。`resolveWorkspacePlan` 往上找目录时，把审查节点当成透明的（跟现在处理跳过的节点一样往上走），修复步骤就接手实现的 worktree 和分支，不会接到审查的 detached 目录。修完再加一个审查步骤，又是一个新的 detached 目录，核对的是新的 head。

### 3.6 还留着的口子

本地 git 和网络凭据都在审查手里，它故意 `--no-verify`、`gh api` 推送，改动还是能上 PR。要做到结构上推不上去，只能拿走审查的凭据，让 PR 评论改由后台代发。这要按厂商、按平台去遮钥匙串和凭据管理器，跟“只定义一处”冲突，这次不做。这个口子由 3.4 兜底：改动一上 PR，步骤一定停下，PASS 一定作废，不会被当成通过放过去。

## 4. 性能

- 建目录：本机实测本仓库 `git worktree add --detach` 0.4 秒，检出 34 MB（对象库和实现共用，不复制）。
- 准备命令要跑，不然测试跑不起来。本仓库 `pnpm install --frozen-lockfile` 3.4 秒，node_modules 从 pnpm store 硬链接，基本不多占盘；整个准备命令 29 秒，大头是 `codegraph init`（项目自己配的，不是本方案加的）。一个审查步骤多 30 秒左右，跟审查本身动辄十几分钟比可以接受。
- 清理：审查目录是一次性的。Worker 收工就能删（PASS 后步骤 done 自动收工），不等 3 天，不建 `hub/detached-*` 保护分支，有未提交改动也用 `git worktree remove --force` 删。判 FAIL 时 Worker 停在 waiting、不收工，目录留给项目经理看复现，收工后再删。`worktree-cleanup.ts` 按 `review_json` 不为空识别这类目录。
- 核对：最多三条命令（本地一条、`ls-remote` 一条、`gh` 一条），每个审查步骤只跑一次，不进循环。`review_json` 每个 Worker 一行，不新增会随时间变多的内存结构。

## 5. 统一

- 规则只写一处：新建 `src/shared/review.ts`，放三种结论、两个栏名、审查清单正文、禁推环境变量的生成函数、钩子脚本正文、核对失败的文案。`task-graph-handoff.ts`、`task-graph-skill.ts`、`worker.ts`、`launch.ts`、`worktree-cleanup.ts` 都从这里取。
- 不按厂商写分支：独立目录和核对是账本加 git，跟厂商无关。禁推只走 `launch.ts` 生成的 `LaunchFiles.env`，6 家都从这里拿环境变量：codex 经 `shell_environment_policy.set` 透传给它起的 shell（`vendors/codex/protocol.ts`），这条路不受它默认的 `*KEY*` 排除影响；pi、deepseek、cursor 的 ACP 子进程直接继承。
- 不碰任何平台沙箱，不改非审查步骤：`review !== 1` 时 plan、env、汇报解析都跟现在一样。

## 6. 要改的文件

- `src/shared/review.ts`（新）：见第 5 节。
- `src/daemon/ledger/task-graphs.ts`：`StepWorkspacePlan` 加 `review`；`resolveWorkspacePlan` 给审查步骤走 `resolveReviewPlan`（返回 `review` 或报错），往上找时把审查节点当透明（`findUpstreamWorktree`）；`validateStepBase` 让审查步骤的 `base` 写被审分支，`assertReviewStepsHaveTarget` 在建图、改图时拒绝定不下被审分支的审查步骤；`onWorkerTurnReportIn` 按 Worker 的 `review` 走 3.3/3.4，产物记结论和验证提交；加 `onReviewVerifiedIn`。
- `src/daemon/ledger/workers.ts`：`dispatchStepWorkerIn` 和 `hub worker start --node` 换人那条路都处理 `review` plan，审查步骤带 `--no-worktree` 拒绝；`getWorktreeTask` 给审查 Worker 返回 `checkout: { kind: "review" }`。
- `src/daemon/store/migrate.ts`：加列 `workers.review_json`。
- `src/shared/ledger.ts`、`src/shared/actions.ts`：`WorktreeTask.checkout`，新动作 `review.verify`。
- `src/daemon/git/git.ts`：`addWorktree` 的 `branch` 可以是 null（`--detach`）；加 `remoteBranchHead`；`removeWorktree` 加 `force`。`src/daemon/handlers.ts`：`worktree.create` 记开审时的被审分支，加 `review.verify` 处理器。
- `src/daemon/launch.ts`：审查 Worker 的 env 加禁推配置，启动目录里写 `review-hooks/pre-push`。
- `src/shared/worker.ts`：`parseWorkerReport` 认“结论”“验证提交”。
- `src/daemon/worktree-cleanup.ts`：审查目录收工即删。
- 文案：`src/daemon/ledger/task-graph-handoff.ts`（清单改成只查不修、写结论和 SHA、用 gh 评论、不推送）；`src/shared/task-graph-skill.ts:62`；`src/daemon/prompt.ts` 里 `workerWorkspaceSection` 给审查的那段；`docs/orchestration-simplify-design.md`（252、357、368、411、508、656、769 行）；`docs/orchestration-skill-design.md:266`；`src/daemon/ledger/task-graph-auto-dispatch.test.ts` 里“独立审查并直接修”这个标题。

## 7. 要加的测试

- `src/daemon/git/review-guard.test.ts`（新，用真 git，临时目录里建一个 bare 远端，三平台 CI 都跑）：
  - 审查目录里 `git commit` 后实现分支不变；
  - `git checkout <实现分支>` 被拒；
  - 带禁推 env 的 `git push origin HEAD:<分支>` 被 pre-push 拒，远端不变；
  - `--no-verify` 推上去、`git update-ref` 改本地分支，这两种 `review.verify` 都报“变了”。
- `src/daemon/ledger/task-graph-review.test.ts`（新）：
  - 审查步骤拿到 `review` plan，`branch` 为空，`base_commit` 等于实现 head；
  - 判 FAIL 进 waiting:pm，带复现；
  - PASS、PASS+NOTES 核对通过后 done，下游照常开工；
  - 没写结论、SHA 对不上、核对报分支变了，都进 waiting:pm；
  - 审查后面的修复步骤接手实现的 worktree；
  - 定不下被审分支（没有上一步、多路合流、`base: "main"`）建图、改图拒绝；补建的单步审查图写 `base` 照常 detached 检出并核对；上一步在主文件夹里干的不开工、停在 waiting:pm；`--no-worktree` 拒绝；
  - “验证提交”写成行内代码、带句号也认，产物记下结论和验证提交。
- `src/vendors/contract.test.ts`：6 家审查 Worker 的启动环境都带禁推配置，codex 落在 `shell_environment_policy.set` 里。
- `src/shared/worker.test.ts`：两栏的解析。
- `src/daemon/worktree-cleanup` 的测试：审查目录收工即删，有改动也删，不建保护分支。
- 文案守卫：断言 `src/shared/review.ts` 的清单正文和 `task-graph-skill.ts` 正文里不出现“直接修”“推上去”。

这次不碰沙箱规则，所以 `src/shared/write-scope.test.ts` 照跑，只用来确认没改坏。

## 8. 删掉什么

这次被新做法取代、同一个 PR 里删掉的：

- `task-graph-handoff.ts` 的 `STEP_REVIEW_CHECKLIST`（含“发现问题直接在这条分支上修……推上去”）。清单只定义在 `shared/review.ts` 的 `REVIEW_CHECKLIST`。
- 审查步骤接手实现 worktree 的路径：`resolveWorkspacePlan` 不再给审查步骤 `inherit` / `fork`，审查节点往上找时是透明的。
- `task-graph-skill.ts` 手册里“接手实现的分支直接修”；`orchestration-simplify-design.md` 第 4.4、5、9.3 节和第 13 节表格里“审查在同一条分支上补提交、直接修、推上去”的说法；第 9.3 节抄的旧清单正文（改成指向 `review.ts`）；`orchestration-skill-design.md` 的“发现问题让它直接修”。
- `worktree-cleanup.ts` 里“审查 Worker 常 detached 在 PR 提交上、停在 review-* 临时分支”的说法：审查目录现在单独一条清理路径，收工即删。
- `WorktreeTask` 的 `branch` / `base` 两个平铺字段，换成 `checkout` 联合类型（新开分支 / 审查检出）。
- 审查步骤退成普通 Worker 的两条路（第 4 步删掉）：`resolveWorkspacePlan` 给找不到上游 worktree 分支的审查步骤返回 `fresh`；`hub worker start --node <审查步骤> --no-worktree` 把审查 plan 丢掉、在主文件夹里干。连带删掉只为它们留的分支：`reviewReportProblem` 在没有被审目标时跳过提交号校验，`onWorkerTurnReportIn` 在没有开审快照时跳过收尾核对。
- `validateStepBase` 的“目前只支持 main”：`base` 统一成“这一步从哪开始”，审查步骤写被审分支。
- 测试：两处依赖上面那两条路的老测试改掉：`task-graph-auto-dispatch.test.ts` 里审查步骤先 `--no-worktree` 派活的那一段改成断言被拒；`task-graph-waiting-user.test.ts` 里没建审查目录就汇报 PASS 的两处改成先建审查目录、写真实的验证提交、跑收尾核对。
- 测试：`task-graph-auto-dispatch.test.ts` 里“独立审查并直接修”那一步（审查在实现分支上提交 `review fix`）改成普通的同线步骤；两处审查步骤换人断言“接手实现的 worktree”改成断言新开审查目录。

