// hub 命令（设计第 8.1 节；规格见 shared/hub.ts 的注释）：agent 在自己的 shell 里敲，令牌和 socket 路径从环境变量读，
// 经 Unix socket 请求守护进程的 agent 接口，把结果打印出来，按 HUB_EXIT 退出。
// 只引 shared 里不依赖 node:path 以外东西的几个文件，启动快。
import { request, type ClientRequest } from "node:http";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { parseArgs } from "node:util";
import { PM_MODES, type PmMode } from "../shared/domain.ts";
import { LOCAL_ERRORS } from "../shared/errors.ts";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN, HUB_EXIT, hubPath, type HubCommand } from "../shared/hub.ts";
import {
  HUB_CLI_STDIN_IDLE_MS,
  HUB_CLI_TIMEOUT_MS,
  HUB_MAX_BODY_BYTES,
  MIN_SCHEDULE_EVERY_MINUTES,
  SETUP_TIMEOUT_MS,
  WORKER_LOG_DEFAULT_STEPS,
  WORKER_LOG_MAX_STEPS,
  WORKER_SEARCH_DEFAULT_LIMIT,
  WORKER_SEARCH_MAX_LIMIT,
} from "../shared/limits.ts";
import { HUB_COMMAND, PRODUCT_NAME } from "../shared/names.ts";
import { checkEveryMinutes, parseDailyTime, parseEvery } from "../shared/schedule.ts";
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

/** hub 用法，给人看（hub help、用法不对时打印）。给 agent 看的另有一份：daemon/prompt.ts 的 HUB_USAGE_PROMPT。改一份，记得改另一份。 */
export const HUB_USAGE = `用法：
  ${hub} status                                              我是谁、我的项目和文件夹
  ${hub} project create --folder <主文件夹> [--name <名>] [--description <说明>]
                                                          建项目（一个项目经理只管一个项目）
  ${hub} project attach <文件夹>                             给项目挂上附加文件夹
  ${hub} project detach <文件夹>                             从项目上移除附加文件夹
  ${hub} project setup --stdin | --clear                     设置（从标准输入读）或清除 worktree 准备命令：
                                                          给 Worker 建好 worktree 后先在里面跑它，跑完 Worker 再开工。
                                                          用守护进程的 $SHELL -c 跑，标准输入是空的，最多 ${SETUP_TIMEOUT_MS / 60_000} 分钟；
                                                          能用 AGENT_HUB_ROOT_PATH（主文件夹）、AGENT_HUB_WORKTREE_PATH。
                                                          别把密钥写进命令：原文会出现在日志和失败附注里
  ${hub} persona show
  ${hub} persona edit [--mode ${PM_MODES.join("|")}] [--reason <理由>] [--stdin | --text <新的完整性格设定>]
  ${hub} worker start --title <标题> [--vendor ${AGENT_VENDORS.join("|")}] [--model <模型>] [--effort ${ALL_EFFORTS.join("|")}] [--readonly] [--no-worktree] --stdin
                                                          派一个 Worker，任务说明从标准输入读
  ${hub} worker send <编号> --stdin                           打回或回答它的问题，同一个 Worker 接着做
  ${hub} worker end <编号>                                    收工：结束这个 Worker 的会话
  ${hub} worker list                                         我派出去的 Worker：状态、在哪干活、模型和思考程度
  ${hub} worker show <编号> [--task | --report [N]]            一个 Worker 现在的情况：状态、在干什么、这一轮和上一轮、进程、分支和 PR；
                                                          --task 只出任务说明原文，--report [N] 只出第 N 轮汇报原文（N 同 search 里的“汇报 #N”，不写就是最新一轮）
  ${hub} worker search <关键词…> [--limit N]                   在我派过的所有 Worker（含已收工）的标题、任务说明、汇报里搜：关键词都要包含，
                                                          中文按子串、英文不分大小写；一处一行，最新的在前（默认 ${WORKER_SEARCH_DEFAULT_LIMIT} 条，最多 ${WORKER_SEARCH_MAX_LIMIT}）
  ${hub} worker log <编号> [--last N | --stats]                它最近 N 步（默认 ${WORKER_LOG_DEFAULT_STEPS}，最多 ${WORKER_LOG_MAX_STEPS}），一行一步：调了什么工具、思考了多久、回复、一轮怎么结束；
                                                          --stats 不列步骤，只出一张汇总：步数、各类动作次数、读得最多的文件、重复最多的命令、思考和等工具的用时
  ${hub} ask --stdin                                         向用户提问（要用户拍板、确认、选择的事），问题从标准输入读；
                                                          会单独提醒用户，不会被别的消息刷掉
  ${hub} schedule add --name <名> (--daily HH:MM | --every 30m|2h) --stdin
                                                          建定时任务：到点把任务说明（从标准输入读）发到我自己的对话里。
                                                          --daily 是每天几点（本机时间），--every 是每隔多久（最短 ${MIN_SCHEDULE_EVERY_MINUTES} 分钟）
  ${hub} schedule list                                       我的定时任务：频率、下次运行、上次结果
  ${hub} schedule pause <编号>                                 暂停
  ${hub} schedule resume <编号>                                恢复（从现在算下一次）
  ${hub} schedule remove <编号>                                删除

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

/** 守护进程没开：只说 network 那句话和怎么办，不带 ENOENT、ECONNREFUSED 这类系统码。 */
const UNREACHABLE_MESSAGE = `${LOCAL_ERRORS.network.text}。${LOCAL_ERRORS.network.hint}`;
/** hub 自己出了意外的错（退出码 internal）：不打堆栈和异常原文。 */
const INTERNAL_MESSAGE = "出了意外的错，这条命令没有跑完。重试一次；还不行，把现象告诉用户";
/** post 里超时的原因；别的原因是系统码（ECONNRESET 之类），不打给人看。 */
const TIMEOUT_REASON = "超时";
const NO_ANSWER_MESSAGE = `请求已经发给 ${PRODUCT_NAME}，但没等到回应`;
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
  model?: string;
  effort?: string;
  readonly?: boolean;
  "no-worktree"?: boolean;
  clear?: boolean;
  daily?: string;
  every?: string;
  last?: string;
  stats?: boolean;
  limit?: string;
  task?: boolean;
  report?: boolean;
  help?: boolean;
};

/** 解析好的一条命令：body 里的 text 字段留到读完标准输入再填。 */
interface Parsed {
  command: HubCommand;
  body: Record<string, unknown>;
  /** 正文从哪来：--stdin、--text 或没有。 */
  textSource: { kind: "stdin" } | { kind: "inline"; value: string } | null;
  /** 正文放进 body 的哪个字段。 */
  textField?: "text" | "task" | "command" | "prompt";
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
        model: { type: "string" },
        effort: { type: "string" },
        readonly: { type: "boolean" },
        "no-worktree": { type: "boolean" },
        clear: { type: "boolean" },
        daily: { type: "string" },
        every: { type: "string" },
        last: { type: "string" },
        stats: { type: "boolean" },
        limit: { type: "string" },
        task: { type: "boolean" },
        report: { type: "boolean" },
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
    allowOnly(values, ["title", "vendor", "model", "effort", "readonly", "no-worktree", "stdin"], "worker start");
    expectPositionals(rest, 0, "worker start");
    if (values.title === undefined) throw new UsageError(`${hub} worker start 要 --title <标题>`);
    if (values.vendor !== undefined && !isAgentVendor(values.vendor)) {
      throw new UsageError(`--vendor 只能是 ${AGENT_VENDORS.join("、")}`);
    }
    if (values.effort !== undefined && !ALL_EFFORTS.includes(values.effort)) {
      throw new UsageError(`--effort 只能是 ${ALL_EFFORTS.join("、")}`);
    }
    const textSource = requireStdin(values, "worker start");
    const body: Record<string, unknown> = { title: values.title };
    if (values.vendor !== undefined) body.vendor = values.vendor;
    if (values.model !== undefined) body.model = values.model;
    if (values.effort !== undefined) body.effort = values.effort;
    if (values.readonly === true) body.readonly = true;
    if (values["no-worktree"] === true) body.noWorktree = true;
    return { command: "worker.start", body, textSource, textField: "task" };
  }
  if (group === "worker" && action === "send") {
    allowOnly(values, ["stdin"], "worker send");
    expectPositionals(rest, 1, "worker send");
    const workerId = workerIdOf(rest[0], "worker send");
    return { command: "worker.send", body: { workerId }, textSource: requireStdin(values, "worker send"), textField: "text" };
  }
  if (group === "worker" && action === "end") {
    allowOnly(values, [], "worker end");
    expectPositionals(rest, 1, "worker end");
    return { command: "worker.end", body: { workerId: workerIdOf(rest[0], "worker end") }, textSource: null };
  }
  if (group === "ask") {
    allowOnly(values, ["stdin"], "ask");
    expectPositionals(parsed.positionals.slice(1), 0, "ask");
    return { command: "ask", body: {}, textSource: requireStdin(values, "ask"), textField: "text" };
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
  const usage = (reason: string) => {
    io.stderr.write(line(`${hub}：${reason}`));
    io.stderr.write(HUB_USAGE);
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
  if (token === undefined || token === "") return usage(`没有设 ${ENV_HUB_TOKEN}：${hub} 只能在 ${PRODUCT_NAME} 启动的会话里用`);
  if (!TOKEN_CHARS.test(token)) return usage(`${ENV_HUB_TOKEN} 里有不该有的字符，不是 ${PRODUCT_NAME} 发的令牌`);
  if (socketPath === undefined || socketPath === "") return usage(`没有设 ${ENV_HUB_SOCK}：${hub} 只能在 ${PRODUCT_NAME} 启动的会话里用`);

  const body: Record<string, unknown> = { ...parsed.body };
  if (parsed.textSource !== null && parsed.textField !== undefined) {
    let text: string;
    try {
      text = parsed.textSource.kind === "stdin" ? await readAllStdin(io.stdin(), io.stdinIdleMs ?? HUB_CLI_STDIN_IDLE_MS) : parsed.textSource.value;
    } catch (err) {
      if (err instanceof UsageError) return usage(err.message);
      throw err;
    }
    if (text.trim() === "") return usage(parsed.textSource.kind === "stdin" ? "标准输入读到的正文是空的" : "--text 的正文是空的");
    body[parsed.textField] = text;
  }

  const outcome = await post(socketPath, hubPath(parsed.command), token, JSON.stringify(body), io.timeoutMs ?? HUB_CLI_TIMEOUT_MS);
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
  io.stderr.write(`${PRODUCT_NAME} 的回答看不懂（HTTP ${outcome.status}）\n`);
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
