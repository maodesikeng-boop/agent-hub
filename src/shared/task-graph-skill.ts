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
  `Fusa 任务图手册。要用 ${HUB} graph 建图或改图、给图里的节点派 Worker 或换人、挂门禁让用户拍板、加审查节点之前，先加载。一段就能做完的活不建图，不用加载。`;

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
用 \`${HUB} graph create\` 把这件事排成一串节点，然后给轮到的节点派 Worker（\`${HUB} worker start --node <节点>\`）。
- **一张图只装一件事**：互不相干的几件事各建一张图。
- **按先后步骤拆，不按模块拆**：不要把一个需求切成前端、后端各一个 Worker。写测试、改代码、截图、提 PR 是同一步，一个 Worker 一口气做完。只在三种时候另起一个节点：用户明说要先看、要换一个模型独立审查、一步的上下文装不下。
- **默认一条线**：用 \`deps\` 把节点按先后串起来，前一个完成后一个才轮到。互不依赖的活才并行（比如同时探索几个方向再汇总）。
- **用户明说要先看的地方**（比如“先给我看方案”）挂一个 \`gate\` 节点：轮到时用 \`${HUB} graph ask\` 填上问题、选项和你的推荐，用户点了才往下走。别的拍板不预先挂门禁，撞上了用 \`${HUB} ask\` 问。
- **碰到下面任意一条，就在实现后面加一个审查节点**（派给另一家厂商的 Worker，任务说明里写清实现的分支和 PR、你最担心的地方，发现问题让它直接修）：
${PM_REVIEW_REDLINES.map((line) => `  - ${line}`).join("\n")}

  纯文案、纯展示、局部纯函数、薄胶水层不用审查，靠测试和截图兜底。

## 跟进
进度以 \`${HUB} graph show\` 为准。
- **节点的 Worker 做完了**：验收通过就 \`${HUB} worker end <编号>\` 收工，节点自动标完成，后面的节点轮到。给下一个节点派 Worker 时，任务说明里给上一步的分支、PR 和文件路径，让它自己去读，不要转述内容。
- **换人**（出错、额度用完、对话太长、该换一家）：直接 \`${HUB} worker start --node <节点> [--vendor …]\`。节点上还挂着的旧 Worker 自动按“没做完”收工；新 Worker 接着用前任的工作目录和分支，第一条消息自动带最近 ${TAKEOVER_PREDECESSORS_MAX} 个前任的汇报、最后的文字、最后几步操作和原始记录路径。正文可以不写，写了就是你的补充。
- **计划变了**：随时 \`${HUB} graph patch\`，加节点、改还没开工的节点、跳过不需要的。原本没建图、做着发现要分段或加审查的，随时补建一张图。
- **全部节点完成后图不会自动结束**：最后一个节点完成时图保持待交付，你会收到交付单（各节点结果和改动文件名单）。改动碰了上面的红线而图里没有审查节点，或证据不够，仍可 \`${HUB} graph patch\` 补节点或打回重做；验收合并后用 \`${HUB} graph finish\` 结束整张图（交付摘要自动同步给总助）。

## 命令
\`<节点>\` 是节点的 key，它在几张活跃的图里重名时加 \`--graph <图编号>\`。
- \`${HUB} graph create [--title <标题>] --stdin\`：建图，正文 JSON 形如 \`${TASK_GRAPH_CREATE_JSON_HINT}\`（\`kind\` 不写是 \`piece\`，要用户拍板的写 \`gate\`；\`deps\` 写前置节点的 key，不写就是一开始就轮到）
- \`${HUB} graph show [<图编号>]\` / \`${HUB} graph list [--all | --status active|completed|cancelled]\`：看一张图的进度和每个节点的结果（分支、PR、摘要、定案）/ 列出任务图
- \`${HUB} graph patch [<图编号>] --stdin\`：改图，正文 JSON 按需取 \`${TASK_GRAPH_PATCH_JSON_HINT}\`；已经结束的图不能改
- \`${HUB} graph done <节点> [--pr <URL>] [--commit <SHA>] [--branch <分支>] [--summary <摘要> | --stdin]\`：把没有 Worker 在干的节点标完成（比如你自己做完的），或给节点补记 PR 等结果（图已结束时加 \`--graph <图编号>\`）；有 Worker 在干的会被拒绝，先让它收工
- \`${HUB} graph skip <节点> [--reason <原因>]\` / \`${HUB} graph cancel [<图编号>] [--reason <原因>]\`：跳过一个节点（只跳过它自己，下游照常解锁）/ 取消整张图
- \`${HUB} graph finish [<图编号>] [--unmerged-ok] --stdin\`：所有节点完成后结束这张图，正文是交付摘要（自动同步给总助）；分支上有未合并的 PR 时默认拦下提醒，确认不合并加 \`--unmerged-ok\`
- \`${HUB} graph ask <节点> [--question <问题>] [--option <选项>...] [--recommended <选项>] [--stdin]\`：给轮到的 \`gate\` 节点填上问题、选项和推荐，交给用户拍板；正文是给用户看的背景摘要
- \`${HUB} graph decide <节点> --choice <选项> [--note <说明>]\`：用户没点选项、在聊天里口头答复时，用它记下来
- \`${HUB} worker start --node <节点> …\`：把 Worker 绑到图里轮到的节点上，其余参数和不带 \`--node\` 时一样；节点上已经有经手过的 Worker 时就是换人，\`--title\` 和正文都可以不给
- \`${HUB} worker end <编号> [--incomplete]\`：它最近一轮汇报是“做完了”时，绑定的节点自动标完成；否则节点等人接手。加 \`--incomplete\`：不管它汇报了什么，节点都等人接手
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
