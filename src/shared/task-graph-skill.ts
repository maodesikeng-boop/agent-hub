import { ASK_CARD_WHERE, TASK_GRAPH_CREATE_JSON_HINT, TASK_GRAPH_PATCH_JSON_HINT } from "./hub.ts";
import { HANDOFF_NOTE_MAX_CHARS, HANDOFF_TOTAL_MAX_CHARS, TAKEOVER_PREDECESSORS_MAX } from "./limits.ts";
import { HUB_COMMAND as HUB } from "./names.ts";
import { skillNameOf } from "./skill-names.ts";
import { formatGraphLimitsHelp } from "./hub-limits.ts";

export const TASK_GRAPH_SKILL_NAME = "fusa-task-graph";

export function isInternalSkillCommand(name: string): boolean {
  return skillNameOf(name.trim().replace(/^[/$]+/u, ""))?.toLowerCase() === TASK_GRAPH_SKILL_NAME;
}

export const TASK_GRAPH_SKILL_DESCRIPTION =
  `Bellwood 任务图手册。要用 ${HUB} graph 建图或改图、排自动交棒步骤、加独立审查步骤、处理偏离或换人接手、挂拍板卡之前，先加载。一段就能做完的活不建图，不用加载。`;

export function taskGraphSkillBody(): string {
  return `# 任务图手册

一件事有两段以上、每段各要一个独立会话时才建图。一段就能做完的活不建图，直接派一个 Worker。

## 建图
用 \`${HUB} graph create\` 一次写下整张图的 \`goal\`（总目标）和 \`steps\`（步骤数组），带 \`brief\` 的就绪步骤建好即自动开工。
- **总目标（\`goal\`）要写全**：所有步骤共用同一份 \`goal\`，写清用户原话、背景、不做什么、怎么算做完（写成能核对的证据：按项目自己的验证方式写清要核对的测试、截图、实测输出或云端检查；要用户看的方案、验收结论、截图、录屏写进汇报的“文件”栏，会跟着步骤挂到检查点卡和总助上）；长材料存成文件给路径。
- **一张图只装一件事**：互不相干的几件事各建一张图。
- **按先后步骤拆，不按模块拆**：不要把一个需求切成前端、后端各一个 Worker。写测试、改代码、截图（项目要提 PR 的连同提 PR）是同一步，一个 Worker 一口气做完。只在三种时候另起一步：用户明说要先看、要换一个模型独立审查、一步的上下文装不下。
- **默认一条线，同线共用工作目录和分支**：\`steps\` 里不写 \`deps\` 默认按书写顺序串成一条线；单线上下游默认接手同一个 git worktree 和同一条分支（不用重跑准备命令，未提交改动也在；要提 PR 的整条线共用一个）。互不依赖的活才并行（写 \`deps: []\` 或前置步骤的 \`key\`）：分叉步骤默认基于上游分支新开 worktree（要从主干重开传 \`"base": "main"\`）；多路合流时后台自动拼接各路交棒（总上限 ${HANDOFF_TOTAL_MAX_CHARS.toLocaleString("en-US")} 字均分、单路最多 ${HANDOFF_NOTE_MAX_CHARS.toLocaleString("en-US")} 字，超长完整汇报自动落盘到启动目录 \`upstream/<stepKey>.md\` 并附路径）。
- **每步自带职责与模型配置**：每步写 \`key\`、\`title\`、\`brief\`（一两句本步职责；上一步的交棒后台会自动原样转交，不用你手抄），按需配 \`vendor\`、\`model\`、\`effort\`、\`readonly\`、\`caps\`（外接能力：\`"inherit"\` 默认照项目设置，\`"none"\` 一个不带，\`"custom"\` 配 \`allow: ["mcp:<名>", "skill:<名>"]\` 只挂点名的；patch 时 \`caps: null\` 恢复默认）、\`maxTime\`（单轮上限，如 \`"45m"\`，默认 \`30m\`）、\`confirm: true\`、\`review: true\`、\`base\`（普通步骤只能写 \`"main"\`，从主干重开；审查步骤写被审分支）。
- **本机同时只能跑一个的步骤**（如独占端口、设备）：写同一个 \`"slot": "<名额>"\`（小写字母、数字、-）。同名名额本机所有项目同时只放一步，其余排队，\`${HUB} graph show\` 写明第几位、前面是谁；占着的步骤停下且没有后台命令时，排第一的自动开工。
- **下一步开始前要审的结果**（比如方案或用户要求先看的效果）：给产出它的步骤标 \`"confirm": true\`，把之后的步骤也一并建好。Worker 汇报“做完了”且无偏离时，系统把汇报和文件交给你，Worker 原会话保留。通过用 \`${HUB} graph done <步骤>\`，打回用 \`${HUB} worker send <编号> --stdin\`。确实需要用户决定时，再用 \`${HUB} ask --node <步骤>\`，卡片默认提供「通过 / 打回」，并带上本步的交付物。用户通过后自动收工并推进下游；没有下游时通知你。打回意见直接发给原 Worker，改完再次交你审。
- **需要独立审查时，在实现后面加一个审查步骤**（设 \`"review": true\`，需要跨模型审查的指定另一家 \`vendor\`；后台自动前置独立审查说明，\`brief\` 里写明重点关注的区域或复审要点）：
  审查只查不修，由代码保证：审查 Worker 在 detached 检出的独立目录里干活，推不上去，也不能 \`--no-worktree\`。审查和修复开工时自动对齐最新提交，不用在 \`brief\` 里写检出命令。被审分支默认是唯一上一步的分支；单步审查图、多路合流后的审查、上一步在主文件夹里干的，给审查步骤写 \`"base": "<被审分支>"\`，否则报错。结论只有 PASS 和 FAIL，并写明验证提交号。判 PASS 后后台核对被审分支、远端和 PR 在审查期间没被动过才放行；判 FAIL 步骤停在 \`waiting\` 等你处理（加修复步骤接手实现的目录和分支，修完再加复审）。
  审查步骤要审 git 分支；项目不是 git 仓库的，改加一个只读（\`"readonly": true\`）的普通步骤，在 \`brief\` 里写明审查要求。什么时候需要审查、怎么判定严重程度，按项目自身的规矩或用户要求来。

## 跟进
进度以 \`${HUB} graph show\` 为准。步骤只有四个状态：没轮到（\`pending\`）、在干（\`running\`）、等人（\`waiting\`，等你处理或等用户拍板）、完了（\`done\`，跳过也算完了）。
- **顺利完成自动收工交棒，不叫醒你**：非检查点步骤的 Worker 汇报“做完了”且“偏离”为“无”时，后台自动收工该 Worker、记下分支/提交/PR/摘要，并带着 \`goal\`、下一步 \`brief\` 与上一步“交棒”自动拉起下游步骤（若“问题”栏留了话，交棒照走同时把汇报抄送给你；需要用户定的可把卡挂在下游步骤上 \`${HUB} ask --node <下游步骤>\`）。
- **报“偏离”或异常停在 \`waiting\` 等你处理**：Worker 汇报写了“偏离”、状态是“有问题”或“放弃了”、没按格式、崩溃/额度用完，或自动拉起时目标厂商不可用、手动步骤没写 \`brief\`，步骤都会停在 \`waiting\` 并叫醒你：
  - 回答问题或不认可偏离打回重做：\`${HUB} worker send <编号> --stdin\`；
  - 你决定不了、要用户拍板的事：用 \`${HUB} ask --node <步骤> [--option <选项>...] [--recommended <选项>] [--file [标签=]路径...] --stdin\` 把拍板卡挂在该步骤上（${ASK_CARD_WHERE}）；普通步骤的定案与意见直接发给未收工的 Worker；检查点按上面的通过和打回规则处理。定案记在步骤上。用户若在聊天里口头答复，用 \`${HUB} graph decide <步骤> --choice <选项> [--note <说明>]\` 记下，效果相同；
  - 认可偏离或你已手动完成：\`${HUB} graph done <步骤> [--stdin]\` 放行（正文作为补充转交给下一步）；
  - **换人接手**（出错、额度用完、对话太长、厂商不可用或该换一家）：直接 \`${HUB} worker start --node <步骤> [--vendor …] [--model …] [--effort …] [--stdin]\`。还挂着的旧 Worker 自动收工且步骤不标完成；新 Worker 自动继承职责、审查清单、上游交棒、前任的工作目录与分支，以及最近 ${TAKEOVER_PREDECESSORS_MAX} 个前任的汇报、最后的文字、最后几步操作和原始记录路径，并把新的厂商/模型写回步骤。
- 若步骤明确需要 Computer Use，且厂商和系统支持，可在步骤设置 \`noOuterSandbox: true\`，同时用 \`caps: "custom"\` 和 \`allow\` 明确挂载该能力。Worker 等用户在工作台确认后才开工。Computer Use 控制每个应用前都要等用户在工作台确认；用户拒绝时，换个办法或汇报。
- **计划变了**：随时 \`${HUB} graph patch\`（用 \`addSteps\`、\`updateSteps\`、\`removeSteps\`、\`skipSteps\`、\`doneSteps\` 或更新 \`goal\`；在干或已完成的步骤不能直接 \`updateSteps\`）。原本没建图、做着发现要分段或加审查的，随时补建一张图。
- **交付在图的最后一行**：图里画的步骤都做完时，你会收到交付单（各步结果、改动文件名单与最后一步交棒）。图只知道画进去的步骤，缺审查或证据仍可用 \`${HUB} graph patch\` 补步骤。按项目约定验收交付后，用 \`${HUB} graph finish\` 收尾（交付摘要自动同步给总助）。若交付本身需要独立处理，也可以画一个没有 \`brief\` 的最后步骤。
- 图在需要你处理、需要用户动手、用户拍板后没有下游可接，或图里画的步骤全做完时，才叫你回来；顺利交棒后的进展在 \`${HUB} status\` 看。

## 命令
\`<步骤>\` 是步骤的 key，它在几张活跃的图里重名时加 \`--graph <图编号>\`。
- \`${HUB} graph create [--title <标题>] --stdin\`：建图并自动拉起就绪步骤，正文 JSON 形如 \`${TASK_GRAPH_CREATE_JSON_HINT}\`（\`steps\` 不写 \`deps\` 默认串成一条线，并行写 \`deps: []\` 或前置 key；需要审结果后再推进的步骤加 \`"confirm": true\`）
- ${formatGraphLimitsHelp()}。
- \`${HUB} graph show [<图编号>]\` / \`${HUB} graph list [--all | --status active|completed|cancelled]\`：看一张图的进度和每步的结果（分支、提交、PR、摘要、定案）/ 列出任务图
- \`${HUB} graph patch [<图编号>] --stdin\`：改图，正文 JSON 按需取 \`${TASK_GRAPH_PATCH_JSON_HINT}\`；\`doneSteps\` 可在同一次改图里放行等你处理的步骤；在干或已完成的步骤不能改，已结束的图不能改
- \`${HUB} graph done <步骤> [--pr <URL>] [--commit <SHA>] [--branch <分支>] [--summary <摘要>] [--stdin]\`：放行在等你的步骤（正文是你补给下一步的话），或补记 PR 等结果；有 Worker 在干的步骤会被拒绝，先 \`${HUB} worker end\` 停掉它
- \`${HUB} graph skip <步骤> [--reason <原因>]\` / \`${HUB} graph cancel [<图编号>] [--reason <原因>]\`：跳过一步（不连带跳过下游，下游追溯最近未跳过上游的交棒与目录）/ 取消整张图（自动停掉图里所有在跑的 Worker）
- \`${HUB} graph finish [<图编号>] [--unmerged-ok] --stdin\`：所有步骤完成后结束这张图，正文是交付摘要（自动同步给总助）；分支上有未合并的 PR 时默认拦下提醒，确认不合并加 \`--unmerged-ok\`
- \`${HUB} ask --node <步骤> [--option <选项>...] [--recommended <选项>] [--file [标签=]路径...] --stdin\`：在任意未完步骤上挂拍板卡（${ASK_CARD_WHERE}），正文是问题与背景摘要，要用户看的文件用 \`--file\` 挂在卡片下面并记进该步的交付物；普通步骤的定案直接交给挂着的 Worker；没有活跃 Worker 时标完并推进下游。检查点按上面的通过和打回规则处理
- \`${HUB} graph decide <步骤> --choice <选项> [--note <说明>]\`：记下用户在聊天里的口头答复。已有用户拍板卡的检查点按通过或打回处理；还在等你审的检查点用 \`${HUB} graph done\` 放行或 \`${HUB} worker send\` 打回。普通步骤有未收工 Worker 时，定案直接发给它
- 步骤拍板卡会一直等用户答复，给 Worker 续发消息、收汇报或改步骤状态都不会关掉它。要撤回过时的卡，用 \`${HUB} ask close --message <消息编号>\`，编号见 \`${HUB} graph show\`；再次在同一步挂卡会替换旧卡。
- \`${HUB} worker start --node <步骤> …\`：给等你处理的步骤换人或手动派人（\`--title\` 和正文都可省略，正文作为补充说明）；名额被占时只排队不开工
- \`${HUB} worker end <编号>\`：只停掉这个 Worker，不会把步骤标完成；未完成的步骤会停在 \`waiting\` 等你处理（顺利完成的步骤由后台自动收工）
`;
}

export function taskGraphSkillMarkdown(): string {
  return `---
name: ${TASK_GRAPH_SKILL_NAME}
description: ${TASK_GRAPH_SKILL_DESCRIPTION}
---

${taskGraphSkillBody()}`;
}

export function taskGraphSkillCatalogEntry(): string {
  return `${TASK_GRAPH_SKILL_NAME}\n${TASK_GRAPH_SKILL_DESCRIPTION}`;
}
