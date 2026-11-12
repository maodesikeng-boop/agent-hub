// hub 命令（设计第 8.1 节；规格见 shared/hub.ts 的注释）：agent 在自己的 shell 里敲，令牌和 socket 路径从环境变量读，
// 经 Unix socket 请求守护进程的 agent 接口，把结果打印出来，按 HUB_EXIT 退出。
// 只引 shared 里不依赖 node:path 以外东西的几个文件，启动快。
import { request, type ClientRequest } from "node:http";
import { basename, resolve } from "node:path";
import type { Readable } from "node:stream";
import { parseArgs } from "node:util";
import { PM_MODES, TASK_GRAPH_STATUSES, validateAskOptions, type PmMode } from "../shared/domain.ts";
import { LOCAL_ERRORS } from "../shared/errors.ts";
import {
  ENV_HUB_SOCK,
  ENV_HUB_TOKEN,
  HUB_EXIT,
  SELF_RELOAD_AGENT_PATH,
  TASK_GRAPH_CREATE_JSON_HINT,
  TASK_GRAPH_PATCH_JSON_HINT,
  hubPath,
  type HubCommand,
} from "../shared/hub.ts";
import {
  HUB_CLI_STDIN_IDLE_MS,
  HUB_CLI_TIMEOUT_MS,
  ENV_SETUP_ROOT_PATH,
  ENV_SETUP_WORKTREE_PATH,
  HUB_MAX_BODY_BYTES,
  MIN_SCHEDULE_EVERY_MINUTES,
  ROUTER_OPTION_MAX_COUNT,
  SETUP_TIMEOUT_MS,
  WORKER_LOG_DEFAULT_STEPS,
  WORKER_LOG_MAX_STEPS,
  WORKER_SEARCH_DEFAULT_LIMIT,
  WORKER_SEARCH_MAX_LIMIT,
} from "../shared/limits.ts";
import { ROUTER_DISPATCH_AGENT_PATH, type RouterReportLink } from "../shared/router.ts";
import { HUB_COMMAND, PRODUCT_ID } from "../shared/names.ts";
import { checkEveryMinutes, parseDailyTime, parseEvery, parseWorkerMaxTime } from "../shared/schedule.ts";
import { AGENT_VENDORS, ALL_EFFORTS, isAgentVendor } from "../shared/vendors.ts";

export interface HubIo {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  /** 只有写了 --stdin 才会调；没写就绝不碰标准输入。 */
  stdin: () => Readable;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  /** 连上之后多久没动静算没回应，默认 HUB_CLI_TIMEOUT_MS。 */
  timeoutMs?: number;
  /** --stdin 多久没收到数据就放弃，默认 HUB_CLI_STDIN_IDLE_MS。 */
  stdinIdleMs?: number;
}

/** 和守护进程认的令牌字符一样；别的字符放进请求头 Node 会直接抛错。 */
const TOKEN_CHARS = /^[A-Za-z0-9_-]+$/;

/** 命令名（names.ts 的 HUB_COMMAND），下面的用法和报错里用。 */
const hub = HUB_COMMAND;

export interface HubCommandSpec {
  command: HubCommand;
  group: string;
  action?: string;
  /** 命令行写法，如 "project create"、"status"、"worker log"。 */
  cli: string;
  /** HUB_USAGE 里该命令对应的用法行（含缩进）。 */
  usage: string;
}

/** 结构化命令规格表：生成 HUB_USAGE、按命令打印简短用法、以及单测防漂移守卫共用。 */
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
                                                          用守护进程的 $SHELL -c 跑，标准输入是空的，最多 ${SETUP_TIMEOUT_MS / 60_000} 分钟；
                                                          能用 $${ENV_SETUP_ROOT_PATH}（主文件夹）、$${ENV_SETUP_WORKTREE_PATH}。
                                                          别把密钥写进命令：原文会出现在日志和失败附注里`,
  },
  {
    command: "persona.show",
    group: "persona",
    action: "show",
    cli: "persona show",
    usage: `  ${hub} persona show                                        查看现在的性格设定和模式`,
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
    usage: `  ${hub} worker start --title <标题> [--vendor ${AGENT_VENDORS.join("|")}] [--model <模型>] [--effort ${ALL_EFFORTS.join("|")}] [--max-time <时长>] [--readonly] [--no-worktree] [--node <节点> [--graph <图编号>]] --stdin
                                                          派一个 Worker，任务说明从标准输入读（--max-time 本轮最大容忍时间，默认 30m，超了叫醒项目经理、不打断 Worker；
                                                          --node 绑到任务图里轮到的（ready）或等人接手的（attention）节点上，不带就是不绑图的临时 Worker）`,
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
    usage: `  ${hub} worker end <编号> [--incomplete]                     收工：结束这个 Worker 的会话（正在跑的一轮先被打断）。绑了任务图节点的：
                                                          它最近一轮汇报是“做完了”，节点自动标完成并解锁下游；否则节点变成 attention 等人接手。
                                                          换人时加 --incomplete：不管它汇报了什么，节点都等人接手。回执里会写明节点变成了什么`,
  },
  {
    command: "worker.list",
    group: "worker",
    action: "list",
    cli: "worker list",
    usage: `  ${hub} worker list                                         我派出去的 Worker（进行中的和最近收工的）：状态、在哪干活、模型和思考程度`,
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
    usage: `  ${hub} ask [--option <选项>...] --stdin                      向用户提问（要用户拍板、确认、选择的事），问题从标准输入读；
                                                          有明确选项时用 --option（至少 2 个）让用户点选；会单独提醒用户，不会被别的消息刷掉`,
  },
  {
    command: "schedule.add",
    group: "schedule",
    action: "add",
    cli: "schedule add",
    usage: `  ${hub} schedule add --name <名> (--daily HH:MM | --every 30m|2h) --stdin
                                                          建定时任务：到点把任务说明（从标准输入读）发到我自己的对话里。
                                                          --daily 是每天几点（本机时间），--every 是每隔多久（最短 ${MIN_SCHEDULE_EVERY_MINUTES} 分钟）。
                                                          用户要日报才建，任务说明按“昨天做完什么 / 什么在等你 / 什么在进行 / 风险”四段写`,
  },
  {
    command: "schedule.list",
    group: "schedule",
    action: "list",
    cli: "schedule list",
    usage: `  ${hub} schedule list                                       我的定时任务：频率、下次运行、上次结果`,
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
    command: "router.ask",
    group: "router",
    action: "ask",
    cli: "router ask",
    usage: `  ${hub} router ask --question <问题> --option <选项>... [--recommended <1..4>] [--replace <编号>] [--context <说明> | --stdin]
                                                          向全局总助提交结构化拍板卡（2～4 个选项，同步写入对话）`,
  },
  {
    command: "router.report",
    group: "router",
    action: "report",
    cli: "router report",
    usage: `  ${hub} router report (--summary <摘要> | --stdin) [--pr <URL>] [--worker <编号>] [--file <路径>] [--link <标签=地址>...]
                                                          向全局总助投递里程碑汇报卡（不打断对话流）`,
  },
  {
    command: "router.note",
    group: "router",
    action: "note",
    cli: "router note",
    usage: `  ${hub} router note (--text <备忘> | --stdin | --clear)        更新或清除当前项目经理的一句话主线备忘`,
  },
  {
    command: "graph.create",
    group: "graph",
    action: "create",
    cli: "graph create",
    usage: `  ${hub} graph create [--title <标题>] --stdin                  从标准输入 JSON 创建任务流图（DAG）
                                                          JSON：${TASK_GRAPH_CREATE_JSON_HINT}`,
  },
  {
    command: "graph.show",
    group: "graph",
    action: "show",
    cli: "graph show",
    usage: `  ${hub} graph show [<图编号>]                                查看当前活跃任务图或指定编号任务图：每个节点的状态、Worker 和结果（分支、提交、PR、摘要、定案）`,
  },
  {
    command: "graph.list",
    group: "graph",
    action: "list",
    cli: "graph list",
    usage: `  ${hub} graph list [--all | --status active|completed|cancelled]
                                                          列出当前项目的任务图`,
  },
  {
    command: "graph.ask",
    group: "graph",
    action: "ask",
    cli: "graph ask",
    usage: `  ${hub} graph ask <节点> [--graph <图编号>] [--question <问题>] [--option <选项>...] [--recommended <选项>] [--stdin]
                                                          给门禁节点填入问题、选项与调研摘要并按依赖激活`,
  },
  {
    command: "graph.patch",
    group: "graph",
    action: "patch",
    cli: "graph patch",
    usage: `  ${hub} graph patch [<图编号>] --stdin                       从标准输入 JSON 增量增删改任务图节点与依赖边、跳过还没开工的节点（已经结束的图不能改）
                                                          JSON：${TASK_GRAPH_PATCH_JSON_HINT}`,
  },
  {
    command: "graph.done",
    group: "graph",
    action: "done",
    cli: "graph done",
    usage: `  ${hub} graph done <节点> [--graph <图编号>] [--pr <URL>] [--commit <SHA>] [--branch <分支>] [--summary <摘要> | --stdin]
                                                          把没有 Worker 在干的阶段节点标完成并解锁下游，或给节点补记 PR 等结果；
                                                          有 Worker 在干（running）的节点会被拒绝：先 ${hub} worker end 让它收工`,
  },
  {
    command: "graph.decide",
    group: "graph",
    action: "decide",
    cli: "graph decide",
    usage: `  ${hub} graph decide <节点> --choice <选项> [--note <说明>] [--graph <图编号>]
                                                          记录用户在对话中的口头拍板并解锁门禁下游`,
  },
  {
    command: "graph.skip",
    group: "graph",
    action: "skip",
    cli: "graph skip",
    usage: `  ${hub} graph skip <节点> [--reason <原因>] [--graph <图编号>]  跳过任务图节点并重算下游`,
  },
  {
    command: "graph.cancel",
    group: "graph",
    action: "cancel",
    cli: "graph cancel",
    usage: `  ${hub} graph cancel [<图编号>] [--reason <原因>]             取消未完结的任务图`,
  },
];

/** 守护进程级命令（不进账本的 hubCall，单独一条路由）。 */
const SELF_RELOAD_USAGE = `  ${hub} self-reload [--build]                              ${PRODUCT_ID} 自身代码合进来后热重启守护进程：立即返回，等所有会话这一轮收尾、
                                                          全库空闲后自动重启（调它的这一轮也要先结束）；--build 先在后台构建网页，失败就取消、不重启`;

/**
 * hub 用法（hub help、未知顶层命令或环境变量缺失时打印），人和 agent 都看。给项目经理的提示词里另有一份精简的：daemon/prompt.ts 的 HUB_USAGE_PROMPT，
 * 那里项目、性格设定、定时任务、总助、热重启各只留一行，参数让它用 hub help 查；所以这几组的参数和注意事项要在这里写全。改一份，记得看另一份。
 */
export const HUB_USAGE = `用法：
${HUB_COMMAND_SPECS.map((s) => s.usage).join("\n")}
${SELF_RELOAD_USAGE}

长文本用 --stdin 从标准输入读，例如：
  ${hub} persona edit --stdin <<'EOF'
  新的完整性格设定
  EOF
  ${hub} worker start --title "修 X" --stdin <<'EOF'
  任务说明：目标、验收标准
  EOF
  ${hub} schedule add --name "每日汇报" --daily 09:00 --stdin <<'EOF'
  每次要做的事
  EOF
令牌和 socket 路径由 ${hub} 自己从环境变量 ${ENV_HUB_TOKEN}、${ENV_HUB_SOCK} 读，命令里不要写变量。
`;

const DISPATCH_USAGE = `  ${hub} dispatch pm --device <self|deviceId> --pm <pmId> [--verbatim | --stdin]
  ${hub} dispatch worker-start --device <self|deviceId> --project <projectId> --title <标题> [--vendor <${AGENT_VENDORS.join("|")}>] [--model <模型>] [--effort <${ALL_EFFORTS.join("|")}>] [--readonly] [--no-worktree] [--verbatim | --stdin]
  ${hub} dispatch worker-stop --device <self|deviceId> --worker <workerId>
  ${hub} dispatch worker-send --device <self|deviceId> --worker <workerId> [--verbatim | --stdin]
  ${hub} dispatch worker-end --device <self|deviceId> --worker <workerId>
  ${hub} dispatch worker-list --device <self|deviceId> [--project <projectId>]
  ${hub} dispatch project-create --device <self|deviceId> --folder <路径> [--name <项目名>] [--pm-name <PM名>] [--vendor <${AGENT_VENDORS.join("|")}>] [--mode ${PM_MODES.join("|")}]`;

/** 当第一个词已认出命令组（或进一步认出子命令）时，只输出对应那几行用法 + help 提示；否则输出完整 HUB_USAGE。 */
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

/** 守护进程没开：只说 network 那句话和怎么办，不带 ENOENT、ECONNREFUSED 这类系统码。 */
const UNREACHABLE_MESSAGE = `${LOCAL_ERRORS.network.text}。${LOCAL_ERRORS.network.hint}`;
/** hub 自己出了意外的错（退出码 internal）：不打堆栈和异常原文。 */
const INTERNAL_MESSAGE = "出了意外的错，这条命令没有跑完。重试一次；还不行，把现象告诉用户";
/** post 里超时的原因；别的原因是系统码（ECONNRESET 之类），不打给人看。 */
const TIMEOUT_REASON = "超时";
const NO_ANSWER_MESSAGE = `请求已经发给 ${PRODUCT_ID}，但没等到回应`;
const MAYBE_EXECUTED_HINT = `请求可能已经执行，请先用 \`${hub} status\` 确认，别直接重试`;

class UsageError extends Error {}

/** node 的 parseArgs 报错（英文）→ 中文，按 err.code 分；认不出的给一句通用的话，原文不外送。 */
function describeParseError(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  const message = err instanceof Error ? err.message : "";
  const quoted = /'(-[^'\s<]+)/.exec(message)?.[1] ?? "";
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") return `不认识的参数 ${quoted}`;
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    return message.includes("does not take an argument") ? `${quoted} 不带值` : `${quoted} 后面要跟一个值`;
  }
  if (code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL") return "多了不认识的参数";
  return "参数的写法不对";
}

type Options = {
  name?: string;
  folder?: string;
  description?: string;
  text?: string;
  stdin?: boolean;
  mode?: string;
  reason?: string;
  title?: string;
  vendor?: string;
  refresh?: boolean;
  model?: string;
  effort?: string;
  "max-time"?: string;
  readonly?: boolean;
  "no-worktree"?: boolean;
  node?: string;
  graph?: string;
  incomplete?: boolean;
  question?: string;
  context?: string;
  replace?: string;
  summary?: string;
  pr?: string;
  worker?: string;
  file?: string;
  link?: string[];
  all?: boolean;
  status?: string;
  recommended?: string;
  commit?: string;
  branch?: string;
  choice?: string;
  note?: string;
  clear?: boolean;
  daily?: string;
  every?: string;
  last?: string;
  stats?: boolean;
  limit?: string;
  task?: boolean;
  report?: boolean;
  option?: string[];
  device?: string;
  pm?: string;
  project?: string;
  verbatim?: boolean;
  "pm-name"?: string;
  build?: boolean;
  help?: boolean;
};

/** 解析好的一条命令：body 里的 text 字段留到读完标准输入再填。 */
interface Parsed {
  command: HubCommand | "router.dispatch" | "self.reload";
  body: Record<string, unknown>;
  /** 正文从哪来：--stdin、--text 或没有。 */
  textSource: { kind: "stdin" } | { kind: "inline"; value: string } | null;
  /** 正文放进 body 的哪个字段。 */
  textField?: "text" | "task" | "command" | "prompt" | "context" | "summary" | "specJson" | "summaryMd" | "question";
  /** 若同时给了行内首句与 --stdin，拼在 stdin 前面。 */
  textPrefix?: string;
}

function expandPath(raw: string, env: HubIo["env"], cwd: string): string {
  if (raw === "") throw new UsageError("路径不能是空的");
  if (raw === "~" || raw.startsWith("~/")) {
    const home = env.HOME;
    if (home === undefined || home === "") throw new UsageError("路径以 ~ 开头，但没有设 HOME");
    return resolve(home, raw.slice(2));
  }
  return resolve(cwd, raw);
}

function allowOnly(values: Options, allowed: (keyof Options)[], what: string): void {
  for (const key of Object.keys(values) as (keyof Options)[]) {
    if (values[key] !== undefined && !allowed.includes(key)) throw new UsageError(`${hub} ${what} 不认 --${key}`);
  }
}

function expectPositionals(positionals: string[], count: number, what: string): void {
  if (positionals.length !== count) throw new UsageError(`${hub} ${what} 的参数个数不对`);
}

/** Worker、定时任务的编号：正整数。 */
function idOf(raw: string | undefined, what: string, label: string): number {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new UsageError(`${hub} ${what} 要一个${label}编号（正整数）`);
  }
  return Number(raw);
}
const workerIdOf = (raw: string | undefined, what: string) => idOf(raw, what, " Worker ");

function maxTimeMsOf(raw: string): number {
  const parsed = parseWorkerMaxTime(raw);
  if (!parsed.ok) throw new UsageError(parsed.error);
  return parsed.maxTimeMs;
}

/** hub worker start、send，schedule add 的正文只从标准输入读。 */
function requireStdin(values: Options, what: string): Parsed["textSource"] {
  if (values.stdin !== true) throw new UsageError(`${hub} ${what} 要 --stdin，正文从标准输入读`);
  return { kind: "stdin" };
}

function textSourceOf(values: Options): Parsed["textSource"] {
  if (values.stdin === true && values.text !== undefined) throw new UsageError("--stdin 和 --text 只能用一个");
  if (values.stdin === true) return { kind: "stdin" };
  if (values.text !== undefined) return { kind: "inline", value: values.text };
  return null;
}

function parseCommand(argv: string[], env: HubIo["env"], cwd: string): Parsed | "help" {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        name: { type: "string" },
        folder: { type: "string" },
        description: { type: "string" },
        text: { type: "string" },
        stdin: { type: "boolean" },
        mode: { type: "string" },
        reason: { type: "string" },
        title: { type: "string" },
        vendor: { type: "string" },
        refresh: { type: "boolean" },
        model: { type: "string" },
        effort: { type: "string" },
        "max-time": { type: "string" },
        readonly: { type: "boolean" },
        "no-worktree": { type: "boolean" },
        node: { type: "string" },
        graph: { type: "string" },
        incomplete: { type: "boolean" },
        question: { type: "string" },
        context: { type: "string" },
        replace: { type: "string" },
        summary: { type: "string" },
        pr: { type: "string" },
        worker: { type: "string" },
        file: { type: "string" },
        link: { type: "string", multiple: true },
        all: { type: "boolean" },
        status: { type: "string" },
        recommended: { type: "string" },
        commit: { type: "string" },
        branch: { type: "string" },
        choice: { type: "string" },
        note: { type: "string" },
        clear: { type: "boolean" },
        daily: { type: "string" },
        every: { type: "string" },
        last: { type: "string" },
        stats: { type: "boolean" },
        limit: { type: "string" },
        task: { type: "boolean" },
        report: { type: "boolean" },
        option: { type: "string", multiple: true },
        device: { type: "string" },
        pm: { type: "string" },
        project: { type: "string" },
        verbatim: { type: "boolean" },
        "pm-name": { type: "string" },
        build: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    throw new UsageError(describeParseError(err));
  }
  const values = parsed.values as Options;
  const [group, action, ...rest] = parsed.positionals;
  if (values.help === true || group === "help") return "help";
  if (group === undefined) throw new UsageError("缺子命令");

  if (group === "status") {
    allowOnly(values, [], "status");
    expectPositionals(parsed.positionals.slice(1), 0, "status");
    return { command: "status", body: {}, textSource: null };
  }
  if (group === "self-reload") {
    allowOnly(values, ["build"], "self-reload");
    expectPositionals(parsed.positionals.slice(1), 0, "self-reload");
    return { command: "self.reload", body: values.build === true ? { build: true } : {}, textSource: null };
  }
  if (group === "models") {
    allowOnly(values, ["vendor", "refresh"], "models");
    expectPositionals(parsed.positionals.slice(1), 0, "models");
    if (values.vendor !== undefined && !isAgentVendor(values.vendor)) {
      throw new UsageError(`--vendor 只能是 ${AGENT_VENDORS.join("、")}`);
    }
    const body: Record<string, unknown> = {};
    if (values.vendor !== undefined) body.vendor = values.vendor;
    if (values.refresh === true) body.refresh = true;
    return { command: "models", body, textSource: null };
  }
  if (group === "project" && action === "create") {
    allowOnly(values, ["name", "folder", "description"], "project create");
    expectPositionals(rest, 0, "project create");
    if (values.folder === undefined) throw new UsageError(`${hub} project create 要 --folder <主文件夹>`);
    const body: Record<string, unknown> = { folder: expandPath(values.folder, env, cwd) };
    if (values.name !== undefined) body.name = values.name;
    if (values.description !== undefined) body.description = values.description;
    return { command: "project.create", body, textSource: null };
  }
  if (group === "project" && (action === "attach" || action === "detach")) {
    allowOnly(values, [], `project ${action}`);
    expectPositionals(rest, 1, `project ${action}`);
    return { command: `project.${action}`, body: { folder: expandPath(rest[0] as string, env, cwd) }, textSource: null };
  }
  if (group === "project" && action === "setup") {
    allowOnly(values, ["stdin", "clear"], "project setup");
    expectPositionals(rest, 0, "project setup");
    if (values.stdin === true && values.clear === true) throw new UsageError("--stdin 和 --clear 只能用一个");
    if (values.clear === true) return { command: "project.setup", body: { command: null }, textSource: null };
    if (values.stdin !== true) throw new UsageError(`${hub} project setup 要 --stdin（准备命令从标准输入读）或 --clear（清除）`);
    return { command: "project.setup", body: {}, textSource: { kind: "stdin" }, textField: "command" };
  }
  if (group === "persona" && action === "show") {
    allowOnly(values, [], "persona show");
    expectPositionals(rest, 0, "persona show");
    return { command: "persona.show", body: {}, textSource: null };
  }
  if (group === "persona" && action === "edit") {
    allowOnly(values, ["mode", "reason", "text", "stdin"], "persona edit");
    expectPositionals(rest, 0, "persona edit");
    if (values.mode !== undefined && !(PM_MODES as readonly string[]).includes(values.mode)) {
      throw new UsageError(`--mode 只能是 ${PM_MODES.join(" 或 ")}`);
    }
    const textSource = textSourceOf(values);
    if (textSource === null && values.mode === undefined) {
      throw new UsageError(`${hub} persona edit 要新的性格设定（--stdin 或 --text）或者 --mode，至少一样`);
    }
    const body: Record<string, unknown> = {};
    if (values.mode !== undefined) body.mode = values.mode as PmMode;
    if (values.reason !== undefined) body.reason = values.reason;
    return { command: "persona.edit", body, textSource, textField: "text" };
  }
  if (group === "worker" && action === "start") {
    allowOnly(
      values,
      ["title", "vendor", "model", "effort", "max-time", "readonly", "no-worktree", "node", "graph", "stdin"],
      "worker start",
    );
    expectPositionals(rest, 0, "worker start");
    if (values.title === undefined) throw new UsageError(`${hub} worker start 要 --title <标题>`);
    if (values.vendor !== undefined && !isAgentVendor(values.vendor)) {
      throw new UsageError(`--vendor 只能是 ${AGENT_VENDORS.join("、")}`);
    }
    if (values.effort !== undefined && !ALL_EFFORTS.includes(values.effort)) {
      throw new UsageError(`--effort 只能是 ${ALL_EFFORTS.join("、")}`);
    }
    if (values.graph !== undefined && values.node === undefined) {
      throw new UsageError(`${hub} worker start 传 --graph 时要同时传 --node <节点>`);
    }
    const body: Record<string, unknown> = { title: values.title };
    if (values.vendor !== undefined) body.vendor = values.vendor;
    if (values.model !== undefined) body.model = values.model;
    if (values.effort !== undefined) body.effort = values.effort;
    if (values["max-time"] !== undefined) body.maxTimeMs = maxTimeMsOf(values["max-time"]);
    if (values.readonly === true) body.readonly = true;
    if (values["no-worktree"] === true) body.noWorktree = true;
    if (values.node !== undefined) {
      if (values.node.trim() === "") throw new UsageError("--node 不能是空的");
      body.node = values.node.trim();
    }
    if (values.graph !== undefined) body.graphId = idOf(values.graph, "worker start", "任务图");
    const textSource = requireStdin(values, "worker start");
    return { command: "worker.start", body, textSource, textField: "task" };
  }
  if (group === "worker" && action === "send") {
    allowOnly(values, ["max-time", "stdin"], "worker send");
    expectPositionals(rest, 1, "worker send");
    const workerId = workerIdOf(rest[0], "worker send");
    const body: Record<string, unknown> = { workerId };
    if (values["max-time"] !== undefined) body.maxTimeMs = maxTimeMsOf(values["max-time"]);
    return { command: "worker.send", body, textSource: requireStdin(values, "worker send"), textField: "text" };
  }
  if (group === "worker" && action === "max-time") {
    allowOnly(values, [], "worker max-time");
    expectPositionals(rest, 2, "worker max-time");
    const workerId = workerIdOf(rest[0], "worker max-time");
    const maxTimeMs = maxTimeMsOf(rest[1] ?? "");
    return { command: "worker.max-time", body: { workerId, maxTimeMs }, textSource: null };
  }
  if (group === "worker" && action === "end") {
    allowOnly(values, ["incomplete"], "worker end");
    expectPositionals(rest, 1, "worker end");
    const body: Record<string, unknown> = { workerId: workerIdOf(rest[0], "worker end") };
    if (values.incomplete === true) body.incomplete = true;
    return { command: "worker.end", body, textSource: null };
  }
  if (group === "ask") {
    allowOnly(values, ["option", "stdin"], "ask");
    expectPositionals(parsed.positionals.slice(1), 0, "ask");
    const body: Record<string, unknown> = {};
    if (values.option !== undefined) {
      const checked = validateAskOptions(values.option);
      if (!checked.ok) throw new UsageError(checked.error);
      body.options = checked.options;
    }
    return { command: "ask", body, textSource: requireStdin(values, "ask"), textField: "text" };
  }
  if (group === "worker" && action === "list") {
    allowOnly(values, [], "worker list");
    expectPositionals(rest, 0, "worker list");
    return { command: "worker.list", body: {}, textSource: null };
  }
  if (group === "worker" && action === "show") {
    allowOnly(values, ["task", "report"], "worker show");
    if (values.task === true && values.report === true) throw new UsageError("--task 和 --report 只能用一个");
    // --report 后面可以跟一个 N（第几轮汇报，从旧到新），写在编号后面
    expectPositionals(rest, values.report === true && rest.length === 2 ? 2 : 1, "worker show");
    const body: Record<string, unknown> = { workerId: workerIdOf(rest[0], "worker show") };
    if (values.task === true) body.task = true;
    if (values.report === true) {
      if (rest[1] !== undefined && (!/^[1-9][0-9]*$/.test(rest[1]) || !Number.isSafeInteger(Number(rest[1])))) {
        throw new UsageError("--report 后面的 N 要写正整数（第几轮汇报，和 search 里的“汇报 #N”一致）");
      }
      body.report = rest[1] === undefined ? "latest" : Number(rest[1]);
    }
    return { command: "worker.show", body, textSource: null };
  }
  if (group === "worker" && action === "search") {
    allowOnly(values, ["limit"], "worker search");
    if (rest.length === 0) throw new UsageError(`${hub} worker search 要至少一个关键词`);
    const body: Record<string, unknown> = { keywords: rest };
    if (values.limit !== undefined) {
      if (!/^[1-9][0-9]*$/.test(values.limit) || Number(values.limit) > WORKER_SEARCH_MAX_LIMIT) {
        throw new UsageError(`--limit 要写 1 到 ${WORKER_SEARCH_MAX_LIMIT} 之间的整数`);
      }
      body.limit = Number(values.limit);
    }
    return { command: "worker.search", body, textSource: null };
  }
  if (group === "worker" && action === "log") {
    allowOnly(values, ["last", "stats"], "worker log");
    expectPositionals(rest, 1, "worker log");
    const body: Record<string, unknown> = { workerId: workerIdOf(rest[0], "worker log") };
    if (values.stats === true) {
      if (values.last !== undefined) throw new UsageError("--stats 汇总全部步骤，不能和 --last 一起用");
      body.stats = true;
      return { command: "worker.log", body, textSource: null };
    }
    if (values.last !== undefined) {
      if (!/^[1-9][0-9]*$/.test(values.last) || Number(values.last) > WORKER_LOG_MAX_STEPS) {
        throw new UsageError(`--last 要写 1 到 ${WORKER_LOG_MAX_STEPS} 之间的整数`);
      }
      body.last = Number(values.last);
    }
    return { command: "worker.log", body, textSource: null };
  }
  if (group === "schedule" && action === "add") {
    allowOnly(values, ["name", "daily", "every", "stdin"], "schedule add");
    expectPositionals(rest, 0, "schedule add");
    if (values.name === undefined) throw new UsageError(`${hub} schedule add 要 --name <名>`);
    if ((values.daily === undefined) === (values.every === undefined)) {
      throw new UsageError(`${hub} schedule add 的频率要写 --daily HH:MM 或 --every 30m|2h，二选一`);
    }
    const body: Record<string, unknown> = { name: values.name };
    if (values.daily !== undefined) {
      if (parseDailyTime(values.daily) === null) throw new UsageError("--daily 要写成 HH:MM（24 小时制，如 09:00）");
      body.daily = values.daily;
    } else {
      const minutes = parseEvery(values.every!);
      if (minutes === null) throw new UsageError("--every 要写成 30m（分钟）或 2h（小时）");
      const bad = checkEveryMinutes(minutes);
      if (bad !== null) throw new UsageError(`--every：${bad}`);
      body.everyMinutes = minutes;
    }
    return { command: "schedule.add", body, textSource: requireStdin(values, "schedule add"), textField: "prompt" };
  }
  if (group === "schedule" && action === "list") {
    allowOnly(values, [], "schedule list");
    expectPositionals(rest, 0, "schedule list");
    return { command: "schedule.list", body: {}, textSource: null };
  }
  if (group === "schedule" && (action === "pause" || action === "resume" || action === "remove")) {
    allowOnly(values, [], `schedule ${action}`);
    expectPositionals(rest, 1, `schedule ${action}`);
    return { command: `schedule.${action}`, body: { scheduleId: idOf(rest[0], `schedule ${action}`, "定时任务") }, textSource: null };
  }
  if (group === "router" && action === "ask") {
    allowOnly(values, ["question", "option", "recommended", "replace", "context", "stdin"], "router ask");
    expectPositionals(rest, 0, "router ask");
    if (values.question === undefined || values.question.trim() === "") {
      throw new UsageError(`${hub} router ask 要 --question <问题>`);
    }
    if (values.option === undefined) {
      throw new UsageError(`${hub} router ask 要 --option <选项>（2 到 ${ROUTER_OPTION_MAX_COUNT} 个）`);
    }
    const checked = validateAskOptions(values.option);
    if (!checked.ok) throw new UsageError(checked.error);
    if (checked.options.length > ROUTER_OPTION_MAX_COUNT) {
      throw new UsageError(`选项最多 ${ROUTER_OPTION_MAX_COUNT} 个`);
    }
    const options = [...checked.options];
    if (values.recommended !== undefined) {
      const rec = values.recommended.trim();
      let idx = -1;
      if (/^[1-9][0-9]*$/.test(rec)) {
        const oneBased = Number(rec);
        if (oneBased >= 1 && oneBased <= options.length) idx = oneBased - 1;
      } else {
        idx = options.indexOf(rec);
      }
      if (idx < 0) throw new UsageError(`--recommended 要写 1 到 ${options.length} 或某个选项原文`);
      if (idx > 0) {
        const [picked] = options.splice(idx, 1);
        options.unshift(picked!);
      }
    }
    if (values.stdin === true && values.context !== undefined) {
      throw new UsageError("--stdin 和 --context 只能用一个");
    }
    const body: Record<string, unknown> = { question: values.question.trim(), options };
    if (values.replace !== undefined) body.replaceItemId = idOf(values.replace, "router ask", "卡片");
    const textSource =
      values.stdin === true
        ? ({ kind: "stdin" } as const)
        : values.context !== undefined
          ? ({ kind: "inline", value: values.context } as const)
          : null;
    return { command: "router.ask", body, textSource, textField: "context" };
  }
  if (group === "router" && action === "report") {
    allowOnly(values, ["summary", "pr", "worker", "file", "link", "stdin"], "router report");
    expectPositionals(rest, 0, "router report");
    if (values.summary === undefined && values.stdin !== true) {
      throw new UsageError(`${hub} router report 要 --summary <摘要> 或 --stdin`);
    }
    if (values.summary !== undefined && values.summary.trim() === "") {
      throw new UsageError("--summary 不能是空的");
    }
    const links: RouterReportLink[] = [];
    if (values.pr !== undefined) {
      const prUrl = values.pr.trim();
      if (prUrl === "") throw new UsageError("--pr 不能是空的");
      const prNum = /\/pull\/([1-9][0-9]*)(?:$|[/?#])/.exec(prUrl)?.[1];
      links.push({ label: prNum !== undefined ? `PR #${prNum}` : "PR", target: prUrl });
    }
    if (values.worker !== undefined) {
      const wid = workerIdOf(values.worker, "router report");
      links.push({ label: `Worker #${wid}`, target: `worker:${wid}` });
    }
    if (values.file !== undefined) {
      const fp = values.file.trim();
      if (fp === "") throw new UsageError("--file 不能是空的");
      links.push({ label: basename(fp) || fp, target: fp });
    }
    if (values.link !== undefined) {
      for (const rawLink of values.link) {
        const eq = rawLink.indexOf("=");
        if (eq <= 0 || eq === rawLink.length - 1) throw new UsageError("--link 要写成 标签=地址");
        const label = rawLink.slice(0, eq).trim();
        const target = rawLink.slice(eq + 1).trim();
        if (label === "" || target === "") throw new UsageError("--link 要写成 标签=地址");
        links.push({ label, target });
      }
    }
    const body: Record<string, unknown> = {};
    if (links.length > 0) body.links = links;
    if (values.stdin === true) {
      return {
        command: "router.report",
        body,
        textSource: { kind: "stdin" },
        textField: "summary",
        ...(values.summary !== undefined ? { textPrefix: values.summary.trim() } : {}),
      };
    }
    body.summary = values.summary!.trim();
    return { command: "router.report", body, textSource: null };
  }
  if (group === "router" && action === "note") {
    allowOnly(values, ["text", "stdin", "clear"], "router note");
    expectPositionals(rest, 0, "router note");
    if (values.clear === true) {
      if (values.stdin === true || values.text !== undefined) {
        throw new UsageError("--clear 不能和 --stdin 或 --text 一起用");
      }
      return { command: "router.note", body: { clear: true }, textSource: null };
    }
    const textSource = textSourceOf(values);
    if (textSource === null) throw new UsageError(`${hub} router note 要 --text <备忘>、--stdin 或 --clear`);
    return { command: "router.note", body: {}, textSource, textField: "text" };
  }
  if (group === "graph" && action === "create") {
    allowOnly(values, ["title", "stdin"], "graph create");
    expectPositionals(rest, 0, "graph create");
    const body: Record<string, unknown> = {};
    if (values.title !== undefined) body.title = values.title;
    return { command: "graph.create", body, textSource: requireStdin(values, "graph create"), textField: "specJson" };
  }
  if (group === "graph" && action === "show") {
    allowOnly(values, [], "graph show");
    if (rest.length > 1) throw new UsageError(`${hub} graph show 的参数个数不对`);
    const body: Record<string, unknown> = {};
    if (rest[0] !== undefined) body.graphId = idOf(rest[0], "graph show", "任务图");
    return { command: "graph.show", body, textSource: null };
  }
  if (group === "graph" && action === "list") {
    allowOnly(values, ["all", "status"], "graph list");
    expectPositionals(rest, 0, "graph list");
    if (values.all === true && values.status !== undefined) {
      throw new UsageError("--all 和 --status 只能用一个");
    }
    const body: Record<string, unknown> = {};
    if (values.all === true) body.all = true;
    if (values.status !== undefined) {
      if (!(TASK_GRAPH_STATUSES as readonly string[]).includes(values.status)) {
        throw new UsageError(`--status 只能是 ${TASK_GRAPH_STATUSES.join("、")}`);
      }
      body.status = values.status;
    }
    return { command: "graph.list", body, textSource: null };
  }
  if (group === "graph" && action === "ask") {
    allowOnly(values, ["graph", "question", "option", "recommended", "stdin"], "graph ask");
    expectPositionals(rest, 1, "graph ask");
    const nodeKey = (rest[0] ?? "").trim();
    if (nodeKey === "") throw new UsageError("节点名称不能是空的");
    const body: Record<string, unknown> = { nodeKey };
    if (values.graph !== undefined) body.graphId = idOf(values.graph, "graph ask", "任务图");
    if (values.option !== undefined) {
      const checked = validateAskOptions(values.option);
      if (!checked.ok) throw new UsageError(checked.error);
      body.options = checked.options;
    }
    if (values.recommended !== undefined) body.recommended = values.recommended;
    if (values.question !== undefined) {
      if (values.question.trim() === "") throw new UsageError("--question 不能是空的");
      body.question = values.question.trim();
      return {
        command: "graph.ask",
        body,
        textSource: values.stdin === true ? { kind: "stdin" } : null,
        textField: "summaryMd",
      };
    }
    return { command: "graph.ask", body, textSource: requireStdin(values, "graph ask"), textField: "question" };
  }
  if (group === "graph" && action === "patch") {
    allowOnly(values, ["stdin"], "graph patch");
    if (rest.length > 1) throw new UsageError(`${hub} graph patch 的参数个数不对`);
    const body: Record<string, unknown> = {};
    if (rest[0] !== undefined) body.graphId = idOf(rest[0], "graph patch", "任务图");
    return { command: "graph.patch", body, textSource: requireStdin(values, "graph patch"), textField: "specJson" };
  }
  if (group === "graph" && action === "done") {
    allowOnly(values, ["graph", "pr", "commit", "branch", "summary", "stdin"], "graph done");
    expectPositionals(rest, 1, "graph done");
    if (values.stdin === true && values.summary !== undefined) {
      throw new UsageError("--stdin 和 --summary 只能用一个");
    }
    const nodeKey = (rest[0] ?? "").trim();
    if (nodeKey === "") throw new UsageError("节点名称不能是空的");
    const body: Record<string, unknown> = { nodeKey };
    if (values.graph !== undefined) body.graphId = idOf(values.graph, "graph done", "任务图");
    if (values.pr !== undefined) body.prUrl = values.pr;
    if (values.commit !== undefined) body.commit = values.commit;
    if (values.branch !== undefined) body.branch = values.branch;
    const textSource =
      values.stdin === true
        ? ({ kind: "stdin" } as const)
        : values.summary !== undefined
          ? ({ kind: "inline", value: values.summary } as const)
          : null;
    return { command: "graph.done", body, textSource, textField: "summary" };
  }
  if (group === "graph" && action === "decide") {
    allowOnly(values, ["graph", "choice", "note"], "graph decide");
    expectPositionals(rest, 1, "graph decide");
    if (values.choice === undefined || values.choice.trim() === "") {
      throw new UsageError(`${hub} graph decide 要 --choice <选项>`);
    }
    const nodeKey = (rest[0] ?? "").trim();
    if (nodeKey === "") throw new UsageError("节点名称不能是空的");
    const body: Record<string, unknown> = { nodeKey, choice: values.choice.trim() };
    if (values.graph !== undefined) body.graphId = idOf(values.graph, "graph decide", "任务图");
    if (values.note !== undefined) body.note = values.note;
    return { command: "graph.decide", body, textSource: null };
  }
  if (group === "graph" && action === "skip") {
    allowOnly(values, ["graph", "reason"], "graph skip");
    expectPositionals(rest, 1, "graph skip");
    const nodeKey = (rest[0] ?? "").trim();
    if (nodeKey === "") throw new UsageError("节点名称不能是空的");
    const body: Record<string, unknown> = { nodeKey };
    if (values.graph !== undefined) body.graphId = idOf(values.graph, "graph skip", "任务图");
    if (values.reason !== undefined) body.reason = values.reason;
    return { command: "graph.skip", body, textSource: null };
  }
  if (group === "graph" && action === "cancel") {
    allowOnly(values, ["reason"], "graph cancel");
    if (rest.length > 1) throw new UsageError(`${hub} graph cancel 的参数个数不对`);
    const body: Record<string, unknown> = {};
    if (rest[0] !== undefined) body.graphId = idOf(rest[0], "graph cancel", "任务图");
    if (values.reason !== undefined) body.reason = values.reason;
    return { command: "graph.cancel", body, textSource: null };
  }
  if (group === "dispatch") {
    const requireDevice = (what: string): string => {
      const dev = values.device?.trim() ?? "";
      if (dev === "") throw new UsageError(`${hub} ${what} 要 --device <self|deviceId>`);
      return dev;
    };
    const requireVerbatimOrStdin = (what: string): boolean => {
      if (values.verbatim === true && values.stdin === true) {
        throw new UsageError("--verbatim 和 --stdin 只能用一个");
      }
      if (values.verbatim !== true && values.stdin !== true) {
        throw new UsageError(`${hub} ${what} 要 --verbatim 或 --stdin`);
      }
      return values.verbatim === true;
    };
    if (action === "pm") {
      allowOnly(values, ["device", "pm", "project", "verbatim", "stdin"], "dispatch pm");
      expectPositionals(rest, 0, "dispatch pm");
      const device = requireDevice("dispatch pm");
      if (values.pm === undefined && values.project === undefined) {
        throw new UsageError(`${hub} dispatch pm 要 --pm <pmId>（或 --project <projectId>）`);
      }
      const verbatim = requireVerbatimOrStdin("dispatch pm");
      const body: Record<string, unknown> = { op: "pm", device };
      if (values.pm !== undefined) body.pmId = idOf(values.pm, "dispatch pm", "项目经理");
      if (values.project !== undefined) body.projectId = idOf(values.project, "dispatch pm", "项目");
      if (verbatim) {
        body.verbatim = true;
        return { command: "router.dispatch", body, textSource: null };
      }
      return { command: "router.dispatch", body, textSource: { kind: "stdin" }, textField: "text" };
    }
    if (action === "worker-start") {
      allowOnly(
        values,
        ["device", "project", "title", "vendor", "model", "effort", "readonly", "no-worktree", "verbatim", "stdin"],
        "dispatch worker-start",
      );
      expectPositionals(rest, 0, "dispatch worker-start");
      const device = requireDevice("dispatch worker-start");
      if (values.project === undefined) throw new UsageError(`${hub} dispatch worker-start 要 --project <projectId>`);
      const projectId = idOf(values.project, "dispatch worker-start", "项目");
      const title = values.title?.trim() ?? "";
      if (title === "") throw new UsageError(`${hub} dispatch worker-start 要 --title <标题>`);
      if (values.vendor !== undefined && !isAgentVendor(values.vendor)) {
        throw new UsageError(`--vendor 只能是 ${AGENT_VENDORS.join("、")}`);
      }
      if (values.effort !== undefined && !ALL_EFFORTS.includes(values.effort)) {
        throw new UsageError(`--effort 只能是 ${ALL_EFFORTS.join("、")}`);
      }
      const verbatim = requireVerbatimOrStdin("dispatch worker-start");
      const body: Record<string, unknown> = { op: "worker-start", device, projectId, title };
      if (values.vendor !== undefined) body.vendor = values.vendor;
      if (values.model !== undefined) body.model = values.model;
      if (values.effort !== undefined) body.effort = values.effort;
      if (values.readonly === true) body.readonly = true;
      if (values["no-worktree"] === true) body.noWorktree = true;
      if (verbatim) {
        body.verbatim = true;
        return { command: "router.dispatch", body, textSource: null };
      }
      return { command: "router.dispatch", body, textSource: { kind: "stdin" }, textField: "task" };
    }
    if (action === "worker-stop") {
      allowOnly(values, ["device", "worker"], "dispatch worker-stop");
      expectPositionals(rest, 0, "dispatch worker-stop");
      const device = requireDevice("dispatch worker-stop");
      const workerId = workerIdOf(values.worker, "dispatch worker-stop");
      return { command: "router.dispatch", body: { op: "worker-stop", device, workerId }, textSource: null };
    }
    if (action === "worker-send") {
      allowOnly(values, ["device", "worker", "verbatim", "stdin"], "dispatch worker-send");
      expectPositionals(rest, 0, "dispatch worker-send");
      const device = requireDevice("dispatch worker-send");
      const workerId = workerIdOf(values.worker, "dispatch worker-send");
      const verbatim = requireVerbatimOrStdin("dispatch worker-send");
      const body: Record<string, unknown> = { op: "worker-send", device, workerId };
      if (verbatim) {
        body.verbatim = true;
        return { command: "router.dispatch", body, textSource: null };
      }
      return { command: "router.dispatch", body, textSource: { kind: "stdin" }, textField: "text" };
    }
    if (action === "worker-end") {
      allowOnly(values, ["device", "worker"], "dispatch worker-end");
      expectPositionals(rest, 0, "dispatch worker-end");
      const device = requireDevice("dispatch worker-end");
      const workerId = workerIdOf(values.worker, "dispatch worker-end");
      return { command: "router.dispatch", body: { op: "worker-end", device, workerId }, textSource: null };
    }
    if (action === "worker-list") {
      allowOnly(values, ["device", "project"], "dispatch worker-list");
      expectPositionals(rest, 0, "dispatch worker-list");
      const device = requireDevice("dispatch worker-list");
      const body: Record<string, unknown> = { op: "worker-list", device };
      if (values.project !== undefined) body.projectId = idOf(values.project, "dispatch worker-list", "项目");
      return { command: "router.dispatch", body, textSource: null };
    }
    if (action === "project-create") {
      allowOnly(values, ["device", "folder", "name", "pm-name", "vendor", "mode"], "dispatch project-create");
      expectPositionals(rest, 0, "dispatch project-create");
      const device = requireDevice("dispatch project-create");
      if (values.folder === undefined || values.folder.trim() === "") {
        throw new UsageError(`${hub} dispatch project-create 要 --folder <路径>`);
      }
      if (values.vendor !== undefined && !isAgentVendor(values.vendor)) {
        throw new UsageError(`--vendor 只能是 ${AGENT_VENDORS.join("、")}`);
      }
      if (values.mode !== undefined && !(PM_MODES as readonly string[]).includes(values.mode)) {
        throw new UsageError(`--mode 只能是 ${PM_MODES.join(" 或 ")}`);
      }
      const rawFolder = values.folder.trim();
      let folder: string;
      if (device === "self") {
        folder = expandPath(rawFolder, env, cwd);
      } else {
        if (!rawFolder.startsWith("/") && rawFolder !== "~" && !rawFolder.startsWith("~/")) {
          throw new UsageError("远端设备 --folder 要写绝对路径或 ~/...");
        }
        folder = rawFolder;
      }
      const body: Record<string, unknown> = { op: "project-create", device, folder };
      if (values.name !== undefined) body.name = values.name;
      if (values["pm-name"] !== undefined) body.pmName = values["pm-name"];
      if (values.vendor !== undefined) body.vendor = values.vendor;
      if (values.mode !== undefined) body.mode = values.mode;
      return { command: "router.dispatch", body, textSource: null };
    }
  }
  throw new UsageError(`不认识的子命令：${[group, action].filter((s) => s !== undefined).join(" ")}`);
}

/**
 * 读到结束，去掉末尾一个换行（\n 或 \r\n）。超过请求体上限、idleMs 没收到数据、不是合法 UTF-8，都报用法错；
 * 前两种不再读，把流关掉。
 */
function readAllStdin(stream: Readable, idleMs: number): Promise<string> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: { text: string } | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off("data", onData).off("end", onEnd).off("error", onError);
      if (result instanceof Error) {
        stream.destroy();
        fail(result);
      } else {
        done(result.text);
      }
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new UsageError("标准输入一直没有结束，记得用 heredoc（<<'EOF' … EOF）把正文喂给 --stdin")), idleMs);
    };
    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      size += buf.length;
      if (size > HUB_MAX_BODY_BYTES) return finish(new UsageError(`标准输入太长，不能超过 ${HUB_MAX_BODY_BYTES} 字节`));
      chunks.push(buf);
      arm();
    };
    const onEnd = () => {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        return finish(new UsageError("标准输入不是合法的 UTF-8"));
      }
      if (text.endsWith("\r\n")) text = text.slice(0, -2);
      else if (text.endsWith("\n")) text = text.slice(0, -1);
      finish({ text });
    };
    const onError = (err: Error) => finish(new UsageError(`读标准输入出错：${err.message}`));
    stream.on("data", onData).on("end", onEnd).on("error", onError);
    arm();
  });
}

type Outcome =
  | { kind: "response"; status: number; body: string }
  /** 请求没发完就失败了：守护进程没收到。 */
  | { kind: "unreachable"; reason: string }
  /** 请求发完了，但没等到完整的回应：可能已经执行。 */
  | { kind: "no-answer"; reason: string }
  /** 本地就没发出去（request() 自己抛错）。 */
  | { kind: "not-sent"; reason: string };

function post(socketPath: string, path: string, token: string, payload: string, timeoutMs: number): Promise<Outcome> {
  return new Promise((done) => {
    let settled = false;
    let sent = false;
    const finish = (outcome: Outcome) => {
      if (!settled) {
        settled = true;
        done(outcome);
      }
    };
    const lost = (reason: string): Outcome => (sent ? { kind: "no-answer", reason } : { kind: "unreachable", reason });
    const options = {
      socketPath,
      method: "POST",
      path,
      timeout: timeoutMs,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload, "utf8"),
      },
    };
    let req: ClientRequest;
    try {
      req = request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => finish({ kind: "response", status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (err) => finish({ kind: "no-answer", reason: err.message }));
      });
    } catch (err) {
      // 例如请求头里有非法字符：Node 同步抛错。错误信息不带请求头的值，不会漏令牌。
      finish({ kind: "not-sent", reason: (err as Error).message });
      return;
    }
    // 请求整个交给了内核才算“已发出”：之后再出错，守护进程可能已经收到并执行了。
    req.on("finish", () => (sent = true));
    req.on("timeout", () => {
      finish(lost(TIMEOUT_REASON));
      req.destroy();
    });
    req.on("error", (err: NodeJS.ErrnoException) => finish(lost(err.code ?? err.message)));
    req.end(payload);
  });
}

function line(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

export async function runHub(io: HubIo): Promise<number> {
  const usage = (reason: string, full = false) => {
    io.stderr.write(line(`${hub}：${reason}`));
    io.stderr.write(full ? HUB_USAGE : commandUsageFor(io.argv));
    return HUB_EXIT.usage;
  };

  let parsed: Parsed;
  try {
    const result = parseCommand(io.argv, io.env, io.cwd);
    if (result === "help") {
      io.stdout.write(HUB_USAGE);
      return HUB_EXIT.ok;
    }
    parsed = result;
  } catch (err) {
    if (err instanceof UsageError) return usage(err.message);
    throw err;
  }

  const token = io.env[ENV_HUB_TOKEN];
  const socketPath = io.env[ENV_HUB_SOCK];
  if (token === undefined || token === "") return usage(`没有设 ${ENV_HUB_TOKEN}：${hub} 只能在 ${PRODUCT_ID} 启动的会话里用`, true);
  if (!TOKEN_CHARS.test(token)) return usage(`${ENV_HUB_TOKEN} 里有不该有的字符，不是 ${PRODUCT_ID} 发的令牌`, true);
  if (socketPath === undefined || socketPath === "") return usage(`没有设 ${ENV_HUB_SOCK}：${hub} 只能在 ${PRODUCT_ID} 启动的会话里用`, true);

  const body: Record<string, unknown> = { ...parsed.body };
  if (parsed.textSource !== null && parsed.textField !== undefined) {
    let text: string;
    try {
      text = parsed.textSource.kind === "stdin" ? await readAllStdin(io.stdin(), io.stdinIdleMs ?? HUB_CLI_STDIN_IDLE_MS) : parsed.textSource.value;
    } catch (err) {
      if (err instanceof UsageError) return usage(err.message);
      throw err;
    }
    if (text.trim() === "") {
      return usage(parsed.textSource.kind === "stdin" ? "标准输入读到的正文是空的" : `--${parsed.textField} 的正文是空的`);
    }
    body[parsed.textField] = parsed.textPrefix !== undefined ? `${parsed.textPrefix}\n${text}` : text;
  }

  const routePath =
    parsed.command === "router.dispatch"
      ? ROUTER_DISPATCH_AGENT_PATH
      : parsed.command === "self.reload"
        ? SELF_RELOAD_AGENT_PATH
        : hubPath(parsed.command);
  const outcome = await post(socketPath, routePath, token, JSON.stringify(body), io.timeoutMs ?? HUB_CLI_TIMEOUT_MS);
  if (outcome.kind === "not-sent") return usage("请求没发出去：令牌或参数里有不能放进请求的字符");
  if (outcome.kind === "unreachable") {
    io.stderr.write(`${UNREACHABLE_MESSAGE}\n`);
    return HUB_EXIT.unreachable;
  }
  if (outcome.kind === "no-answer") {
    io.stderr.write(`${NO_ANSWER_MESSAGE}${outcome.reason === TIMEOUT_REASON ? `（${TIMEOUT_REASON}）` : ""}。${MAYBE_EXECUTED_HINT}\n`);
    return HUB_EXIT.unreachable;
  }

  let response: unknown;
  try {
    response = JSON.parse(outcome.body);
  } catch {
    response = null;
  }
  const r = response as { ok?: unknown; text?: unknown; message?: unknown } | null;
  if (r !== null && typeof r === "object" && r.ok === true && typeof r.text === "string") {
    io.stdout.write(line(r.text));
    return HUB_EXIT.ok;
  }
  if (r !== null && typeof r === "object" && r.ok === false && typeof r.message === "string") {
    io.stderr.write(line(r.message));
    return HUB_EXIT.rejected;
  }
  io.stderr.write(`${PRODUCT_ID} 的回答看不懂（HTTP ${outcome.status}）\n`);
  return HUB_EXIT.rejected;
}

/** 入口用：runHub 之外的意外异常也只打一句话、退出码 internal（4），不打堆栈和异常原文。 */
export async function runHubSafely(io: HubIo): Promise<number> {
  try {
    return await runHub(io);
  } catch {
    io.stderr.write(`${hub}：${INTERNAL_MESSAGE}\n`);
    return HUB_EXIT.internal;
  }
}
