import { PM_MODES } from "../shared/domain.ts";
import {
  ASK_CARD_WHERE,
  ENV_HUB_SOCK,
  ENV_HUB_TOKEN,
  POWERSHELL_UTF8_PIPE,
  TASK_GRAPH_CREATE_JSON_HINT,
  TASK_GRAPH_PATCH_JSON_HINT,
  type HubCommand,
} from "../shared/hub.ts";
import {
  HUB_FILE_ARGS_MAX,
  ENV_SETUP_ROOT_PATH,
  ENV_SETUP_WORKTREE_PATH,
  MIN_SCHEDULE_EVERY_MINUTES,
  SELF_RELOAD_DRAIN_MAX_MS,
  SETUP_TIMEOUT_MS,
  WORKER_LOG_DEFAULT_STEPS,
  WORKER_LOG_MAX_STEPS,
  WORKER_SEARCH_DEFAULT_LIMIT,
  WORKER_SEARCH_MAX_LIMIT,
} from "../shared/limits.ts";
import { HUB_COMMAND, PRODUCT_ID } from "../shared/names.ts";
import { AGENT_VENDORS, ALL_EFFORTS } from "../shared/vendors.ts";

const hub = HUB_COMMAND;

export interface HubCommandSpec {
  command: HubCommand;
  group: string;
  action?: string;
  cli: string;
  usage: string;
}

export const HUB_COMMAND_SPECS: readonly HubCommandSpec[] = [
  {
    command: "status",
    group: "status",
    cli: "status",
    usage: `  ${hub} status                                              我是谁、我的项目、文件夹、worktree 准备命令和活跃的任务图`,
  },
  {
    command: "project.create",
    group: "project",
    action: "create",
    cli: "project create",
    usage: `  ${hub} project create --folder <主文件夹> [--name <名>] [--description <说明>]
                                                          建项目（文件夹要已经存在；一个项目经理只管一个项目）`,
  },
  {
    command: "project.attach",
    group: "project",
    action: "attach",
    cli: "project attach",
    usage: `  ${hub} project attach <文件夹>                             给项目挂上附加文件夹`,
  },
  {
    command: "project.detach",
    group: "project",
    action: "detach",
    cli: "project detach",
    usage: `  ${hub} project detach <文件夹>                             从项目上移除附加文件夹`,
  },
  {
    command: "project.setup",
    group: "project",
    action: "setup",
    cli: "project setup",
    usage: `  ${hub} project setup --stdin | --clear                     设置（从标准输入读）或清除 worktree 准备命令：
                                                          给 Worker 建好 worktree 后先在里面跑它，跑完 Worker 再开工。
                                                          macOS、Linux 用守护进程的 $SHELL -c 跑，Windows 依次找 Git Bash、PowerShell 7、cmd；
                                                          标准输入是空的，最多 ${SETUP_TIMEOUT_MS / 60_000} 分钟；
                                                          能读环境变量 ${ENV_SETUP_ROOT_PATH}（主文件夹）、${ENV_SETUP_WORKTREE_PATH}。
                                                          别把密钥写进命令：原文会出现在日志和失败附注里`,
  },
  {
    command: "persona.show",
    group: "persona",
    action: "show",
    cli: "persona show",
    usage: `  ${hub} persona show                                        输出性格设定正文，可增删后用 persona edit --stdin 写回；
                                                          查看当前模式用 ${hub} status`,
  },
  {
    command: "persona.edit",
    group: "persona",
    action: "edit",
    cli: "persona edit",
    usage: `  ${hub} persona edit [--mode ${PM_MODES.join("|")}] [--reason <理由>] [--stdin | --text <新的完整性格设定>]
                                                          改模式或性格设定（正文是改完以后的完整性格设定，不是增量）；改完马上生效`,
  },
  {
    command: "models",
    group: "models",
    cli: "models",
    usage: `  ${hub} models [--vendor ${AGENT_VENDORS.join("|")}] [--refresh]               查看各厂商可用的模型和每个模型支持的思考程度（--refresh 重新探测）`,
  },
  {
    command: "worker.start",
    group: "worker",
    action: "start",
    cli: "worker start",
    usage: `  ${hub} worker start --title <标题> [--vendor ${AGENT_VENDORS.join("|")}] [--model <模型>] [--effort ${ALL_EFFORTS.join("|")}] [--clear-effort] [--max-time <时长>] [--readonly] [--caps inherit|none|custom [--allow <能力>...]] [--no-outer-sandbox] [--no-worktree] [--node <节点> [--graph <图编号>]] --stdin
                                                          派一个 Worker，任务说明从标准输入读（--max-time 本轮最大容忍时间，默认 30m，超了叫醒项目经理、不打断 Worker；
                                                          --caps 外接能力：inherit 照项目能力设置挂（默认），none 一个不带，custom 只挂 --allow 点名的
                                                          skill:<名>、mcp:<名>、connector:<厂商>:<编号>（项目里关掉的点名了也挂不上）；读写文件、终端和 hub 永远都在；
                                                          --node 绑到任务图里的节点上，不带就是不绑图的临时 Worker）；
                                                          独立审查请建单步审查图（审查步骤，写被审分支），不要派普通 Worker 审
  --clear-effort：不继承思考程度，不能与 --effort 同时用。
  --no-outer-sandbox：仅明确挂载 Computer Use 时可申请，Worker 等用户在工作台确认后才开工。Computer Use 控制每个应用前都要等用户在工作台确认；用户拒绝时，换个办法或汇报。
  ${hub} worker start --node <节点> [--graph <图编号>] [--vendor …] [--model …] [--clear-effort] [--stdin]
                                                          换人接手：节点上已经有经手过的 Worker 时，--title 和正文都可以不给（正文给了是补充说明）；
                                                          节点上还挂着没收工的旧 Worker 会先按“没做完”收工，新 Worker 接着用前任的 worktree 和分支，
                                                          第一条消息自动带最近几个前任的汇报、最后的文字、最后几步操作和原始记录路径`,
  },
  {
    command: "worker.send",
    group: "worker",
    action: "send",
    cli: "worker send",
    usage: `  ${hub} worker send <编号> [--max-time <时长>] --stdin          打回或回答它的问题，同一个 Worker 接着做（--max-time 本轮最大容忍时间，默认 30m）`,
  },
  {
    command: "worker.max-time",
    group: "worker",
    action: "max-time",
    cli: "worker max-time",
    usage: `  ${hub} worker max-time <编号> <时长>                       给正在运行的 Worker 单独延时/更新本轮最大时间（如 15m、30m、1h，从现在重新计时）`,
  },
  {
    command: "worker.end",
    group: "worker",
    action: "end",
    cli: "worker end",
    usage: `  ${hub} worker end <编号>                                   停掉一个 Worker（正在跑的一轮先被打断）。它在任务图里未完成的步骤会变成等你处理，回执里会写明`,
  },
  {
    command: "worker.list",
    group: "worker",
    action: "list",
    cli: "worker list",
    usage: `  ${hub} worker list [--vendor <厂商>]                         我派出去的 Worker（未收工的和最近收工的）：状态、在哪干活、厂商、模型和思考程度`,
  },
  {
    command: "worker.show",
    group: "worker",
    action: "show",
    cli: "worker show",
    usage: `  ${hub} worker show <编号> [--task | --report [N]]            一个 Worker 现在的情况：状态、在干什么、这一轮和上一轮、进程、分支和 PR；
                                                          --task 只出任务说明原文，--report [N] 只出第 N 轮汇报原文（N 同 search 里的“汇报 #N”，不写就是最新一轮）`,
  },
  {
    command: "worker.search",
    group: "worker",
    action: "search",
    cli: "worker search",
    usage: `  ${hub} worker search <关键词…> [--limit N]                   在我派过的所有 Worker（含已收工）的标题、任务说明、汇报里搜：关键词都要包含，
                                                          中文按子串、英文不分大小写；一处一行，最新的在前（默认 ${WORKER_SEARCH_DEFAULT_LIMIT} 条，最多 ${WORKER_SEARCH_MAX_LIMIT}）`,
  },
  {
    command: "worker.log",
    group: "worker",
    action: "log",
    cli: "worker log",
    usage: `  ${hub} worker log <编号> [--last N | --stats]                它最近 N 步（默认 ${WORKER_LOG_DEFAULT_STEPS}，最多 ${WORKER_LOG_MAX_STEPS}），一行一步：调了什么工具、思考了多久、回复、一轮怎么结束；
                                                          --stats 不列步骤，只出一张汇总：步数、各类动作次数、读得最多的文件、重复最多的命令、思考和等工具的用时`,
  },
  {
    command: "ask",
    group: "ask",
    cli: "ask",
    usage: `  ${hub} ask [--node <步骤>] [--graph <图编号>] [--option <选项>...] [--recommended <选项>] [--replace <编号>] [--file [标签=]路径...] --stdin
                                                          向用户挂一张提问/拍板卡，问题从标准输入读；${ASK_CARD_WHERE}；
                                                          要用户看的文件（方案、验收结论、截图、录屏）用 --file 挂在卡片下面（最多 ${HUB_FILE_ARGS_MAX} 个），不写进问题里；
                                                          有明确选项时用 --option（至少 2 个），用 --recommended 标推荐项（选项原文或 1..N 序号）；
                                                          加 --node 挂在任务图步骤上，用户拍板后定案直接交给该步 Worker 接着干（不叫醒项目经理）`,
  },
  {
    command: "ask.close",
    group: "ask",
    action: "close",
    cli: "ask close",
    usage: `  ${hub} ask close <卡编号>                                    关掉自己名下一张还在等用户的提问卡（用户在对话里打字答了、没点卡，或问题过时了）；
                                                          普通卡编号见用户消息前面的说明；步骤拍板卡用 ${hub} ask close --message <消息编号>，编号见 ${hub} graph show`,
  },
  {
    command: "ask.list",
    group: "ask",
    action: "list",
    cli: "ask list",
    usage: `  ${hub} ask list                                            列出自己名下正在等用户回答的卡，含步骤拍板卡和已等时长`,
  },
  {
    command: "ask.show",
    group: "ask",
    action: "show",
    cli: "ask show",
    usage: `  ${hub} ask show <卡编号>                                   查看自己名下一张卡的全文、选项、文件和状态；
                                                          步骤拍板卡用 ${hub} ask show --message <消息编号>，编号见 ${hub} ask list`,
  },
  {
    command: "schedule.add",
    group: "schedule",
    action: "add",
    cli: "schedule add",
    usage: `  ${hub} schedule add --name <名> (--daily HH:MM | --every 30m|2h) --stdin
                                                          建定时任务：到点把任务说明（从标准输入读）发到我自己的对话里。
                                                          --daily 是每天几点（本机时间），--every 是每隔多久（最短 ${MIN_SCHEDULE_EVERY_MINUTES} 分钟）。
                                                          用户要定期做某件事时才建（如日报、周期巡检），任务说明写清每次做什么；日报可按“昨天做完什么 / 什么在等你 / 什么在进行 / 风险”四段写`,
  },
  {
    command: "schedule.list",
    group: "schedule",
    action: "list",
    cli: "schedule list",
    usage: `  ${hub} schedule list                                       我的定时任务：频率、下次运行、上次结果`,
  },
  {
    command: "schedule.show",
    group: "schedule",
    action: "show",
    cli: "schedule show",
    usage: `  ${hub} schedule show <编号>                                 查看定时任务全文、上次结果和最近几次运行的回复摘要`,
  },
  {
    command: "schedule.pause",
    group: "schedule",
    action: "pause",
    cli: "schedule pause",
    usage: `  ${hub} schedule pause <编号>                                 暂停`,
  },
  {
    command: "schedule.resume",
    group: "schedule",
    action: "resume",
    cli: "schedule resume",
    usage: `  ${hub} schedule resume <编号>                                恢复（从现在算下一次）`,
  },
  {
    command: "schedule.remove",
    group: "schedule",
    action: "remove",
    cli: "schedule remove",
    usage: `  ${hub} schedule remove <编号>                                删除`,
  },
  {
    command: "router.report",
    group: "router",
    action: "report",
    cli: "router report",
    usage: `  ${hub} router report (--summary <摘要> | --stdin) [--pr <URL>] [--worker <编号>] [--file [标签=]路径...] [--link <标签=网址>...]
                                                          向全局总助投递里程碑汇报卡（不打断对话流）；本机文件用 --file（最多 ${HUB_FILE_ARGS_MAX} 个），--link 只放网址`,
  },
  {
    command: "graph.create",
    group: "graph",
    action: "create",
    cli: "graph create",
    usage: `  ${hub} graph create [--title <标题>] --stdin                  从标准输入 JSON 创建任务流图（steps 不写 deps 默认串接，带 brief 自动开工）
                                                          JSON：${TASK_GRAPH_CREATE_JSON_HINT}`,
  },
  {
    command: "graph.show",
    group: "graph",
    action: "show",
    cli: "graph show",
    usage: `  ${hub} graph show [<图编号>]                                查看当前活跃任务图或指定编号任务图：每个节点的状态、厂商、模型、思考程度、Worker 和结果（分支、提交、PR、摘要、定案）`,
  },
  {
    command: "graph.list",
    group: "graph",
    action: "list",
    cli: "graph list",
    usage: `  ${hub} graph list [--all | --status active|completed|cancelled]
                                                          列出当前项目的任务图与步骤的厂商、模型和思考程度`,
  },
  {
    command: "graph.patch",
    group: "graph",
    action: "patch",
    cli: "graph patch",
    usage: `  ${hub} graph patch [<图编号>] --stdin                       从标准输入 JSON 增量增删改任务图步骤、跳过未开工步骤（在干或已完的不可直接改，已结束的图不能改）
                                                          JSON：${TASK_GRAPH_PATCH_JSON_HINT}`,
  },
  {
    command: "graph.done",
    group: "graph",
    action: "done",
    cli: "graph done",
    usage: `  ${hub} graph done <节点> [--graph <图编号>] [--pr <URL>] [--commit <SHA>] [--branch <分支>] [--summary <摘要>] [--stdin]
                                                          放行：把没有 Worker 在干的步骤标完了、下游轮到（--stdin 正文是你补给下一步的话），或补记 PR 等结果；
                                                          有 Worker 在干（running）的节点会被拒绝：先 ${hub} worker end 让它收工`,
  },
  {
    command: "graph.decide",
    group: "graph",
    action: "decide",
    cli: "graph decide",
    usage: `  ${hub} graph decide <节点> --choice <选项> [--note <说明>] [--graph <图编号>]
                                                          记录用户在对话中的口头拍板（挂着未收工 Worker 时直接发给该 Worker 接着干，否则步骤完了推进下游）`,
  },
  {
    command: "graph.skip",
    group: "graph",
    action: "skip",
    cli: "graph skip",
    usage: `  ${hub} graph skip <节点> [--reason <原因>] [--graph <图编号>]  跳过单个任务图节点（跳过也算完了，不连带跳过下游）并重算下游`,
  },
  {
    command: "graph.cancel",
    group: "graph",
    action: "cancel",
    cli: "graph cancel",
    usage: `  ${hub} graph cancel [<图编号>] [--reason <原因>]             取消未完结的任务图`,
  },
  {
    command: "graph.finish",
    group: "graph",
    action: "finish",
    cli: "graph finish",
    usage: `  ${hub} graph finish [<图编号>] [--unmerged-ok] --stdin        所有节点完成后结束任务图，正文是交付摘要（自动同步给总助；有未合并 PR 时默认拦下提醒）`,
  },
];

const SELF_RELOAD_USAGE = `  ${hub} self-reload [--build]                              ${PRODUCT_ID} 自身代码合进来后热重启守护进程：立即返回，等所有会话这一轮收尾、
                                                          全库空闲后自动重启；最多等 ${SELF_RELOAD_DRAIN_MAX_MS / 60_000} 分钟，之后不再等 Worker 轮次和系统消息（重启后自动重发），
                                                          只等你、总助正在回用户的那一轮回完就重启（回执和 hub status 写明最晚几点）；--build 先在后台构建网页，失败就取消、不重启`;

export const HUB_USAGE = `用法：
${HUB_COMMAND_SPECS.map((s) => s.usage).join("\n")}
${SELF_RELOAD_USAGE}
  ${hub} help graph                                        打印任务图手册：建图、改图、换人、审查的做法和全部 graph 命令

长文本用 --stdin 从标准输入原样读。下面的例子照抄时保持顶格，结束标记前不能有空格。
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

const DISPATCH_USAGE = `  ${hub} dispatch pm --device <self|deviceId> --pm <pmId> [--verbatim | --stdin]
  ${hub} dispatch worker-start --device <self|deviceId> --project <projectId> --title <标题> [--vendor <${AGENT_VENDORS.join("|")}>] [--model <模型>] [--effort <${ALL_EFFORTS.join("|")}>] [--readonly] [--no-worktree] [--verbatim | --stdin]
  ${hub} dispatch worker-stop --device <self|deviceId> --worker <workerId>
  ${hub} dispatch worker-send --device <self|deviceId> --worker <workerId> [--verbatim | --stdin]
  ${hub} dispatch worker-end --device <self|deviceId> --worker <workerId>
  ${hub} dispatch worker-list --device <self|deviceId> [--project <projectId>]
  ${hub} dispatch project-show --device <self|deviceId> --project <projectId>
  ${hub} dispatch project-create --device <self|deviceId> --folder <路径> [--name <项目名>] [--pm-name <PM名>] [--vendor <${AGENT_VENDORS.join("|")}>] [--mode ${PM_MODES.join("|")}]`;

export function commandUsageFor(argv: readonly string[]): string {
  const group = argv[0];
  if (group === undefined) return HUB_USAGE;
  if (group === "dispatch") return `用法：\n${DISPATCH_USAGE}\n`;
  if (group === "self-reload") return `用法：\n${SELF_RELOAD_USAGE}\n`;
  const groupSpecs = HUB_COMMAND_SPECS.filter((s) => s.group === group);
  if (groupSpecs.length === 0) return HUB_USAGE;
  const action = argv[1];
  const actionSpecs = action !== undefined ? groupSpecs.filter((s) => s.action === action) : [];
  const matched = actionSpecs.length > 0 ? actionSpecs : groupSpecs;
  return `用法：\n${matched.map((s) => s.usage).join("\n")}\n（完整用法运行 ${hub} help）\n`;
}
