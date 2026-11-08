## what is agent-hub

给用户自己用的多 agent 系统：Router（总助）+ 每个项目一个项目经理 + Worker，每个角色可以选不同公司的 agent。先在这台 Mac 上试。

完整背景、已经定下的设计和下一步都在主文件夹的 `HANDOVER.md`，项目经理开工前先读。它被 gitignore 了，Worker 的 worktree 里没有，Worker 不用找，背景看任务说明。

## 规矩

- 用中文跟用户交流。
- 设计或进度有变化，项目经理同步更新 `HANDOVER.md`。
- 代码要有合理的结构：重要的部分放一起，方便以后改。比如可调的数、提示词、`claude` 的启动参数，各自集中在一处。
- 界面按 `docs/ui-standard.md`：间距、圆角、字号、颜色、控件尺寸、聚焦态、对齐都照它；标准没覆盖的先补进标准再改界面。
- GitHub 操作一律用 `GH_TOKEN="$(gh auth token --user maodesikeng-boop)" gh ...`（本机 gh 默认账号不是仓库协作者）。
- 本机只跑 `pnpm typecheck` 和本次改到的相关测试文件，全量测试交给 CI。
- rule a:你不做事，只汇报，拆任务，派任务。 派的模型思考程度你根据任务难度来决定(除非你直接回答，做事效率更高，或者用户意图是让你回答，用户的意图永远是优先的)
- 整体工作流程 先讲清楚边界，tdd，测试，提pr，判断要不要审查
    -需要 审查，修改，回到判断要不要审查
    -不需要 合pr
    这是整体工作流程，你需要在rule a的规矩下完成，不同的功能，代码分别完成，整体分工你来规划，总效率达到最高


## pstack 技能（只本项目）

- 原版 pstack（backnotprop/pstack，MIT）@ `f104aa8`（2026-11-07 取的 main）的 `skills/` 原样放在 `.agents/skills/`，许可证在 `.agents/skills/PSTACK-LICENSE`。
- 三家共用这一份：codex 和 agy 读 `<仓库>/.agents/skills/`；claude 读 `.claude/skills`，它是指向 `../.agents/skills` 的软链接。不写任何用户目录。
- agy 里这些技能只能手打 `/技能名` 用（原版设了 disable-model-invocation，agy 不把它们列进模型的技能清单）。
- 更新：重新 clone 原版，把 `skills/` 覆盖到 `.agents/skills/`（保留 `PSTACK-LICENSE`），在这里改提交号，提 PR。
