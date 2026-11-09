## what is agent-hub

给用户自己用的多 agent 系统：Router（总助）+ 每个项目一个项目经理 + Worker，每个角色可以选不同公司的 agent。先在这台 Mac 上试。

完整背景、已经定下的设计和下一步都在主文件夹的 `HANDOVER.md`，项目经理开工前先读。它被 gitignore 了，Worker 的 worktree 里没有，Worker 不用找，背景看任务说明。

## 规矩
- 开发过程中任何软件工程的工具，脚本，优先用行业推荐的
- 所有组件,代码,方案，优先看行业成熟方案，直接用标准的组件，非必要不要自己手搓
- 查问题找根源，不要打补丁
- 用中文跟用户交流。
- 设计或进度有变化，项目经理同步更新 `HANDOVER.md`。
- 代码要有合理的结构：重要的部分放一起，方便以后改。比如可调的数、提示词、`claude` 的启动参数，各自集中在一处。
- 优先用成熟的第三方库，不要自己手搓基础轮子（比如前端状态订阅用 `zustand`、按需拉取与分页缓存用 `@tanstack/react-query`、UI 原语用 `shadcn/ui` 等），不要为了追求“零依赖”手写复杂的状态机、缓存淘汰或分页拼接。
- 界面按 `docs/ui-standard.md`：间距、圆角、字号、颜色、控件尺寸、聚焦态、对齐都照它；标准没覆盖的先补进标准再改界面。
- GitHub 操作一律用 `GH_TOKEN="$(gh auth token --user maodesikeng-boop)" gh ...`（本机 gh 默认账号不是仓库协作者）。
- Mac 测试在本机跑（`pnpm typecheck`、本次改到的相关测试文件及涉及沙箱时的 `src/shared/write-scope.test.ts`），云端 CI 只跑 Ubuntu（4 路并行分片）。
- 写或审缓存、状态快照、会随时间变多的列表，必查 4 件事（守卫测试见 `src/web/selectors-cache.test.ts`、`src/daemon/store/db-cache.test.ts`、`src/web/sw-rules-cache.test.ts`）：
  1. 失效：底层文件、配置、数据变了要能感知；退出、删除要清掉；失败或空结果只短暂记（像 `FETCHED_QUOTA_RETRY_MS`），不当正常结果缓存几分钟到几小时。
  2. 上限：按跑了一个月（300 个已收工 Worker、3 万条消息、5 万步日志）算，内存里的 Map/数组、单次接口响应、给 agent 的命令输出都要有上限（数写进 `src/shared/limits.ts`），大响应要压缩。
  3. 前端引用稳定：selector、hook 输入没变就返回同一个引用（`WeakMap` 按输入对象缓存），不让 `memo` 的子组件每次都重画。
  4. 验证：用 pstack 的 `perf-issue`、`benchmark-checklist`、`blast-radius` 量出改前改后的数字，写进 PR。
- rule a:你不做事，只汇报，拆任务，派任务。 派的模型思考程度你根据任务难度来决定(除非你直接回答，做事效率更高，或者用户意图是让你回答，用户的意图永远是优先的)。耗时短、花 token 少、需要及时反馈的任务自己做；相反（耗时久、花 token 多、不需要当场秒回的）给 Worker 做。
- 整体工作流程 先讲清楚边界，tdd，测试，提pr，判断要不要审查
    -需要 审查，修改，回到判断要不要审查
    -不需要 合pr
    这是整体工作流程，你需要在rule a的规矩下完成，不同的功能，代码分别完成，整体分工你来规划，总效率达到最高


## pstack 技能（只本项目）

- 原版 pstack（backnotprop/pstack，MIT）@ `f104aa8`（2026-11-07 取的 main）的 `skills/` 原样放在 `.agents/skills/`，许可证在 `.agents/skills/PSTACK-LICENSE`。
- 三家共用这一份：codex 和 agy 读 `<仓库>/.agents/skills/`；claude 读 `.claude/skills`，它是指向 `../.agents/skills` 的软链接。不写任何用户目录。
- agy 里这些技能只能手打 `/技能名` 用（原版设了 disable-model-invocation，agy 不把它们列进模型的技能清单）。
- 更新：重新 clone 原版，把 `skills/` 覆盖到 `.agents/skills/`（保留 `PSTACK-LICENSE`），在这里改提交号，提 PR。
