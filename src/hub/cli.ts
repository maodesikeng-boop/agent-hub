// hub 命令（设计第 8.1 节；规格见 shared/hub.ts 的注释）：agent 在自己的 shell 里敲，令牌和 socket 路径从环境变量读，
// 经 Unix socket 请求守护进程的 agent 接口，把结果打印出来，按 HUB_EXIT 退出。
// 只引 shared 里不依赖 node:path 以外东西的几个文件，启动快。
import { request } from "node:http";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { parseArgs } from "node:util";
import { PM_MODES, type PmMode } from "../shared/domain.ts";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN, HUB_EXIT, hubPath, type HubCommand } from "../shared/hub.ts";
import { HUB_MAX_BODY_BYTES } from "../shared/limits.ts";

export interface HubIo {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  /** 只有写了 --stdin 才会调；没写就绝不碰标准输入。 */
  stdin: () => Readable;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  /** 连上之后多久没动静算连不上，默认 DEFAULT_TIMEOUT_MS。 */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export const HUB_USAGE = `用法：
  hub status                                              我是谁、在哪个对话、管哪些项目
  hub pm list                                             所有项目经理和各自管的项目
  hub project create --name <名> --folder <路径> [--description <说明>]
  hub project attach <项目> <文件夹>
  hub project detach <项目> <文件夹>
  hub project assign <项目> --to <项目经理名字> (--stdin | --text <交接正文>)
  hub persona show
  hub persona edit [--mode ${PM_MODES.join("|")}] [--reason <理由>] [--stdin | --text <新的完整性格设定>]

长文本用 --stdin 从标准输入读，例如：
  hub project assign foo --to 阿周 --stdin <<'EOF'
  交接正文
  EOF
令牌和 socket 路径由 hub 自己从环境变量 ${ENV_HUB_TOKEN}、${ENV_HUB_SOCK} 读，命令里不要写变量。
`;

const UNREACHABLE_MESSAGE = "连不上 agent-hub，守护进程可能没在跑";

class UsageError extends Error {}

type Options = {
  name?: string;
  folder?: string;
  description?: string;
  to?: string;
  text?: string;
  stdin?: boolean;
  mode?: string;
  reason?: string;
  help?: boolean;
};

/** 解析好的一条命令：body 里的 text 字段留到读完标准输入再填。 */
interface Parsed {
  command: HubCommand;
  body: Record<string, string>;
  /** 正文从哪来：--stdin、--text 或没有。 */
  textSource: { kind: "stdin" } | { kind: "inline"; value: string } | null;
  /** 正文放进 body 的哪个字段。 */
  textField?: "handoff" | "text";
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
    if (values[key] !== undefined && !allowed.includes(key)) throw new UsageError(`hub ${what} 不认 --${key}`);
  }
}

function expectPositionals(positionals: string[], count: number, what: string): void {
  if (positionals.length !== count) throw new UsageError(`hub ${what} 的参数个数不对`);
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
        to: { type: "string" },
        text: { type: "string" },
        stdin: { type: "boolean" },
        mode: { type: "string" },
        reason: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
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
  if (group === "pm" && action === "list") {
    allowOnly(values, [], "pm list");
    expectPositionals(rest, 0, "pm list");
    return { command: "pm.list", body: {}, textSource: null };
  }
  if (group === "project" && action === "create") {
    allowOnly(values, ["name", "folder", "description"], "project create");
    expectPositionals(rest, 0, "project create");
    if (values.name === undefined || values.folder === undefined) throw new UsageError("hub project create 要 --name 和 --folder");
    const body: Record<string, string> = { name: values.name, folder: expandPath(values.folder, env, cwd) };
    if (values.description !== undefined) body.description = values.description;
    return { command: "project.create", body, textSource: null };
  }
  if (group === "project" && (action === "attach" || action === "detach")) {
    allowOnly(values, [], `project ${action}`);
    expectPositionals(rest, 2, `project ${action}`);
    const [project, folder] = rest as [string, string];
    return { command: `project.${action}`, body: { project, folder: expandPath(folder, env, cwd) }, textSource: null };
  }
  if (group === "project" && action === "assign") {
    allowOnly(values, ["to", "text", "stdin"], "project assign");
    expectPositionals(rest, 1, "project assign");
    if (values.to === undefined) throw new UsageError("hub project assign 要 --to <项目经理名字>");
    const textSource = textSourceOf(values);
    if (textSource === null) throw new UsageError("hub project assign 要交接正文：用 --stdin 从标准输入读，或者 --text <正文>");
    return {
      command: "project.assign",
      body: { project: rest[0] as string, to: values.to },
      textSource,
      textField: "handoff",
    };
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
      throw new UsageError("hub persona edit 要新的性格设定（--stdin 或 --text）或者 --mode，至少一样");
    }
    const body: Record<string, string> = {};
    if (values.mode !== undefined) body.mode = values.mode as PmMode;
    if (values.reason !== undefined) body.reason = values.reason;
    return { command: "persona.edit", body, textSource, textField: "text" };
  }
  throw new UsageError(`不认识的子命令：${[group, action].filter((s) => s !== undefined).join(" ")}`);
}

/** 读到结束，去掉末尾一个换行。超过请求体上限就不再读，报用法错。 */
async function readAllStdin(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer);
    size += buf.length;
    if (size > HUB_MAX_BODY_BYTES) {
      stream.destroy();
      throw new UsageError(`标准输入太长，不能超过 ${HUB_MAX_BODY_BYTES} 字节`);
    }
    chunks.push(buf);
  }
  const text = new TextDecoder("utf-8").decode(Buffer.concat(chunks));
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

type Outcome = { kind: "response"; status: number; body: string } | { kind: "unreachable"; reason: string };

function post(socketPath: string, path: string, token: string, payload: string, timeoutMs: number): Promise<Outcome> {
  return new Promise((done) => {
    let settled = false;
    const finish = (outcome: Outcome) => {
      if (!settled) {
        settled = true;
        done(outcome);
      }
    };
    const req = request(
      {
        socketPath,
        method: "POST",
        path,
        timeout: timeoutMs,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload, "utf8"),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => finish({ kind: "response", status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (err) => finish({ kind: "unreachable", reason: err.message }));
      },
    );
    req.on("timeout", () => {
      finish({ kind: "unreachable", reason: "超时" });
      req.destroy();
    });
    req.on("error", (err: NodeJS.ErrnoException) => finish({ kind: "unreachable", reason: err.code ?? err.message }));
    req.end(payload);
  });
}

function line(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

export async function runHub(io: HubIo): Promise<number> {
  const usage = (reason: string) => {
    io.stderr.write(line(`hub：${reason}`));
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
  if (token === undefined || token === "") return usage(`没有设 ${ENV_HUB_TOKEN}：hub 只能在 agent-hub 启动的会话里用`);
  if (socketPath === undefined || socketPath === "") return usage(`没有设 ${ENV_HUB_SOCK}：hub 只能在 agent-hub 启动的会话里用`);

  const body: Record<string, string> = { ...parsed.body };
  if (parsed.textSource !== null && parsed.textField !== undefined) {
    let text: string;
    try {
      text = parsed.textSource.kind === "stdin" ? await readAllStdin(io.stdin()) : parsed.textSource.value;
    } catch (err) {
      if (err instanceof UsageError) return usage(err.message);
      throw err;
    }
    if (text.trim() === "") return usage(parsed.textSource.kind === "stdin" ? "标准输入读到的正文是空的" : "--text 的正文是空的");
    body[parsed.textField] = text;
  }

  const outcome = await post(socketPath, hubPath(parsed.command), token, JSON.stringify(body), io.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (outcome.kind === "unreachable") {
    io.stderr.write(`${UNREACHABLE_MESSAGE}（${outcome.reason}）\n`);
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
  io.stderr.write(`agent-hub 的回答看不懂（HTTP ${outcome.status}）\n`);
  return HUB_EXIT.rejected;
}
