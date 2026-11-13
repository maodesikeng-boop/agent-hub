// agent 接口（W2 实现，设计第 4.2、8.1、8.2 节）：agent 在自己的 shell 里敲 `hub ...`，hub 通过 Unix socket
// 请求守护进程，守护进程按会话令牌认人，交给账本的 hubCall。
//
// 请求：POST <hubPath(命令)>，头 `Authorization: Bearer <令牌>`，体是这个命令的参数 JSON（HubArgsMap）。
// 应答：HubResponse，HTTP 状态按 HUB_ERROR_HTTP_STATUS（成功 200）。
// 校验分两层：agent 接口按 JSON Schema 查形状和长度（缺参数、多余参数、超长 → invalid，不调账本）；
// 账本查业务（项目在不在、管不管得着、文件夹对不对）。
import type {
  AgentRole,
  ConversationId,
  MessageId,
  PersonaChange,
  PmId,
  PmMode,
  Project,
  ProjectFolder,
  ProjectId,
  RouterItemId,
  SessionId,
  TaskGraph,
  TaskGraphId,
  TaskGraphStatus,
  TaskNodeKey,
  WorkerRecord,
  WorkerId,
} from "./domain.ts";
import type { RouterItem, RouterPmNote, RouterReportLink } from "./router.ts";
import type { ScheduleId, ScheduleRecord } from "./schedule.ts";
import { AGENT_VENDORS, DEFAULT_AGENT_VENDOR, type AgentVendor, type VendorAvailability } from "./vendors.ts";
// ledger.ts 只从这里引类型，没有运行时的循环引用
import { API_ERRORS } from "./errors.ts";
import { LEDGER_ERROR_HTTP_STATUS } from "./ledger.ts";
import type { LedgerErrorCode } from "./ledger.ts";

/** 会话令牌，hub 自己从环境变量读；agent 的命令里不能出现变量（M0 实测会被权限检查拒绝）。 */
export const ENV_HUB_TOKEN = "HUB_TOKEN";
/** hub.sock 的真实路径（realpath 过）。 */
export const ENV_HUB_SOCK = "HUB_SOCK";

/**
 * 分工（M3）：这里定命令、参数、返回和按角色放行的表；hub/cli.ts 的 `hub worker …` 命令行解析、agent-api 的请求体规格、
 * 账本 hubCall 里按 HUB_COMMAND_ROLES 放行和 worker.* 的实现都归 W2。
 *
 * 命令（11-03 起一个项目经理只管一个项目，不再有项目群、交接）。命令行写法 → 命令名：
 * - `hub status`                                         → status：我是谁、我的项目和文件夹；Worker 调是我在做什么
 *   （任务、在哪干活）
 * - `hub project create --folder <路径> [--name <名>] [--description <说明>]` → project.create：给自己建项目（只能有一个）
 * - `hub project attach <文件夹>`                         → project.attach：给自己的项目挂上附加文件夹
 * - `hub project detach <文件夹>`                         → project.detach：从自己的项目上移除附加文件夹
 * - `hub project setup --stdin | --clear`                 → project.setup：设置、清除项目的 worktree 准备命令
 * - `hub ask [--option <选项>...] --stdin`               → ask：向用户提问（要用户拍板、确认、选择的事），正文是问题（Markdown）
 * - `hub schedule add --name <名> (--daily HH:MM | --every 30m|2h) --stdin` → schedule.add：建定时任务（M6），任务说明从标准输入读
 * - `hub schedule list | pause <编号> | resume <编号> | remove <编号>` → schedule.list / pause / resume / remove：只能管自己的
 * - `hub persona show`                                   → persona.show
 * - `hub persona edit [--mode <模式>] [--reason <理由>] [--stdin | --text <正文>]` → persona.edit，新全文；可以只改模式
 *
 * hub 命令行的约定：
 * - 项目不用点名：每个项目经理只有一个，账本按会话找；
 * - 路径参数里开头的 `~` 由 hub 展开成 HOME，相对路径按 hub 的当前目录变成绝对路径，再发出去；账本还会 resolveFolder 一次；
 * - 长文本：只有显式写了 `--stdin` 才读标准输入（读到结束，去掉末尾一个换行），没写就绝不碰标准输入
 *   （agent 的 shell 里标准输入可能一直开着，“没带正文就去读”会卡住）。不用 `--text -` 这种写法。
 *   提示词里教 `hub persona edit --stdin <<'EOF'`。
 *   --stdin 和 --text 同时给 → 用法不对，退出码 2；persona.edit 没有正文也没有 --mode（或读到空的）→ 用法不对。
 */
export const HUB_COMMANDS = [
  "status",
  "project.create",
  "project.attach",
  "project.detach",
  "project.setup",
  "persona.show",
  "persona.edit",
  "worker.start",
  "worker.send",
  "worker.max-time",
  "worker.end",
  "worker.list",
  "worker.show",
  "worker.log",
  "worker.search",
  "models",
  "ask",
  "schedule.add",
  "schedule.list",
  "schedule.pause",
  "schedule.resume",
  "schedule.remove",
  "router.ask",
  "router.report",
  "router.note",
  "graph.create",
  "graph.show",
  "graph.list",
  "graph.ask",
  "graph.patch",
  "graph.done",
  "graph.decide",
  "graph.skip",
  "graph.cancel",
  "graph.finish",
] as const;
export type HubCommand = (typeof HUB_COMMANDS)[number];

/**
 * 按角色放行（m3-plan 第 2.1 节），只有这一张表。账本 hubCall 按会话的 role 查（hubCommandAllowed），不在表里 → forbidden。
 * Worker 只能 hub status：不建项目、不挂文件夹、不改性格设定（也是“不能写记忆”的一部分）、不再派 Worker。
 */
export const HUB_COMMAND_ROLES: Readonly<Record<HubCommand, readonly AgentRole[]>> = {
  status: ["pm", "worker"],
  "project.create": ["pm"],
  "project.attach": ["pm"],
  "project.detach": ["pm"],
  "project.setup": ["pm"],
  "persona.show": ["pm"],
  "persona.edit": ["pm"],
  "worker.start": ["pm"],
  "worker.send": ["pm"],
  "worker.max-time": ["pm"],
  "worker.end": ["pm"],
  "worker.list": ["pm"],
  "worker.show": ["pm"],
  "worker.log": ["pm"],
  "worker.search": ["pm"],
  models: ["pm"],
  ask: ["pm"],
  "schedule.add": ["pm"],
  "schedule.list": ["pm"],
  "schedule.pause": ["pm"],
  "schedule.resume": ["pm"],
  "schedule.remove": ["pm"],
  "router.ask": ["pm"],
  "router.report": ["pm"],
  "router.note": ["pm"],
  "graph.create": ["pm"],
  "graph.show": ["pm"],
  "graph.list": ["pm"],
  "graph.ask": ["pm"],
  "graph.patch": ["pm"],
  "graph.done": ["pm"],
  "graph.decide": ["pm"],
  "graph.skip": ["pm"],
  "graph.cancel": ["pm"],
  "graph.finish": ["pm"],
};

export function hubCommandAllowed(role: AgentRole, command: HubCommand): boolean {
  return HUB_COMMAND_ROLES[command].includes(role);
}

/**
 * `hub self-reload [--build]`：登记空闲排空热重启（daemon/self-reload.ts），立即返回。守护进程级的操作，不进账本的 hubCall，
 * 所以不在 HUB_COMMANDS 里（同 hub dispatch）；agent 接口单独一条路由，只放行项目经理的会话，别的角色 forbidden（403）。
 */
export const SELF_RELOAD_AGENT_PATH = "/v1/self.reload";
/** 守护进程不是由外壳（Fusa.app、Windows 桌面端、systemd）拉起的：退出后没人重启，不接受热重启（hub、POST /api/self-reload 都回 409）。 */
export const SELF_RELOAD_UNSUPPORTED_MESSAGE = "这台守护进程不是由 Fusa 应用或 systemd 拉起的，退出后没人自动重启，不能热重启；请手动重启";

export function hubPath(command: HubCommand): string {
  return `/v1/${command}`;
}

/** 各命令的请求体。字符串长度上限见 limits.ts；路径都是绝对路径。 */
export interface HubArgsMap {
  status: Record<string, never>;
  /** name 不给就用主文件夹的名字。 */
  "project.create": { folder: string; name?: string; description?: string };
  "project.attach": { folder: string };
  "project.detach": { folder: string };
  /**
   * `hub project setup --stdin`（command 是标准输入读到的正文）/ `hub project setup --clear`（command 是 null）：
   * 项目的 worktree 准备命令，存在 projects.setup_command。给 Worker 建好 worktree 后在里面用 shell 跑它，跑完 Worker 再开工
   * （daemon/setup/setup.ts）；在主文件夹里干的 Worker 不跑。不超过 MAX_SETUP_COMMAND_BYTES，不能是空的、不能带 NUL。
   */
  "project.setup": { command: string | null };
  "persona.show": Record<string, never>;
  /** text：新的完整性格设定（不超过 MAX_PERSONA_BYTES）。text、mode 至少给一个。 */
  "persona.edit": { text?: string; mode?: PmMode; reason?: string };
  /**
   * `hub worker start --title <标题> [--vendor <厂商>] [--model <模型>] [--effort <思考程度>] [--max-time <时长>] [--readonly] [--no-worktree] --stdin`（m3-plan 第 2.4 节）。
   * title 按 normalizeWorkerTitle（空的、带控制字符 → invalid；太长不报错，截断）；task 从标准输入读（--stdin 必须写，规则同 persona edit），不超过 MAX_TASK_BYTES、不能是空的；
   * model、effort 按目标厂商清单（vendors.ts）查，不给且同厂商 = 用项目经理会话现在的模型、思考程度；换厂商则默认 null。
   * maxTimeMs：本轮最大容忍时间（毫秒，默认 DEFAULT_WORKER_MAX_TIME_MS = 30m），超时静默唤醒项目经理。
   * 账本同步判断在哪干活：主文件夹是有提交的 git 仓库、又没给 noWorktree → worktree，登记 worktree.create；
   * 否则 main，直接登记 Worker 的 session.start 和第一条 session.send。
   * 带 node、节点上已经有经手过的 Worker 时是换人接手（docs/orchestration-simplify-design.md 第 5.2 节）：title、task 都可以不给
   * （标题沿用最近的前任；task 给了是项目经理的补充），后台先把节点上还挂着的旧 Worker 按“没做完”收工，接着用前任的 worktree 和分支，
   * 第一条消息是“【系统 · 接手】”带前任的记录。别的情况 title、task 必须给。
   */
  "worker.start": {
    title?: string;
    task?: string;
    vendor?: AgentVendor;
    model?: string;
    effort?: string;
    maxTimeMs?: number;
    readonly?: boolean;
    noWorktree?: boolean;
    /** 绑定的任务图节点 key（可选）。 */
    node?: TaskNodeKey;
    /** 绑定的任务图编号（多张活跃图时显式指定）。 */
    graphId?: TaskGraphId;
  };
  /** `hub worker send <编号> [--max-time <时长>] --stdin`：打回或回答问题，发给同一个 Worker 会话。text 不超过 MAX_TASK_BYTES。 */
  "worker.send": { workerId: WorkerId; text: string; maxTimeMs?: number };
  /** `hub worker max-time <编号> <时长>`：单独延时或更新正在运行的 Worker 本轮最大时间（从现在重新计时）。 */
  "worker.max-time": { workerId: WorkerId; maxTimeMs: number };
  /** `hub worker end <编号>`：停掉这个 Worker（登记 session.end），Worker 标 ended；绑在任务图未完成步骤上的会变成等你处理（不再标完成）。 */
  "worker.end": { workerId: WorkerId };
  /** `hub worker list`：我派出去的 Worker。 */
  "worker.list": Record<string, never>;
  /**
   * `hub worker show <编号>`：一个 Worker 现在的情况（只能看自己派的；已收工的也能看）。
   * `--task`：只输出任务说明原文；`--report [N]`：只输出第 N 轮汇报原文（N 和 search 里的“汇报 #N”一致，从 1 起、从旧到新），不给 N（"latest"）就是最新一轮（不含“【Worker … 的汇报】”那行开头）。
   * 两个不能一起用；没有这次汇报 → invalid。
   */
  "worker.show": { workerId: WorkerId; task?: boolean; report?: number | "latest" };
  /**
   * `hub worker search <关键词…> [--limit N]`：在我派过的所有 Worker（含已收工的）的标题、任务说明、汇报里搜。
   * 关键词都要包含（同一处：标题、任务说明或某一轮汇报），中文按子串、英文不分大小写；一处一行，最新的在前，
   * 最多 limit 条（默认 WORKER_SEARCH_DEFAULT_LIMIT，最多 WORKER_SEARCH_MAX_LIMIT）。
   */
  "worker.search": { keywords: string[]; limit?: number };
  /**
   * `hub worker log <编号> [--last N]`：这个 Worker 最近 N 步（默认 WORKER_LOG_DEFAULT_STEPS，最多 WORKER_LOG_MAX_STEPS），
   * 一行一步，从账本的 session_steps 取，不看各厂商的原始日志。
   * `--stats`：不列步骤，汇总这个 Worker 所有会话里账本留着的全部步骤（steps 数组留空），不能和 last 一起用。
   */
  "worker.log": { workerId: WorkerId; last?: number; stats?: boolean };
  /**
   * `hub models [--vendor <厂商>] [--refresh]`：查看当前设备各厂商（或指定厂商）可用的模型、默认模型及每个模型支持的思考程度。
   * `--refresh` 强制重新向本机 CLI 探测。
   */
  models: { vendor?: AgentVendor; refresh?: boolean };
  /**
   * `hub ask [--option <选项>...] --stdin`（M5）：在项目经理的对话里发一条带“等你确定”标记的消息（meta 里 needsUser，见 domain.ts 的 AskMeta），
   * 网页会单独提醒用户、不会被别的消息刷掉。text 不超过 MAX_TASK_BYTES、不能是空的；options 是可选的选项列表（2～10 项）。
   */
  ask: { text: string; options?: string[] };
  /**
   * `hub schedule add --name <名> (--daily HH:MM | --every 30m|2h) --stdin`（M6）：给自己建定时任务。name 按 normalizeName；
   * daily、everyMinutes 恰好给一个（HH:MM 本机本地时间；间隔最短 MIN_SCHEDULE_EVERY_MINUTES 分钟，hub 把 30m、2h 换成分钟数）；
   * prompt 从标准输入读，不超过 MAX_TASK_BYTES、不能是空的。到点往项目经理自己的对话发一条消息、照常交给它，对话里留一条给人看的“已建定时任务”。
   */
  "schedule.add": { name: string; prompt: string; daily?: string; everyMinutes?: number };
  /** `hub schedule list`：我的定时任务，含暂停的。 */
  "schedule.list": Record<string, never>;
  /** `hub schedule pause|resume|remove <编号>`：不存在 → not_found；不是自己的 → forbidden。resume 从现在算下一次；remove 在对话里留一条“已删除”。 */
  "schedule.pause": { scheduleId: ScheduleId };
  "schedule.resume": { scheduleId: ScheduleId };
  "schedule.remove": { scheduleId: ScheduleId };
  /** `hub router ask`：提交结构化待拍板卡并同步写入对话 AskMeta 消息。 */
  "router.ask": {
    question: string;
    options: string[];
    context?: string;
    replaceItemId?: RouterItemId;
  };
  /** `hub router report`：提交里程碑完成汇报卡（不打扰对话流）。 */
  "router.report": {
    summary: string;
    links?: RouterReportLink[];
  };
  /** `hub router note`：更新或清空该 PM 的一句话项目近况备忘。 */
  "router.note": {
    text?: string;
    clear?: boolean;
  };
  /** `hub graph create`：从 JSON 规格创建持久化任务流图（DAG）。 */
  "graph.create": {
    title?: string;
    specJson: string;
  };
  /** `hub graph show [<graphId>]`：查看当前活跃图或指定图详情。 */
  "graph.show": {
    graphId?: TaskGraphId;
  };
  /** `hub graph list [--all | --status active|completed|cancelled]`：列出项目任务图。 */
  "graph.list": {
    all?: boolean;
    status?: TaskGraphStatus;
  };
  /** `hub graph ask <nodeKey>`：给还没开工的步骤挂上（或改）拍板卡：问题、选项、推荐与背景摘要，前置都完了时等用户拍板。 */
  "graph.ask": {
    nodeKey: TaskNodeKey;
    graphId?: TaskGraphId;
    question: string;
    options?: string[];
    recommended?: string;
    summaryMd?: string;
  };
  /** `hub graph patch [<graphId>] --stdin`：增量增删改节点与依赖边（含环路检测与运行态保护）。 */
  "graph.patch": {
    graphId?: TaskGraphId;
    specJson: string;
  };
  /** `hub graph done <nodeKey>`：放行：把没人在干的步骤标完了并记录产物摘要，下游轮到。 */
  "graph.done": {
    nodeKey: TaskNodeKey;
    graphId?: TaskGraphId;
    prUrl?: string;
    commit?: string;
    branch?: string;
    summary?: string;
    /** PM 放行时补给下一步的话（--stdin 正文）。 */
    note?: string;
  };
  /** `hub graph decide <nodeKey>`：PM 代填用户在对话中口头拍板的结论，步骤完了，下游轮到。 */
  "graph.decide": {
    nodeKey: TaskNodeKey;
    graphId?: TaskGraphId;
    choice: string;
    note?: string;
  };
  /** `hub graph skip <nodeKey>`：跳过单个节点（不级联跳过下游，下游在所有前置完成后照常解锁）。 */
  "graph.skip": {
    nodeKey: TaskNodeKey;
    graphId?: TaskGraphId;
    reason?: string;
  };
  /** `hub graph cancel [<graphId>]`：取消整张任务图。 */
  "graph.cancel": {
    graphId?: TaskGraphId;
    reason?: string;
  };
  /** `hub graph finish [<graphId>] [--unmerged-ok] --stdin`：所有节点完成后结束任务图并自动向总助投递汇报卡。 */
  "graph.finish": {
    graphId?: TaskGraphId;
    unmergedOk?: boolean;
    summary: string;
  };
}

export interface CreateTaskGraphNodeInput {
  key: TaskNodeKey;
  title: string;
  brief?: string;
  vendor?: AgentVendor;
  model?: string;
  effort?: string;
  maxTime?: string | number;
  readonly?: boolean;
  confirm?: boolean;
  review?: boolean;
  base?: "main";
  deps?: TaskNodeKey[];
  /** 写了问题就是挂着拍板卡的步骤：轮到时等用户拍板。 */
  question?: string;
  options?: string[];
  summaryMd?: string;
  recommended?: string;
}

export type CreateTaskGraphStepInput = CreateTaskGraphNodeInput;

export interface CreateTaskGraphEdgeInput {
  from: TaskNodeKey;
  to: TaskNodeKey;
}

export interface CreateTaskGraphSpecInput {
  title?: string;
  goal?: string;
  originMsgId?: MessageId;
  steps?: CreateTaskGraphStepInput[];
  nodes?: CreateTaskGraphNodeInput[];
  edges?: CreateTaskGraphEdgeInput[];
}

export interface PatchTaskGraphNodeInput {
  key: TaskNodeKey;
  title?: string;
  brief?: string | null;
  vendor?: AgentVendor | null;
  model?: string | null;
  effort?: string | null;
  maxTime?: string | number | null;
  readonly?: boolean;
  confirm?: boolean;
  review?: boolean;
  base?: "main" | null;
  deps?: TaskNodeKey[];
  question?: string;
  options?: string[];
  summaryMd?: string;
  recommended?: string;
}

export type PatchTaskGraphStepInput = PatchTaskGraphNodeInput;

export interface PatchTaskGraphSpecInput {
  title?: string;
  goal?: string | null;
  addSteps?: CreateTaskGraphStepInput[];
  updateSteps?: PatchTaskGraphStepInput[];
  removeSteps?: TaskNodeKey[];
  skipSteps?: TaskNodeKey[];
  addNodes?: CreateTaskGraphNodeInput[];
  updateNodes?: PatchTaskGraphNodeInput[];
  removeNodes?: TaskNodeKey[];
  /** 跳过还没开工的节点（同 hub graph skip，可以一次跳几个）。 */
  skipNodes?: TaskNodeKey[];
  addEdges?: CreateTaskGraphEdgeInput[];
  removeEdges?: CreateTaskGraphEdgeInput[];
}

/** `hub graph create` 正文 JSON 一行字段示例（任务图手册与 `hub --help` 共用；顶层 title 可改用 --title 传；steps 不写 deps 默认按顺序串接，带 brief 自动开工）。 */
const EXAMPLE_REVIEW_VENDOR = AGENT_VENDORS.find((vendor) => vendor !== DEFAULT_AGENT_VENDOR) ?? DEFAULT_AGENT_VENDOR;
export const TASK_GRAPH_CREATE_JSON_HINT =
  `{"title":"…","goal":"…","steps":[{"key":"impl","title":"…","brief":"…"},{"key":"review","title":"…","brief":"…","review":true,"vendor":"${EXAMPLE_REVIEW_VENDOR}"}]}`;

/** `hub graph patch` 正文 JSON 一行字段示例（任务图手册与 `hub help` 共用，只此一份；按需取用；updateSteps 只能改还没开工的步骤；skipSteps 跳过还没开工的步骤）。 */
export const TASK_GRAPH_PATCH_JSON_HINT =
  '{"goal":"…","addSteps":[{"key":"qa","title":"…","brief":"…","deps":["review"]}],"updateSteps":[{"key":"review","brief":"…"}],"removeSteps":["old"],"skipSteps":["polish"]}';

export type HubArgs<C extends HubCommand> = HubArgsMap[C];

/** 项目名片：提示词、hub status 里用。 */
export interface ProjectCard {
  id: ProjectId;
  name: string;
  description: string | null;
  /** 主文件夹的真实路径。 */
  mainFolder: string;
  /** 其他没移除的文件夹。 */
  otherFolders: string[];
}

/** hub status 返回给项目经理的活跃任务图计数摘要。 */
export interface PmActiveGraphSummary {
  id: TaskGraphId;
  title: string;
  totalNodes: number;
  /** 完了（含跳过的）。 */
  doneCount: number;
  runningCount: number;
  /** 等项目经理处理的。 */
  waitingPmCount: number;
  /** 挂着拍板卡等用户的。 */
  waitingUserCount: number;
  readyToFinish: boolean;
}

/** 项目经理调 hub status。 */
interface PmHubStatus {
  role: "pm";
  pm: { id: PmId; name: string; mode: PmMode };
  sessionId: SessionId;
  /** 项目经理的那个对话。 */
  conversationId: ConversationId;
  /** 它的项目；还没有是 null。 */
  project: ProjectCard | null;
  /** 项目的 worktree 准备命令（hub project setup）；没有项目、没配是 null。 */
  setupCommand: string | null;
  /** 当前项目的活跃任务图计数摘要（如有）。 */
  activeTaskGraphs?: PmActiveGraphSummary[];
}

/** Worker 调 hub status 时上游步骤的交棒摘要与落盘路径。 */
export interface WorkerHubStatusUpstream {
  key: TaskNodeKey;
  title: string;
  skipped: boolean;
  summary: string | null;
  branch: string | null;
  prUrl: string | null;
  reportFile: string | null;
}

/** Worker 调 hub status（M3）：我是哪个 Worker、任务是什么、在哪干活。 */
export interface WorkerHubStatus {
  role: "worker";
  /** 派它的项目经理。 */
  pm: { id: PmId; name: string };
  sessionId: SessionId;
  /** Worker 自己的对话。 */
  conversationId: ConversationId;
  worker: WorkerRecord;
  project: ProjectCard;
  /** 所属任务图步骤信息（临时 Worker 没有此字段）。 */
  taskGraph?: {
    id: TaskGraphId;
    title: string;
    goal: string | null;
    stepKey: TaskNodeKey;
    stepTitle: string;
    stepIndex: number;
    totalSteps: number;
    brief: string | null;
    upstream: WorkerHubStatusUpstream[];
  };
}

/** hub worker search 的一处命中：where 是 title、task 或 report；report 时 report 是第几轮汇报（从 1 起，按时间）。 */
export interface WorkerSearchHit {
  workerId: WorkerId;
  title: string;
  status: string;
  where: "title" | "task" | "report";
  report?: number;
  snippet: string;
}

/** hub worker log 的一步：一行的时间和文字。kind：tool 调工具、thinking 思考、text 回复、turn_ended 一轮结束。 */
export interface WorkerLogStep {
  at: number;
  kind: "tool" | "thinking" | "text" | "turn_ended";
  text: string;
}

/**
 * hub worker show 之前 agent 接口异步查到的这个 Worker 的 PR（gh pr list --head <分支>）：
 * 没有 PR 时返回 null（show 不写 PR 行）；gh 查不了（没装、没登录、超时、报错）时返回 { unavailable: 原因 }（show 显示“PR 查不了（原因）”）。
 * 账本的事务里不做 I/O。
 */
export interface WorkerPr {
  number: number;
  /** gh 给的状态：OPEN、MERGED、CLOSED。 */
  state: string;
  url: string;
}

export type WorkerPrProbeResult = WorkerPr | { unavailable: string } | null;

/** hub models 返回的单个模型项。 */
interface HubModelEntry {
  id: string;
  label: string;
  efforts: string[];
}

/** hub models 返回的单个厂商模型目录摘要。 */
export interface HubVendorModels {
  vendor: AgentVendor;
  label: string;
  source: "vendor" | "bundled";
  availability: VendorAvailability;
  defaultModel: string | null;
  defaultModelId: string | null;
  defaultEffort: string | null;
  defaultEfforts: string[];
  efforts: string[];
  models: HubModelEntry[];
}

/** 各命令成功时的 data。text 是给 agent 看的一两句中文，data 给程序用。 */
interface HubDataMap {
  /** 按 role 收窄。 */
  status: PmHubStatus | WorkerHubStatus;
  "project.create": { project: Project; mainFolder: ProjectFolder };
  "project.attach": { project: Project; folder: ProjectFolder };
  "project.detach": { project: Project; folder: ProjectFolder };
  /** 改完以后的准备命令，清除了是 null。 */
  "project.setup": { project: Project; setupCommand: string | null };
  "persona.show": { text: string; mode: PmMode };
  /** change 为 null：内容和模式都没变，什么也没记。 */
  "persona.edit": { change: PersonaChange | null };
  /** text 里说清楚在哪干活；用 worktree、主文件夹又有没提交的改动时提醒“Worker 是从最后一次提交开始的，看不到这些改动”。 */
  "worker.start": { worker: WorkerRecord };
  /** messageId：Worker 对话里这条项目经理的话。 */
  "worker.send": { worker: WorkerRecord; messageId: MessageId };
  "worker.max-time": { worker: WorkerRecord; maxTimeMs: number };
  "worker.end": { worker: WorkerRecord };
  /** 按编号从小到大，含已收工的。 */
  "worker.list": { workers: WorkerRecord[] };
  "worker.show": { worker: WorkerRecord };
  /** steps：最近的几步，从旧到新，和 text 里的行一一对应。 */
  "worker.log": { worker: WorkerRecord; steps: WorkerLogStep[] };
  "worker.search": { hits: WorkerSearchHit[] };
  models: { vendors: HubVendorModels[] };
  /** messageId：对话里那条带标记的消息。 */
  ask: { messageId: MessageId };
  "schedule.add": { schedule: ScheduleRecord };
  /** 按编号从小到大，含暂停的。 */
  "schedule.list": { schedules: ScheduleRecord[] };
  "schedule.pause": { schedule: ScheduleRecord };
  "schedule.resume": { schedule: ScheduleRecord };
  /** 删之前的样子。 */
  "schedule.remove": { schedule: ScheduleRecord };
  "router.ask": { item: RouterItem; messageId: MessageId };
  "router.report": { item: RouterItem };
  "router.note": { note: RouterPmNote | null };
  "graph.create": { graph: TaskGraph };
  "graph.show": { graph: TaskGraph };
  "graph.list": { graphs: TaskGraph[] };
  "graph.ask": { graph: TaskGraph; messageId: MessageId | null };
  "graph.patch": { graph: TaskGraph };
  "graph.done": { graph: TaskGraph };
  "graph.decide": { graph: TaskGraph };
  "graph.skip": { graph: TaskGraph };
  "graph.cancel": { graph: TaskGraph };
  "graph.finish": { graph: TaskGraph; reportItem: RouterItem };
}

export type HubData<C extends HubCommand> = HubDataMap[C];

export interface HubResult<C extends HubCommand> {
  text: string;
  data: HubData<C>;
}

/**
 * 错误码：账本的四种（LedgerRequestError）加两种只有 agent 接口有的：
 * - unauthorized：没带令牌、令牌不对或已作废（401），不调账本；
 * - internal：守护进程自己出错（500），message 是错误原文。
 * 请求体不对（未知命令、缺参数、超长）是 invalid（400）。整个请求体超过 HUB_MAX_BODY_BYTES 也是 invalid、400
 * （W2 把 Fastify 的 FST_ERR_CTP_BODY_TOO_LARGE 改写成 { ok: false, code: "invalid" }），不用 413，hub 只认这张表里的状态。
 */
export type HubErrorCode = LedgerErrorCode | "unauthorized" | "internal";

export const HUB_ERROR_HTTP_STATUS: Readonly<Record<HubErrorCode, number>> = {
  ...LEDGER_ERROR_HTTP_STATUS,
  unauthorized: API_ERRORS.unauthorized.status,
  internal: API_ERRORS.internal.status,
};

/** 应答体。message 是给 agent 看的一句中文，hub 原样打印。 */
export type HubResponse<C extends HubCommand = HubCommand> =
  | { ok: true; text: string; data: HubData<C> }
  | { ok: false; code: HubErrorCode; message: string };

/**
 * hub 的退出码：
 * - ok：成功，打印 text；
 * - rejected：系统拒绝（任何 ok: false 的应答，包括 unauthorized、internal），打印 message；
 * - usage：用法不对（未知子命令、缺参数、没设 HUB_TOKEN 或 HUB_SOCK），打印用法；
 * - unreachable：连不上守护进程（socket 不存在、拒绝连接、超时），打印“连不上守护进程”和怎么办；
 * - internal：hub 自己出了意外的错（不是用法的问题），打印一句中文，不打堆栈和异常原文。
 */
export const HUB_EXIT = { ok: 0, rejected: 1, usage: 2, unreachable: 3, internal: 4 } as const;

/** 会话令牌：32 字节随机数，base64url。 */
export const HUB_TOKEN_BYTES = 32;

/**
 * 会话令牌（W2 实现，只在内存里，盘上不落；守护进程重启后全部作废）。
 * - issue：这个会话已经有有效令牌就返回同一个，没有才生成新的。prepareLaunch 会被反复调（见 driver.ts），
 *   每次都换新令牌的话，正在跑的进程手里的令牌就失效了。revoke 过的会话再调 issue 直接抛错（不再发新令牌）；
 *   已结束（status ended）的会话不会走到 issue：驱动层对它的 start、send 先抛 session_ended，prepareLaunch 不会被调；
 * - resolve：令牌 → 会话，不认识或已作废返回 null。用定长比较；
 * - revoke：作废这个会话的令牌，并记住这个会话已作废。组装代码在 session.end 处理完（会话 ended）时调。
 */
export interface SessionTokens {
  issue(sessionId: SessionId): string;
  resolve(token: string): SessionId | null;
  revoke(sessionId: SessionId): void;
}

/** revoke 过的会话再 issue 抛这个。组装代码只把它当“会话已结束”，issue 的其他错照常抛出。 */
export class SessionTokenRevokedError extends Error {
  constructor(sessionId: SessionId) {
    super(`session ${sessionId} token was revoked; no new token is issued`);
    this.name = "SessionTokenRevokedError";
  }
}
