// 产品自带的任务图技能 fusa-task-graph（docs/orchestration-skill-design.md 第 5、6 节）：建图手册和全部 hub graph 命令，
// 只在项目经理要建图时按需加载，不常驻提示词。正文只有这一处：
// - 守护进程每次起项目经理会话时写成 launch/<会话>/skills/fusa-task-graph/SKILL.md（daemon/task-graph-skill.ts），六家的原生入口
//   和“按路径读文件”兜底都指向这一个文件；
// - hub help graph 打印同一份正文（hub/cli.ts），读不到文件时还有这条路；
// - 基础提示词（daemon/prompt.ts）里只留三档判断、一句四类审查红线和指路的那句话。
// 前后端都能引（不用 node:path）；cli.ts 也引它，所以只引 names.ts、hub.ts、limits.ts。
import { TASK_GRAPH_CREATE_JSON_HINT, TASK_GRAPH_PATCH_JSON_HINT } from "./hub.ts";
import { TAKEOVER_PREDECESSORS_MAX } from "./limits.ts";
import { HUB_COMMAND as HUB, PRODUCT_PLUGIN_NAME } from "./names.ts";

/** 技能名（目录名、frontmatter 的 name 都是它）。带 fusa 和 task-graph：本机已有别家的 orchestration 技能，撞名会加载错手册。 */
export const TASK_GRAPH_SKILL_NAME = "fusa-task-graph";

/**
 * 仅供项目经理模型后台按需加载的内部技能命令名（裸名、claude 插件前缀 `fusa:fusa-task-graph`、pi 前缀 `skill:fusa-task-graph`）：
 * 网页 `/` 斜杠命令弹窗过滤隐藏，不影响模型自身的原生技能清单加载。
 */
const INTERNAL_SKILL_COMMAND_NAMES: ReadonlySet<string> = new Set([
  TASK_GRAPH_SKILL_NAME,
  `${PRODUCT_PLUGIN_NAME}:${TASK_GRAPH_SKILL_NAME}`,
  `skill:${TASK_GRAPH_SKILL_NAME}`,
]);

export function isInternalSkillCommand(name: string): boolean {
  return INTERNAL_SKILL_COMMAND_NAMES.has(name.trim().replace(/^[/\$]+/u, "").toLowerCase());
}

/** 技能的说明：各家靠它决定要不要加载，先写什么时候加载，再写什么时候不用（上限 TASK_GRAPH_SKILL_DESCRIPTION_MAX_CHARS）。 */
export const TASK_GRAPH_SKILL_DESCRIPTION =
  `Fusa 任务图手册。要用 ${HUB} graph 建图或改图、排自动交棒步骤、加独立审查步骤、处理偏离或换人接手、挂拍板卡之前，先加载。一段就能做完的活不建图，不用加载。`;

/**
 * 四类审查红线：碰到任意一条就在实现后面加审查节点。完整的在技能正文里；基础提示词第 2 步只用 PM_REVIEW_REDLINES_BRIEF 那一句压缩版
 * （定档时要看得到：碰了红线就是两段，走建图）。
 */
export const PM_REVIEW_REDLINES: readonly string[] = [
  "撤不回来的副作用或安全边界：数据迁移、覆写用户配置、杀进程、沙箱、鉴权；",
  "异步、并发、生命周期；",
  "会随时间变多的缓存、快照、分页，或多方共用的数据格式；",
  "本地草稿和远端状态互相覆盖的交互。",
];

/** 基础提示词里压缩成一句的四类红线。 */
export const PM_REVIEW_REDLINES_BRIEF =
  "撤不回来的副作用或安全边界；异步、并发、生命周期；会随时间变多的缓存、快照、分页，或多方共用的数据格式；本地草稿和远端状态互相覆盖";

/** 技能正文（不带 frontmatter）：规矩在前，命令在后（claude 压缩后只重新挂每个技能的前 5,000 个 token）。hub help graph 打印的就是它。 */
export function taskGraphSkillBody(): string {
  return `# 任务图手册

一件事有两段以上、每段各要一个独立会话时才建图。一段就能做完的活不建图，直接派一个 Worker。

## 建图
用 \`${HUB} graph create\` 一次写下整张图的 \`goal\`（总目标）和 \`steps\`（步骤数组），带 \`brief\` 的就绪步骤建好即自动开工。
- **总目标（\`goal\`）要写全**：所有步骤共用同一份 \`goal\`，写清用户原话、背景、不做什么、怎么算做完（写成能核对的证据：测试命令、截图、实测输出、PR 检查全绿）；长材料存成文件给路径。
- **一张图只装一件事**：互不相干的几件事各建一张图。
- **按先后步骤拆，不按模块拆**：不要把一个需求切成前端、后端各一个 Worker。写测试、改代码、截图、提 PR 是同一步，一个 Worker 一口气做完。只在三种时候另起一步：用户明说要先看、要换一个模型独立审查、一步的上下文装不下。
- **默认一条线，同线共用工作目录和分支**：\`steps\` 里不写 \`deps\` 默认按书写顺序串成一条线；单线上下游默认接手同一个 git worktree 和同一条分支（不用重跑准备命令，未提交改动也在，整条线共用一个 PR）。互不依赖的活才并行（写 \`deps: []\` 或前置步骤的 \`key\`）：分叉步骤默认基于上游分支新开 worktree（要从主干重开传 \`"base": "main"\`）；多路合流时后台自动拼接各路交棒（总上限 12,000 字均分、单路最多 4,000 字，超长完整汇报自动落盘到启动目录 \`upstream/<stepKey>.md\` 并附路径）。
- **每步自带职责与模型配置**：每步写 \`key\`、\`title\`、\`brief\`（一两句本步职责；上一步的交棒后台会自动原样转交，不用你手抄），按需配 \`vendor\`、\`model\`、\`effort\`、\`readonly\`、\`maxTime\`（单轮上限，如 \`"45m"\`，默认 \`30m\`）、\`confirm: true\`、\`review: true\`、\`base: "main"\`。
- **用户明说要先看的步骤**（比如“先给我看方案”“改完先让我看效果”）：给这一步标 \`"confirm": true\`（照常写 \`brief\` 自动开工）。它的 Worker 汇报“做完了”且无偏离时，后台不会立刻收工或标完成，而是在对话、右栏和总助自动挂出「通过 / 打回」检查点拍板卡（展示本轮摘要与交棒），全程不叫醒你：用户点「通过」（可附意见）后自动收工并把定案与意见随交棒带给下一步；点「打回」则把修改意见直接发给原 Worker 在原会话接着改，改完再出卡。别的拍板不要预先建空步骤，等干活的 Worker 撞上了再用 \`${HUB} ask --node <步骤>\` 挂卡。
- **碰到下面任意一条，就在实现后面加一个审查步骤**（设 \`"review": true\` 并指定另一家 \`vendor\`，后台自动前置内置独立审查清单，接手实现的分支直接修；\`brief\` 里点名你最担心的地方）：
${PM_REVIEW_REDLINES.map((line) => `  - ${line}`).join("\n")}

  纯文案、纯展示、局部纯函数、薄胶水层不用审查，靠测试和截图兜底。

## 跟进
进度以 \`${HUB} graph show\` 为准。步骤只有四个状态：没轮到（\`pending\`）、在干（\`running\`）、等人（\`waiting\`，等你处理或等用户拍板）、完了（\`done\`，跳过也算完了）。
- **顺利完成自动收工交棒，不叫醒你**：非检查点步骤的 Worker 汇报“做完了”且“偏离”为“无”时，后台自动收工该 Worker、记下分支/提交/PR/摘要，并带着 \`goal\`、下一步 \`brief\` 与上一步“交棒”自动拉起下游步骤（若“问题”栏留了话，交棒照走同时把汇报抄送给你；需要用户定的可把卡挂在下游步骤上 \`${HUB} ask --node <下游步骤>\`）。
- **报“偏离”或异常停在 \`waiting\` 等你处理**：Worker 汇报写了“偏离”、状态是“有问题”或“放弃了”、没按格式、崩溃/额度用完，或自动拉起时目标厂商不可用、手动步骤没写 \`brief\`，步骤都会停在 \`waiting\` 并叫醒你：
  - 回答问题或不认可偏离打回重做：\`${HUB} worker send <编号> --stdin\`；
  - 要用户拍板的事：用 \`${HUB} ask --node <步骤> [--option <选项>...] [--recommended <选项>] --stdin\` 把拍板卡挂在该步骤上（对话、右栏、总助三处同步出现）；用户点完后定案与意见直接发给该步未收工的 Worker 接着干（步骤切回 \`running\`），全程不叫醒你，定案记在步骤上。用户若在聊天里口头答复，用 \`${HUB} graph decide <步骤> --choice <选项> [--note <说明>]\` 记下，效果相同；
  - 认可偏离或你已手动完成：\`${HUB} graph done <步骤> [--stdin]\` 放行（正文作为补充转交给下一步）；
  - **换人接手**（出错、额度用完、对话太长、厂商不可用或该换一家）：直接 \`${HUB} worker start --node <步骤> [--vendor …] [--model …] [--effort …] [--stdin]\`。还挂着的旧 Worker 自动收工且步骤不标完成；新 Worker 自动继承职责、审查清单、上游交棒、前任的工作目录与分支，以及最近 ${TAKEOVER_PREDECESSORS_MAX} 个前任的汇报、最后的文字、最后几步操作和原始记录路径，并把新的厂商/模型写回步骤。
- **计划变了**：随时 \`${HUB} graph patch\`（用 \`addSteps\`、\`updateSteps\`、\`removeSteps\`、\`skipSteps\` 或更新 \`goal\`；在干或已完成的步骤不能直接 \`updateSteps\`）。原本没建图、做着发现要分段或加审查的，随时补建一张图。
- **全部步骤完成后待交付**：最后一步完成时图不会自动结束，你会收到交付单（各步结果、改动文件名单与最后一步交棒）。若缺审查或证据不够，仍可 \`${HUB} graph patch\` 补步骤或打回重做；核对证据并按项目规矩合并后，用 \`${HUB} graph finish\` 收尾（交付摘要自动同步给总助）。

## 命令
\`<步骤>\` 是步骤的 key，它在几张活跃的图里重名时加 \`--graph <图编号>\`。
- \`${HUB} graph create [--title <标题>] --stdin\`：建图并自动拉起就绪步骤，正文 JSON 形如 \`${TASK_GRAPH_CREATE_JSON_HINT}\`（\`steps\` 不写 \`deps\` 默认串成一条线，并行写 \`deps: []\` 或前置 key；用户明说要先看的步骤加 \`"confirm": true\`）
- \`${HUB} graph show [<图编号>]\` / \`${HUB} graph list [--all | --status active|completed|cancelled]\`：看一张图的进度和每步的结果（分支、提交、PR、摘要、定案）/ 列出任务图
- \`${HUB} graph patch [<图编号>] --stdin\`：改图，正文 JSON 按需取 \`${TASK_GRAPH_PATCH_JSON_HINT}\`；在干或已完成的步骤不能改，已结束的图不能改
- \`${HUB} graph done <步骤> [--pr <URL>] [--commit <SHA>] [--branch <分支>] [--summary <摘要>] [--stdin]\`：放行在等你的步骤（正文是你补给下一步的话），或补记 PR 等结果；有 Worker 在干的步骤会被拒绝，先 \`${HUB} worker end\` 停掉它
- \`${HUB} graph skip <步骤> [--reason <原因>]\` / \`${HUB} graph cancel [<图编号>] [--reason <原因>]\`：跳过一步（不连带跳过下游，下游追溯最近未跳过上游的交棒与目录）/ 取消整张图（自动停掉图里所有在跑的 Worker）
- \`${HUB} graph finish [<图编号>] [--unmerged-ok] --stdin\`：所有步骤完成后结束这张图，正文是交付摘要（自动同步给总助）；分支上有未合并的 PR 时默认拦下提醒，确认不合并加 \`--unmerged-ok\`
- \`${HUB} ask --node <步骤> [--option <选项>...] [--recommended <选项>] --stdin\`：在任意未完步骤上挂拍板卡（对话、右栏、总助三处同步提醒），正文是问题与背景摘要；用户点完后定案直接交给该步挂着的 Worker 接着干（无活跃 Worker 的手动步骤则标完了推进下游），全程不叫醒你
- \`${HUB} graph decide <步骤> --choice <选项> [--note <说明>]\`：用户没点选项、在聊天里口头答复时记下定案；该步挂着未收工 Worker 时同样直接发给它接着干，否则推进下游
- \`${HUB} worker start --node <步骤> …\`：给等你处理的步骤换人或手动派人（\`--title\` 和正文都可省略，正文作为补充说明）
- \`${HUB} worker end <编号>\`：只停掉这个 Worker，不会把步骤标完成；未完成的步骤会停在 \`waiting\` 等你处理（顺利完成的步骤由后台自动收工）
`;
}

/** SKILL.md 全文（Agent Skills 规范：frontmatter 的 name 和目录名一致）。六家用的是同一个文件、同一份内容。 */
export function taskGraphSkillMarkdown(): string {
  return `---
name: ${TASK_GRAPH_SKILL_NAME}
description: ${TASK_GRAPH_SKILL_DESCRIPTION}
---

${taskGraphSkillBody()}`;
}

/** 启动指纹里算的那一段：名字和说明（厂商在会话开头读进技能清单，改了要重启才生效；正文是加载时现读的，改了不用重启）。 */
export function taskGraphSkillCatalogEntry(): string {
  return `${TASK_GRAPH_SKILL_NAME}\n${TASK_GRAPH_SKILL_DESCRIPTION}`;
}
