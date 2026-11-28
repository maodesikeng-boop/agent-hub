// Invariant: every hub CLI command (HUB_COMMANDS, self-reload, and dispatch) has one metadata entry in HUB_CLI_REGISTRY,
// and progressive help, scoped usage, and CLI diagnostic suggestions derive from this registry only.

import { PM_MODES, type AgentRole } from "../shared/domain.ts";
import { HUB_CHECKLIST_USAGE } from "../shared/hub-checklist.ts";
import {
  ASK_CARD_WHERE,
  ENV_HUB_SOCK,
  ENV_HUB_TOKEN,
  HUB_COMMANDS,
  HUB_COMMAND_ROLES,
  HUB_HELP_ONLY_COMMANDS,
  POWERSHELL_UTF8_PIPE,
  STDIN_SHELL_NOTE,
  TASK_GRAPH_CREATE_JSON_HINT,
  TASK_GRAPH_PATCH_JSON_HINT,
  type HubCommand,
} from "../shared/hub.ts";
import { hubLimitMaximum, hubLimitsHelpLine } from "../shared/hub-limits.ts";
import {
  ASK_MIN_OPTIONS,
  ENV_SETUP_ROOT_PATH,
  ENV_SETUP_WORKTREE_PATH,
  HUB_ERROR_SUGGESTIONS_MAX,
  MIN_SCHEDULE_EVERY_MINUTES,
  SELF_RELOAD_DRAIN_MAX_MS,
  SETUP_TIMEOUT_MS,
  WATCH_EVERY_MIN_MS,
  WATCH_MAX_CAP_MS,
  WATCH_MAX_DEFAULT_MS,
  WORKER_LOG_DEFAULT_STEPS,
  WORKER_SEARCH_DEFAULT_LIMIT,
} from "../shared/limits.ts";
import { HUB_COMMAND, PRODUCT_ID } from "../shared/names.ts";
import { CAPABILITY_KINDS } from "../shared/pm-capabilities.ts";
import { formatDurationShort } from "../shared/schedule.ts";
import { TASK_GRAPH_MANUAL_SUMMARY } from "../shared/task-graph-skill.ts";
import { AGENT_VENDORS, ALL_EFFORTS } from "../shared/vendors.ts";

const hub = HUB_COMMAND;
const FILE_ARG_PATH_HINT = "标签含斜杠时，用绝对路径或以 ./ 开头的相对路径；不带标签的相对路径若含 =，可在路径前加 ./";

export type HubCommandCategory = "core" | "project" | "persona" | "worker" | "ask" | "schedule" | "watch" | "graph" | "router" | "dispatch";

export type HubCliCommandId = HubCommand | "caps" | "self.reload" | `dispatch.${string}`;

export interface HubCliEntry {
  readonly id: HubCliCommandId;
  readonly category: HubCommandCategory;
  readonly group: string;
  readonly action?: string;
  readonly cli: string;
  readonly summary: string;
  readonly usage: string;
  readonly allowedFlags: readonly string[];
  readonly minPositionals: number;
  readonly maxPositionals: number | null;
  readonly positionalHint?: string;
  readonly roles: readonly AgentRole[];
  readonly helpOnly?: boolean;
}

export type HelpResolution =
  | { kind: "index" }
  | { kind: "all" }
  | { kind: "graph-manual" }
  | { kind: "entries"; entries: readonly HubCliEntry[]; scopeLabel: string }
  | { kind: "unknown"; query: string; suggestions: readonly string[] };

const HUB_COMMAND_SET: ReadonlySet<string> = new Set(HUB_COMMANDS);
const HELP_ONLY_SET: ReadonlySet<string> = new Set(Object.keys(HUB_HELP_ONLY_COMMANDS));

export function isHubCommandId(id: HubCliCommandId): id is HubCommand {
  return HUB_COMMAND_SET.has(id);
}

function rolesFor(command: HubCommand): readonly AgentRole[] {
  return HUB_COMMAND_ROLES[command];
}

function cmdEntry(
  spec: Omit<HubCliEntry, "roles" | "helpOnly"> & { id: HubCommand },
): HubCliEntry {
  return {
    ...spec,
    roles: rolesFor(spec.id),
    ...(HELP_ONLY_SET.has(spec.id) ? { helpOnly: true } : {}),
  };
}

export const HUB_CLI_REGISTRY: readonly HubCliEntry[] = [
  cmdEntry({
    id: "status",
    category: "core",
    group: "status",
    cli: "status",
    summary: "查看身份、项目、文件夹、准备命令、活跃任务图与热重启状态",
    usage: `  ${hub} status                                              我是谁、我的项目、文件夹、worktree 准备命令和活跃的任务图`,
    allowedFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
  }),
  cmdEntry({
    id: "checklist",
    category: "core",
    group: "checklist",
    cli: "checklist",
    summary: "无专用清单工具时更新本轮进度清单",
    usage: HUB_CHECKLIST_USAGE,
    allowedFlags: [],
    minPositionals: 1,
    maxPositionals: null,
  }),
  cmdEntry({
    id: "project.create",
    category: "project",
    group: "project",
    action: "create",
    cli: "project create",
    summary: "建项目（--folder <主文件夹>）",
    usage: `  ${hub} project create --folder <主文件夹> [--name <名>] [--description <说明>]
                                                          建项目（文件夹要已经存在；一个项目经理只管一个项目）`,
    allowedFlags: ["folder", "name", "description"],
    minPositionals: 0,
    maxPositionals: 0,
  }),
  cmdEntry({
    id: "project.attach",
    category: "project",
    group: "project",
    action: "attach",
    cli: "project attach",
    summary: "给项目挂上附加文件夹",
    usage: `  ${hub} project attach <文件夹>                             给项目挂上附加文件夹`,
    allowedFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalHint: "<文件夹>",
  }),
  cmdEntry({
    id: "project.detach",
    category: "project",
    group: "project",
    action: "detach",
    cli: "project detach",
    summary: "从项目上移除附加文件夹",
    usage: `  ${hub} project detach <文件夹>                             从项目上移除附加文件夹`,
    allowedFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalHint: "<文件夹>",
  }),
  cmdEntry({
    id: "project.setup",
    category: "project",
    group: "project",
    action: "setup",
    cli: "project setup",
    summary: "设置或清除 worktree 准备命令（--stdin | --clear）",
    usage: `  ${hub} project setup --stdin | --clear                     设置（从标准输入读）或清除 worktree 准备命令：
                                                          给 Worker 建好 worktree 后先在里面跑它，跑完 Worker 再开工。
                                                          macOS、Linux 用守护进程的 $SHELL -c 跑，Windows 依次找 Git Bash、PowerShell 7、cmd；
                                                          标准输入是空的，最多 ${SETUP_TIMEOUT_MS / 60_000} 分钟；
                                                          能读环境变量 ${ENV_SETUP_ROOT_PATH}（主文件夹）、${ENV_SETUP_WORKTREE_PATH}。
                                                          别把密钥写进命令：原文会出现在日志和失败附注里`,
    allowedFlags: ["stdin", "clear"],
    minPositionals: 0,
    maxPositionals: 0,
  }),
  cmdEntry({
    id: "persona.show",
    category: "persona",
    group: "persona",
    action: "show",
    cli: "persona show",
    summary: "输出当前性格设定正文",
    usage: `  ${hub} persona show                                        输出性格设定正文，可增删后用 persona edit --stdin 写回；
                                                          查看当前模式用 ${hub} status`,
    allowedFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
  }),
  cmdEntry({
    id: "persona.edit",
    category: "persona",
    group: "persona",
    action: "edit",
    cli: "persona edit",
    summary: "改模式或完整性格设定",
    usage: `  ${hub} persona edit [--mode ${PM_MODES.join("|")}] [--reason <理由>] [--stdin | --text <新的完整性格设定>]
                                                          改模式或性格设定（正文是改完以后的完整性格设定，不是增量）；改完马上生效`,
    allowedFlags: ["mode", "reason", "stdin", "text"],
    minPositionals: 0,
    maxPositionals: 0,
  }),
  cmdEntry({
    id: "models",
    category: "core",
    group: "models",
    cli: "models",
    summary: "查看各厂商可用模型、思考程度与额度状态",
    usage: `  ${hub} models [--vendor ${AGENT_VENDORS.join("|")}] [--refresh]               查看各厂商可用的模型和每个模型支持的思考程度（--refresh 重新探测）`,
    allowedFlags: ["vendor", "refresh"],
    minPositionals: 0,
    maxPositionals: 0,
  }),
  cmdEntry({
    id: "caps",
    category: "core",
    group: "caps",
    cli: "caps",
    summary: "查看当前项目可用的外接能力（skill/mcp/connector）及开关状态",
    usage: `  ${hub} caps [--kind ${CAPABILITY_KINDS.join("|")}] [--vendor ${AGENT_VENDORS.join("|")}]
                                                          查看当前项目可用的外接能力（skill/mcp/connector）、开关状态、适用厂商及是否支持 --no-outer-sandbox（只读）`,
    allowedFlags: ["kind", "vendor"],
    minPositionals: 0,
    maxPositionals: 0,
  }),
  cmdEntry({
    id: "worker.start",
    category: "worker",
    group: "worker",
    action: "start",
    cli: "worker start",
    summary: "派一个 Worker（或绑定任务图节点换人接手）",
    usage: `  ${hub} worker start --title <标题> [--vendor ${AGENT_VENDORS.join("|")}] [--model <模型>] [--effort ${ALL_EFFORTS.join("|")}] [--clear-effort] [--max-time <时长>] [--readonly] [--caps inherit|none|custom [--allow <能力>...]] [--no-outer-sandbox] [--no-worktree] [--node <节点> [--graph <图编号>]] --stdin
                                                          派一个 Worker，任务说明从标准输入读（--max-time 时间预算，默认 30m，从派活时起算、重启不重置，超了叫醒项目经理、不打断 Worker；
                                                          --caps 外接能力：inherit 照项目能力设置挂（默认），none 一个不带，custom 只挂 --allow 点名的
                                                          skill:<名>、mcp:<名>、connector:<厂商>:<编号>（项目里关掉的点名了也挂不上，可用 ${hub} caps 查看）；读写文件、终端和 hub 永远都在；
                                                          --node 绑到任务图里的节点上，不带就是不绑图的临时 Worker）；
                                                          需要隔离检出与防篡改核对的独立审查，可在任务图中使用审查步骤（"review": true）
  --clear-effort：不继承思考程度，不能与 --effort 同时用。
  --no-outer-sandbox：仅明确挂载 Computer Use 时可申请，Worker 等用户在工作台确认后才开工。Computer Use 控制每个应用前都要等用户在工作台确认；用户拒绝时，换个办法或汇报。
  ${hub} worker start --node <节点> [--graph <图编号>] [--vendor …] [--model …] [--clear-effort] [--stdin]
                                                          换人接手：节点上已经有经手过的 Worker 时，--title 和正文都可以不给（正文给了是补充说明）；
                                                          节点上还挂着没收工的旧 Worker 会先按“没做完”收工，新 Worker 接着用前任的 worktree 和分支，
                                                          第一条消息自动带最近几个前任的汇报、最后的文字、最后几步操作和原始记录路径`,
    allowedFlags: ["title", "vendor", "model", "effort", "clear-effort", "max-time", "readonly", "caps", "allow", "no-outer-sandbox", "no-worktree", "node", "graph", "stdin"],
    minPositionals: 0,
    maxPositionals: 0,
  }),
  cmdEntry({
    id: "worker.send",
    category: "worker",
    group: "worker",
    action: "send",
    cli: "worker send",
    summary: "打回或回答 Worker 的问题",
    usage: `  ${hub} worker send <编号> [--max-time <时长>] --stdin          打回或回答它的问题，同一个 Worker 接着做（--max-time 重设时间预算，默认 30m）`,
    allowedFlags: ["max-time", "stdin"],
    minPositionals: 1,
    maxPositionals: 1,
    positionalHint: "<编号>",
  }),
  cmdEntry({
    id: "worker.max-time",
    category: "worker",
    group: "worker",
    action: "max-time",
    cli: "worker max-time",
    summary: "给在跑的 Worker 延时/更新时间预算",
    usage: `  ${hub} worker max-time <编号> <时长>                       给正在运行的 Worker 单独延时/更新时间预算（如 15m、30m、1h，从现在重新计时）`,
    allowedFlags: [],
    minPositionals: 2,
    maxPositionals: 2,
    positionalHint: "<编号> <时长>",
  }),
  cmdEntry({
    id: "worker.end",
    category: "worker",
    group: "worker",
    action: "end",
    cli: "worker end",
    summary: "停掉并收工一个 Worker",
    usage: `  ${hub} worker end <编号>                                   停掉一个 Worker（正在跑的一轮先被打断）。它在任务图里未完成的步骤会变成等你处理，回执里会写明`,
    allowedFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalHint: "<编号>",
  }),
  cmdEntry({
    id: "worker.list",
    category: "worker",
    group: "worker",
    action: "list",
    cli: "worker list",
    summary: "列出未收工和最近收工的 Worker",
    usage: `  ${hub} worker list [--vendor <厂商>]                         我派出去的 Worker（未收工的和最近收工的）：状态、在哪干活、厂商、模型和思考程度`,
    allowedFlags: ["vendor"],
    minPositionals: 0,
    maxPositionals: 0,
  }),
  cmdEntry({
    id: "worker.show",
    category: "worker",
    group: "worker",
    action: "show",
    cli: "worker show",
    summary: "查看单个 Worker 状态、任务或汇报原文",
    usage: `  ${hub} worker show <编号> [--task | --report [N]]            一个 Worker 现在的情况：状态、在干什么、这一轮和上一轮、进程、分支和 PR；
                                                          --task 只出任务说明原文，--report [N] 只出第 N 轮汇报原文（N 同 search 里的“汇报 #N”，不写就是最新一轮）`,
    allowedFlags: ["task", "report"],
    minPositionals: 1,
    maxPositionals: 2,
    positionalHint: "<编号> [N]",
  }),
  cmdEntry({
    id: "worker.search",
    category: "worker",
    group: "worker",
    action: "search",
    cli: "worker search",
    summary: "按关键词搜索历史 Worker 标题、任务和汇报",
    usage: `  ${hub} worker search <关键词…> [--limit N]                   在我派过的所有 Worker（含已收工）的标题、任务说明、汇报里搜：关键词都要包含，
                                                          中文按子串、英文不分大小写；一处一行，最新的在前（默认 ${WORKER_SEARCH_DEFAULT_LIMIT} 条）`,
    allowedFlags: ["limit"],
    minPositionals: 1,
    maxPositionals: null,
    positionalHint: "<关键词…>",
  }),
  cmdEntry({
    id: "worker.log",
    category: "worker",
    group: "worker",
    action: "log",
    cli: "worker log",
    summary: "查看 Worker 最近 N 步操作或统计汇总",
    usage: `  ${hub} worker log <编号> [--last N | --stats]                它最近 N 步（默认 ${WORKER_LOG_DEFAULT_STEPS}），一行一步：调了什么工具、思考了多久、回复、一轮怎么结束；
                                                          --stats 不列步骤，只出一张汇总：步数、各类动作次数、读得最多的文件、重复最多的命令、思考和等工具的用时；
                                                          并发调用的重叠时间只算一次，未返回结果的调用不计时`,
    allowedFlags: ["last", "stats"],
    minPositionals: 1,
    maxPositionals: 1,
    positionalHint: "<编号>",
  }),
  cmdEntry({
    id: "ask",
    category: "ask",
    group: "ask",
    cli: "ask",
    summary: "向用户挂提问/拍板卡（支持 --node、--option、--file）",
    usage: `  ${hub} ask [--node <步骤>] [--graph <图编号>] [--option <选项>...] [--recommended <选项>] [--replace <编号>] [--file [标签=]路径...] --stdin
                                                          向用户挂一张提问/拍板卡，问题从标准输入读；${ASK_CARD_WHERE}；
                                                          要用户看的文件（文档、报告、截图、录屏等）用 --file 挂在卡片下面，不写进问题里；
                                                          ${FILE_ARG_PATH_HINT}；
                                                          有明确选项时用 --option（至少 ${ASK_MIN_OPTIONS} 个），用 --recommended 标推荐项（选项原文或 1..N 序号）；
                                                          加 --node 挂在任务图步骤上，用户拍板后定案直接交给该步 Worker 接着干（不叫醒项目经理）`,
    allowedFlags: ["node", "graph", "option", "recommended", "replace", "file", "stdin"],
    minPositionals: 0,
    maxPositionals: 0,
  }),
  cmdEntry({
    id: "ask.close",
    category: "ask",
    group: "ask",
    action: "close",
    cli: "ask close",
    summary: "关掉还在等用户回答的提问/拍板卡",
    usage: `  ${hub} ask close <卡编号>                                    关掉自己名下一张还在等用户的提问卡（用户在对话里打字答了、没点卡，或问题过时了）；
                                                          普通卡编号见用户消息前面的说明；步骤拍板卡用 ${hub} ask close --message <消息编号>，编号见 ${hub} graph show`,
    allowedFlags: ["message"],
    minPositionals: 0,
    maxPositionals: 1,
    positionalHint: "<卡编号>",
  }),
  cmdEntry({
    id: "ask.list",
    category: "ask",
    group: "ask",
    action: "list",
    cli: "ask list",
    summary: "列出正在等用户回答的提问/拍板卡",
    usage: `  ${hub} ask list                                            列出自己名下正在等用户回答的卡，含步骤拍板卡和已等时长`,
    allowedFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
  }),
  cmdEntry({
    id: "ask.show",
    category: "ask",
    group: "ask",
    action: "show",
    cli: "ask show",
    summary: "查看单张提问/拍板卡全文、选项和附件",
    usage: `  ${hub} ask show <卡编号>                                   查看自己名下一张卡的全文、选项、文件和状态；
                                                          步骤拍板卡用 ${hub} ask show --message <消息编号>，编号见 ${hub} ask list`,
    allowedFlags: ["message"],
    minPositionals: 0,
    maxPositionals: 1,
    positionalHint: "<卡编号>",
  }),
  cmdEntry({
    id: "schedule.add",
    category: "schedule",
    group: "schedule",
    action: "add",
    cli: "schedule add",
    summary: "新建定时任务（--daily 或 --every）",
    usage: `  ${hub} schedule add --name <名> (--daily HH:MM | --every 30m|2h) --stdin
                                                          建定时任务：到点把任务说明（从标准输入读）发到我自己的对话里。
                                                          --daily 是每天几点（本机时间），--every 是每隔多久（最短 ${MIN_SCHEDULE_EVERY_MINUTES} 分钟）。
                                                          用户要定期做某件事时才建（如日报、周期巡检），任务说明写清每次做什么；日报可按“昨天做完什么 / 什么在等你 / 什么在进行 / 风险”四段写`,
    allowedFlags: ["name", "daily", "every", "stdin"],
    minPositionals: 0,
    maxPositionals: 0,
  }),
  cmdEntry({
    id: "schedule.list",
    category: "schedule",
    group: "schedule",
    action: "list",
    cli: "schedule list",
    summary: "列出我的定时任务",
    usage: `  ${hub} schedule list                                       我的定时任务：频率、下次运行、上次结果`,
    allowedFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
  }),
  cmdEntry({
    id: "schedule.show",
    category: "schedule",
    group: "schedule",
    action: "show",
    cli: "schedule show",
    summary: "查看定时任务全文和最近几次结果",
    usage: `  ${hub} schedule show <编号>                                 查看定时任务全文、上次结果和最近几次运行的回复摘要`,
    allowedFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalHint: "<编号>",
  }),
  cmdEntry({
    id: "schedule.edit",
    category: "schedule",
    group: "schedule",
    action: "edit",
    cli: "schedule edit",
    summary: "原地修改定时任务名称、频率或说明",
    usage: `  ${hub} schedule edit <编号> [--name <名>] [--daily HH:MM | --every 30m|2h] [--stdin]
                                                          原地修改已有定时任务（保持原编号、历史记录和暂停状态不变）；至少给一项要改的字段`,
    allowedFlags: ["name", "daily", "every", "stdin"],
    minPositionals: 1,
    maxPositionals: 1,
    positionalHint: "<编号>",
  }),
  cmdEntry({
    id: "schedule.pause",
    category: "schedule",
    group: "schedule",
    action: "pause",
    cli: "schedule pause",
    summary: "暂停定时任务",
    usage: `  ${hub} schedule pause <编号>                                 暂停`,
    allowedFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalHint: "<编号>",
  }),
  cmdEntry({
    id: "schedule.resume",
    category: "schedule",
    group: "schedule",
    action: "resume",
    cli: "schedule resume",
    summary: "恢复定时任务",
    usage: `  ${hub} schedule resume <编号>                                恢复（从现在算下一次）`,
    allowedFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalHint: "<编号>",
  }),
  cmdEntry({
    id: "schedule.remove",
    category: "schedule",
    group: "schedule",
    action: "remove",
    cli: "schedule remove",
    summary: "删除定时任务",
    usage: `  ${hub} schedule remove <编号>                                删除`,
    allowedFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalHint: "<编号>",
  }),
  cmdEntry({
    id: "watch.add",
    category: "watch",
    group: "watch",
    action: "add",
    cli: "watch add",
    summary: "让后台盯外部条件或到点叫醒",
    usage: `  ${hub} watch add (--until <命令> [--every <间隔>] | --after <时长>) [--max <时长>] [--graph <图编号> | --worker <编号>] --stdin
                                                          让后台替你等外部条件（检查通过、部署完成等），满足、失败或超时都叫醒你；正文是结果出来后你要做的事。
                                                          --until 的命令在项目主文件夹里、只读沙箱中跑（能联网，不能改文件），按这台电脑的 shell 写：
                                                          不带 --every 只跑一次，退出码 0 算满足、其他算失败；带 --every（最短 ${formatDurationShort(WATCH_EVERY_MIN_MS)}）就每隔一段跑一次，直到退出码为 0。
                                                          --after 不跑命令，到点叫醒你。--max 是最多等多久（默认 ${formatDurationShort(WATCH_MAX_DEFAULT_MS)}，最长 ${formatDurationShort(WATCH_MAX_CAP_MS)}）。
                                                          --graph / --worker 把它挂到图或 Worker 上：在盯期间那一项不算等你处理；图结束或 Worker 收工后，结果不再叫醒你`,
    allowedFlags: ["until", "every", "after", "max", "graph", "worker", "stdin"],
    minPositionals: 0,
    maxPositionals: 0,
  }),
  cmdEntry({
    id: "watch.list",
    category: "watch",
    group: "watch",
    action: "list",
    cli: "watch list",
    summary: "列出在盯条件与最近结果",
    usage: `  ${hub} watch list                                          在盯的条件和最近的结果`,
    allowedFlags: [],
    minPositionals: 0,
    maxPositionals: 0,
  }),
  cmdEntry({
    id: "watch.close",
    category: "watch",
    group: "watch",
    action: "close",
    cli: "watch close",
    summary: "停止一个在盯条件",
    usage: `  ${hub} watch close <编号>                                  不用再盯了；正在跑的命令会停下，不再叫醒你`,
    allowedFlags: [],
    minPositionals: 1,
    maxPositionals: 1,
    positionalHint: "<编号>",
  }),
  cmdEntry({
    id: "router.report",
    category: "router",
    group: "router",
    action: "report",
    cli: "router report",
    summary: "向全局总助投递里程碑汇报卡",
    usage: `  ${hub} router report (--summary <摘要> | --stdin) [--pr <URL>] [--worker <编号>] [--file [标签=]路径...] [--link <标签=网址>...]
                                                          向全局总助投递里程碑汇报卡（不打断对话流）；
                                                          本机文件用 --file，--link 只放网址；${FILE_ARG_PATH_HINT}`,
    allowedFlags: ["summary", "pr", "worker", "file", "link", "stdin"],
    minPositionals: 0,
    maxPositionals: 0,
  }),
  cmdEntry({
    id: "graph.create",
    category: "graph",
    group: "graph",
    action: "create",
    cli: "graph create",
    summary: "从 JSON 创建任务图",
    usage: `  ${hub} graph create [--title <标题>] --stdin                  从标准输入 JSON 创建任务流图（steps 不写 deps 默认串接，带 brief 自动开工；confirm: true 完成后等项目经理审）
                                                          JSON：${TASK_GRAPH_CREATE_JSON_HINT}`,
    allowedFlags: ["title", "stdin"],
    minPositionals: 0,
    maxPositionals: 0,
  }),
  cmdEntry({
    id: "graph.show",
    category: "graph",
    group: "graph",
    action: "show",
    cli: "graph show",
    summary: "查看任务图节点、配置与产物详情",
    usage: `  ${hub} graph show [<图编号>]                                查看当前活跃任务图或指定编号任务图：每个节点的状态、厂商、模型、思考程度、执行约束、Worker 和结果（分支、提交、PR、摘要、定案）`,
    allowedFlags: [],
    minPositionals: 0,
    maxPositionals: 1,
    positionalHint: "[<图编号>]",
  }),
  cmdEntry({
    id: "graph.list",
    category: "graph",
    group: "graph",
    action: "list",
    cli: "graph list",
    summary: "列出当前项目的任务图",
    usage: `  ${hub} graph list [--all | --status active|completed|cancelled]
                                                          列出当前项目的任务图与步骤的厂商、模型和思考程度`,
    allowedFlags: ["all", "status"],
    minPositionals: 0,
    maxPositionals: 0,
  }),
  cmdEntry({
    id: "graph.patch",
    category: "graph",
    group: "graph",
    action: "patch",
    cli: "graph patch",
    summary: "从 JSON 增删改步骤或放行步骤",
    usage: `  ${hub} graph patch [<图编号>] --stdin                       从标准输入 JSON 改图；doneSteps 可在同一次改图里放行等项目经理处理的步骤
                                                          JSON：${TASK_GRAPH_PATCH_JSON_HINT}`,
    allowedFlags: ["stdin"],
    minPositionals: 0,
    maxPositionals: 1,
    positionalHint: "[<图编号>]",
  }),
  cmdEntry({
    id: "graph.done",
    category: "graph",
    group: "graph",
    action: "done",
    cli: "graph done",
    summary: "放行步骤或补记 PR/提交/摘要",
    usage: `  ${hub} graph done <节点> [--graph <图编号>] [--pr <URL>] [--commit <SHA>] [--branch <分支>] [--summary <摘要>] [--stdin]
                                                          放行：把没有 Worker 在干的步骤标完了、下游轮到（--stdin 正文是你补给下一步的话），或补记 PR 等结果；
                                                          有 Worker 在干（running）的节点会被拒绝：先 ${hub} worker end 让它收工`,
    allowedFlags: ["graph", "pr", "commit", "branch", "summary", "stdin"],
    minPositionals: 1,
    maxPositionals: 1,
    positionalHint: "<节点>",
  }),
  cmdEntry({
    id: "graph.decide",
    category: "graph",
    group: "graph",
    action: "decide",
    cli: "graph decide",
    summary: "记录用户在对话中的口头拍板",
    usage: `  ${hub} graph decide <节点> --choice <选项> [--note <说明>] [--graph <图编号>]
                                                          记录用户在对话中的口头拍板。检查点须已有用户拍板卡；还在等项目经理审的检查点用 graph done 放行`,
    allowedFlags: ["graph", "choice", "note"],
    minPositionals: 1,
    maxPositionals: 1,
    positionalHint: "<节点>",
  }),
  cmdEntry({
    id: "graph.skip",
    category: "graph",
    group: "graph",
    action: "skip",
    cli: "graph skip",
    summary: "跳过单个步骤并重算下游",
    usage: `  ${hub} graph skip <节点> [--reason <原因>] [--graph <图编号>]  跳过单个任务图节点（跳过也算完了，不连带跳过下游）并重算下游`,
    allowedFlags: ["graph", "reason"],
    minPositionals: 1,
    maxPositionals: 1,
    positionalHint: "<节点>",
  }),
  cmdEntry({
    id: "graph.cancel",
    category: "graph",
    group: "graph",
    action: "cancel",
    cli: "graph cancel",
    summary: "取消未完结的任务图",
    usage: `  ${hub} graph cancel [<图编号>] [--reason <原因>]             取消未完结的任务图`,
    allowedFlags: ["reason"],
    minPositionals: 0,
    maxPositionals: 1,
    positionalHint: "[<图编号>]",
  }),
  cmdEntry({
    id: "graph.finish",
    category: "graph",
    group: "graph",
    action: "finish",
    cli: "graph finish",
    summary: "全部完成后提交交付摘要结束任务图",
    usage: `  ${hub} graph finish [<图编号>] [--unmerged-ok] --stdin        所有节点完成后结束任务图，正文是交付摘要（自动同步给总助；若有未合并 PR 会在回执中注明，--unmerged-ok 为兼容保留参数）`,
    allowedFlags: ["unmerged-ok", "stdin"],
    minPositionals: 0,
    maxPositionals: 1,
    positionalHint: "[<图编号>]",
  }),
  {
    id: "self.reload",
    category: "core",
    group: "self-reload",
    cli: "self-reload",
    summary: "热重启守护进程（--build / --cancel / --status）",
    usage: `  ${hub} self-reload [--build | --cancel | --status]          ${PRODUCT_ID} 自身代码合进来后热重启守护进程：立即返回，等所有会话这一轮收尾、
                                                          全库空闲后自动重启；最多等 ${SELF_RELOAD_DRAIN_MAX_MS / 60_000} 分钟，之后不再等 Worker 轮次和系统消息（重启后自动重发），
                                                          只等你、总助正在回用户的那一轮回完就重启（回执和 ${hub} status 写明最晚几点与忙碌会话）；
                                                          --build 先在后台构建网页，失败就取消、不重启；--cancel 取消待执行的热重启；--status 只查状态不登记`,
    allowedFlags: ["build", "cancel", "status"],
    minPositionals: 0,
    maxPositionals: 0,
    roles: ["pm"],
  },
  {
    id: "dispatch.pm",
    category: "dispatch",
    group: "dispatch",
    action: "pm",
    cli: "dispatch pm",
    summary: "总助向目标项目经理派发消息",
    usage: `  ${hub} dispatch pm --device <self|deviceId> --pm <pmId> [--verbatim | --stdin]`,
    allowedFlags: ["device", "pm", "project", "verbatim", "stdin"],
    minPositionals: 0,
    maxPositionals: 0,
    roles: ["assistant"],
  },
  {
    id: "dispatch.worker-start",
    category: "dispatch",
    group: "dispatch",
    action: "worker-start",
    cli: "dispatch worker-start",
    summary: "总助在目标项目启动临时 Worker",
    usage: `  ${hub} dispatch worker-start --device <self|deviceId> --project <projectId> --title <标题> [--vendor <${AGENT_VENDORS.join("|")}>] [--model <模型>] [--effort <${ALL_EFFORTS.join("|")}>] [--readonly] [--no-worktree] [--verbatim | --stdin]`,
    allowedFlags: ["device", "project", "title", "vendor", "model", "effort", "readonly", "no-worktree", "verbatim", "stdin"],
    minPositionals: 0,
    maxPositionals: 0,
    roles: ["assistant"],
  },
  {
    id: "dispatch.worker-stop",
    category: "dispatch",
    group: "dispatch",
    action: "worker-stop",
    cli: "dispatch worker-stop",
    summary: "总助打断目标 Worker 当前轮次",
    usage: `  ${hub} dispatch worker-stop --device <self|deviceId> --worker <workerId>`,
    allowedFlags: ["device", "worker"],
    minPositionals: 0,
    maxPositionals: 0,
    roles: ["assistant"],
  },
  {
    id: "dispatch.worker-send",
    category: "dispatch",
    group: "dispatch",
    action: "worker-send",
    cli: "dispatch worker-send",
    summary: "总助向目标 Worker 发消息",
    usage: `  ${hub} dispatch worker-send --device <self|deviceId> --worker <workerId> [--verbatim | --stdin]`,
    allowedFlags: ["device", "worker", "verbatim", "stdin"],
    minPositionals: 0,
    maxPositionals: 0,
    roles: ["assistant"],
  },
  {
    id: "dispatch.worker-end",
    category: "dispatch",
    group: "dispatch",
    action: "worker-end",
    cli: "dispatch worker-end",
    summary: "总助收工目标 Worker",
    usage: `  ${hub} dispatch worker-end --device <self|deviceId> --worker <workerId>`,
    allowedFlags: ["device", "worker"],
    minPositionals: 0,
    maxPositionals: 0,
    roles: ["assistant"],
  },
  {
    id: "dispatch.worker-list",
    category: "dispatch",
    group: "dispatch",
    action: "worker-list",
    cli: "dispatch worker-list",
    summary: "总助查询设备上的 Worker 列表",
    usage: `  ${hub} dispatch worker-list --device <self|deviceId> [--project <projectId>]`,
    allowedFlags: ["device", "project"],
    minPositionals: 0,
    maxPositionals: 0,
    roles: ["assistant"],
  },
  {
    id: "dispatch.project-show",
    category: "dispatch",
    group: "dispatch",
    action: "project-show",
    cli: "dispatch project-show",
    summary: "总助展开目标项目档案",
    usage: `  ${hub} dispatch project-show --device <self|deviceId> --project <projectId>`,
    allowedFlags: ["device", "project"],
    minPositionals: 0,
    maxPositionals: 0,
    roles: ["assistant"],
  },
  {
    id: "dispatch.project-create",
    category: "dispatch",
    group: "dispatch",
    action: "project-create",
    cli: "dispatch project-create",
    summary: "总助在目标设备新建项目与项目经理",
    usage: `  ${hub} dispatch project-create --device <self|deviceId> --folder <路径> [--name <项目名>] [--pm-name <PM名>] [--vendor <${AGENT_VENDORS.join("|")}>] [--mode ${PM_MODES.join("|")}]`,
    allowedFlags: ["device", "folder", "name", "pm-name", "vendor", "mode"],
    minPositionals: 0,
    maxPositionals: 0,
    roles: ["assistant"],
  },
];

const CATEGORY_ORDER: readonly { key: Exclude<HubCommandCategory, "dispatch">; label: string }[] = [
  { key: "core", label: "核心" },
  { key: "project", label: "项目" },
  { key: "persona", label: "性格" },
  { key: "worker", label: "Worker" },
  { key: "ask", label: "提问卡" },
  { key: "schedule", label: "定时任务" },
  { key: "watch", label: "在盯条件" },
  { key: "router", label: "总助汇报" },
  { key: "graph", label: "任务图（完整手册：hub help graph）" },
];

const ALL_GROUPS: readonly string[] = [...new Set(HUB_CLI_REGISTRY.map((e) => e.group))];

function actionsOfGroup(group: string): string[] {
  return HUB_CLI_REGISTRY.filter((e) => e.group === group && e.action !== undefined).map((e) => e.action!);
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

function rankCandidates(query: string, candidates: readonly string[]): string[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const maxDist = q.length <= 4 ? 2 : Math.max(2, Math.floor(q.length * 0.45));
  const scored: Array<{ candidate: string; score: number }> = [];
  for (const candidate of candidates) {
    const c = candidate.toLowerCase();
    const dist = editDistance(q, c);
    const prefix = c.startsWith(q) || q.startsWith(c);
    if (dist <= maxDist || (prefix && q.length >= 2)) {
      scored.push({ candidate, score: dist * 10 - (prefix ? 3 : 0) });
    }
  }
  scored.sort((x, y) => x.score - y.score || (x.candidate < y.candidate ? -1 : x.candidate > y.candidate ? 1 : 0));
  return scored.slice(0, HUB_ERROR_SUGGESTIONS_MAX).map((s) => s.candidate);
}

export function findRegistryEntry(group: string | undefined, action?: string): HubCliEntry | undefined {
  if (group === undefined) return undefined;
  if (action !== undefined && !action.startsWith("-")) {
    const exact = HUB_CLI_REGISTRY.find((e) => e.group === group && e.action === action);
    if (exact !== undefined) return exact;
  }
  return HUB_CLI_REGISTRY.find((e) => e.group === group && e.action === undefined);
}

export function isKnownActionGroup(group: string): boolean {
  return actionsOfGroup(group).length > 0;
}

export function resolveHelpTarget(argv: readonly string[]): HelpResolution | null {
  if (argv[0] === "help") {
    const tokens = argv.slice(1).filter((arg) => arg !== "--help" && arg !== "-h");
    if (tokens.length === 0) return { kind: "index" };
    if (tokens.length === 1 && tokens[0] === "--all") return { kind: "all" };
    if (tokens.length === 1 && tokens[0] === "graph") return { kind: "graph-manual" };
    if (tokens.length === 1) {
      const target = tokens[0]!;
      const entries = HUB_CLI_REGISTRY.filter((e) => e.group === target);
      if (entries.length > 0) return { kind: "entries", entries, scopeLabel: target };
      return { kind: "unknown", query: target, suggestions: suggestSubcommands(undefined, target) };
    }
    if (tokens.length === 2) {
      const [group, action] = tokens as [string, string];
      const entries = HUB_CLI_REGISTRY.filter((e) => e.group === group && e.action === action);
      if (entries.length > 0) return { kind: "entries", entries, scopeLabel: `${group} ${action}` };
      const suggestions = ALL_GROUPS.includes(group)
        ? suggestSubcommands(group, action).map((a) => `${group} ${a}`)
        : suggestSubcommands(undefined, group);
      return { kind: "unknown", query: `${group} ${action}`, suggestions };
    }
    return { kind: "unknown", query: tokens.join(" "), suggestions: [] };
  }

  if (argv[0] === "checklist") {
    if (argv.length === 2 && (argv[1] === "--help" || argv[1] === "-h")) {
      const entries = HUB_CLI_REGISTRY.filter((e) => e.group === "checklist");
      return { kind: "entries", entries, scopeLabel: "checklist" };
    }
    return null;
  }

  const end = argv.indexOf("--");
  const scan = end === -1 ? argv : argv.slice(0, end);
  if (!scan.includes("--help") && !scan.includes("-h")) return null;

  const leading: string[] = [];
  for (const token of scan) {
    if (token.startsWith("-")) break;
    leading.push(token);
  }
  if (leading.length === 0) return scan.includes("--all") ? { kind: "all" } : { kind: "index" };
  const [group, action] = leading;
  if (action !== undefined) {
    const exact = HUB_CLI_REGISTRY.filter((e) => e.group === group && e.action === action);
    if (exact.length > 0) return { kind: "entries", entries: exact, scopeLabel: `${group} ${action}` };
    const bare = HUB_CLI_REGISTRY.filter((e) => e.group === group && e.action === undefined);
    if (bare.length > 0) return { kind: "entries", entries: bare, scopeLabel: group! };
    const suggestions = ALL_GROUPS.includes(group!)
      ? suggestSubcommands(group, action).map((a) => `${group} ${a}`)
      : suggestSubcommands(undefined, group!);
    return { kind: "unknown", query: `${group} ${action}`, suggestions };
  }
  const groupEntries = HUB_CLI_REGISTRY.filter((e) => e.group === group);
  if (groupEntries.length > 0) return { kind: "entries", entries: groupEntries, scopeLabel: group! };
  return { kind: "unknown", query: group!, suggestions: suggestSubcommands(undefined, group!) };
}

export function renderEntryUsage(entry: HubCliEntry): string {
  if (!isHubCommandId(entry.id)) return entry.usage;
  const limits = hubLimitsHelpLine(entry.id);
  return limits === null ? entry.usage : `${entry.usage}\n${limits}`;
}

export function renderHelpIndex(): string {
  const lines: string[] = [
    `用法：${hub} <命令> [参数]（按组或单条查完整参数与上限：${hub} help <组> [<动作>] 或 ${hub} <命令> --help；全部展开：${hub} help --all）`,
  ];
  for (const { key, label } of CATEGORY_ORDER) {
    const entries = HUB_CLI_REGISTRY.filter((e) => e.category === key);
    if (entries.length === 0) continue;
    lines.push("", label);
    for (const entry of entries) {
      lines.push(`  ${entry.cli.padEnd(18)} ${entry.summary}`);
    }
  }
  lines.push(
    "",
    `总助调度命令：${hub} help dispatch`,
    `长文本用 --stdin（上限 ${hubLimitMaximum("stdin")}）：${STDIN_SHELL_NOTE}`,
    `令牌与 socket 由 ${hub} 从 ${ENV_HUB_TOKEN}、${ENV_HUB_SOCK} 自动读取，命令里不要写环境变量。`,
  );
  return `${lines.join("\n")}\n`;
}

export function renderScopedHelp(entries: readonly HubCliEntry[]): string {
  const body = entries.map(renderEntryUsage).join("\n");
  return `用法：\n${body}\n（按组查：${hub} help <组>；完整用法运行 ${hub} help --all）\n`;
}

export function renderFullHelp(): string {
  const standardEntries = HUB_CLI_REGISTRY.filter((e) => isHubCommandId(e.id));
  const reloadEntry = HUB_CLI_REGISTRY.find((e) => e.id === "self.reload")!;
  return `用法：
${standardEntries.map(renderEntryUsage).join("\n")}
${reloadEntry.usage}
  ${hub} help graph                                        打印任务图手册：${TASK_GRAPH_MANUAL_SUMMARY}和全部 graph 命令

长文本用 --stdin 从标准输入原样读，标准输入最多 ${hubLimitMaximum("stdin")}。下面的例子照抄时保持顶格，结束标记前不能有空格。
bash、zsh 用 heredoc（引号不能省），例如：
${hub} persona edit --stdin <<'EOF'
新的完整性格设定
EOF
${hub} worker start --title "修 X" --stdin <<'EOF'
任务说明：目标、验收标准
EOF
${hub} schedule add --name "每日汇报" --daily 09:00 --stdin <<'EOF'
每次要做的事
EOF
PowerShell 用单引号 here-string 管道传入，先把 $OutputEncoding 设成 UTF-8（不设的话，Windows PowerShell 5.1 会把中文等非 ASCII 字符变成问号），例如：
${POWERSHELL_UTF8_PIPE}; @'
任务说明：目标、验收标准
'@ | ${hub} worker start --title "修 X" --stdin
令牌和 socket 路径由 ${hub} 自己从环境变量 ${ENV_HUB_TOKEN}、${ENV_HUB_SOCK} 读，命令里不要写变量。
`;
}

export function suggestSubcommands(group: string | undefined, token: string): string[] {
  const pool = group === undefined ? ALL_GROUPS : actionsOfGroup(group);
  return rankCandidates(token, pool);
}

export function suggestFlags(rawFlag: string, allowedFlags: readonly string[]): string[] {
  const clean = rawFlag.replace(/^-+/u, "");
  if (clean === "") return [];
  return rankCandidates(clean, allowedFlags).map((flag) => `--${flag}`);
}

export function formatMissingActionError(group: string): string {
  const actions = actionsOfGroup(group);
  return `${hub} ${group} 需要指定子命令：${actions.join("、")}`;
}

export function formatPositionalCountError(
  cli: string,
  expected: { min: number; max: number | null; hint?: string },
  actual: number,
): string {
  const expectText =
    expected.max === null
      ? `至少 ${expected.min} 个`
      : expected.min === expected.max
        ? `${expected.min} 个`
        : `${expected.min}～${expected.max} 个`;
  const hint = expected.hint === undefined || expected.hint === "" ? "" : `（${expected.hint}）`;
  return `${hub} ${cli} 需要 ${expectText}位置参数${hint}，但收到了 ${actual} 个`;
}
