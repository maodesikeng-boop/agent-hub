import type { Readable } from "node:stream";
import { LOCAL_ERRORS } from "../shared/errors.ts";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN, HUB_EXIT, SELF_RELOAD_AGENT_PATH, hubPath } from "../shared/hub.ts";
import { HUB_CLI_STDIN_IDLE_MS, HUB_CLI_TIMEOUT_MS } from "../shared/limits.ts";
import { ROUTER_DISPATCH_AGENT_PATH } from "../shared/router.ts";
import { HUB_COMMAND, PRODUCT_ID } from "../shared/names.ts";
import { validateSchedulePrompt } from "../shared/schedule.ts";
import { taskGraphSkillBody } from "../shared/task-graph-skill.ts";
import { UsageError, type Parsed } from "./args.ts";
import { renderHelpIndex, renderScopedHelp, resolveHelpTarget } from "./registry.ts";
import { HUB_USAGE, commandUsageFor } from "./usage.ts";
import { TIMEOUT_REASON, readAllStdin, parseHubEndpoint, post } from "./transport.ts";
import { parseCommand } from "./parse.ts";

export { HUB_COMMAND_SPECS, HUB_USAGE, commandUsageFor, type HubCommandSpec } from "./usage.ts";
export { parseHubEndpoint, parseLoopbackTcpEndpoint, type HubEndpointTarget } from "./transport.ts";

const hub = HUB_COMMAND;

export interface HubIo {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  stdin: () => Readable;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  timeoutMs?: number;
  stdinIdleMs?: number;
}

// Must match the daemon's token charset: Node throws on other characters in request headers.
const TOKEN_CHARS = /^[A-Za-z0-9_-]+$/;

const UNREACHABLE_MESSAGE = `${LOCAL_ERRORS.network.text}。${LOCAL_ERRORS.network.hint}`;
const INTERNAL_MESSAGE = "出了意外的错，这条命令没有跑完。重试一次；还不行，把现象告诉用户";
const NO_ANSWER_MESSAGE = `请求已经发给 ${PRODUCT_ID}，但没等到回应`;
const MAYBE_EXECUTED_HINT = `请求可能已经执行，请先用 \`${hub} status\` 确认，别直接重试`;

function line(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function personaStdout(text: string): string {
  if (text === "") return "";
  // edit --stdin consumes one line ending; a final CR may belong to the body.
  return text + (text.endsWith("\r") ? "\r\n" : "\n");
}

export async function runHub(io: HubIo): Promise<number> {
  const usage = (reason: string, includeHelp = true) => {
    io.stderr.write(line(`${hub}：${reason}`));
    if (includeHelp) io.stderr.write(commandUsageFor(io.argv));
    return HUB_EXIT.usage;
  };

  const helpTarget = resolveHelpTarget(io.argv);
  if (helpTarget !== null) {
    switch (helpTarget.kind) {
      case "index":
        io.stdout.write(renderHelpIndex());
        return HUB_EXIT.ok;
      case "all":
        io.stdout.write(HUB_USAGE);
        return HUB_EXIT.ok;
      case "graph-manual":
        io.stdout.write(taskGraphSkillBody());
        return HUB_EXIT.ok;
      case "entries":
        io.stdout.write(renderScopedHelp(helpTarget.entries));
        return HUB_EXIT.ok;
      case "unknown": {
        const hint = helpTarget.suggestions.length > 0 ? `（你是不是想查 ${helpTarget.suggestions.join("、")}？）` : "";
        io.stderr.write(line(`${hub}：没有找到「${helpTarget.query}」的帮助${hint}。看命令索引运行 ${hub} help，看全部展开运行 ${hub} help --all`));
        return HUB_EXIT.usage;
      }
    }
  }

  let parsed: Parsed;
  try {
    parsed = parseCommand(io.argv, io.env, io.cwd);
  } catch (err) {
    if (err instanceof UsageError) return usage(err.message);
    throw err;
  }

  const token = io.env[ENV_HUB_TOKEN];
  const socketPath = io.env[ENV_HUB_SOCK];
  if (token === undefined || token === "") return usage(`没有设 ${ENV_HUB_TOKEN}：${hub} 只能在 ${PRODUCT_ID} 启动的会话里用`, false);
  if (!TOKEN_CHARS.test(token)) return usage(`${ENV_HUB_TOKEN} 里有不该有的字符，不是 ${PRODUCT_ID} 发的令牌`, false);
  if (socketPath === undefined || socketPath === "") return usage(`没有设 ${ENV_HUB_SOCK}：${hub} 只能在 ${PRODUCT_ID} 启动的会话里用`, false);
  const endpointTarget = parseHubEndpoint(socketPath);
  if (endpointTarget === null) {
    return usage(`${ENV_HUB_SOCK} 不是合法的本机守护进程地址（只允许本机 socket / 命名管道或 tcp://127.0.0.1:<端口>）`, false);
  }

  const body: Record<string, unknown> = { ...parsed.body };
  if (parsed.textSource !== null && parsed.textField !== undefined) {
    let text: string;
    try {
      text = parsed.textSource.kind === "stdin" ? await readAllStdin(io.stdin(), io.stdinIdleMs ?? HUB_CLI_STDIN_IDLE_MS) : parsed.textSource.value;
    } catch (err) {
      if (err instanceof UsageError) return usage(err.message);
      throw err;
    }
    if (text.trim() === "" && parsed.textOptional !== true) {
      return usage(parsed.textSource.kind === "stdin" ? "标准输入读到的正文是空的" : `--${parsed.textField} 的正文是空的`);
    }
    if (text.trim() !== "") body[parsed.textField] = parsed.textPrefix !== undefined ? `${parsed.textPrefix}\n${text}` : text;
  }

  if (parsed.command === "schedule.edit" && typeof body.prompt === "string") {
    const checkedPrompt = validateSchedulePrompt(body.prompt);
    if (!checkedPrompt.ok) return usage(checkedPrompt.error);
  }

  const routePath =
    parsed.command === "router.dispatch"
      ? ROUTER_DISPATCH_AGENT_PATH
      : parsed.command === "self.reload"
        ? SELF_RELOAD_AGENT_PATH
        : hubPath(parsed.command);
  const outcome = await post(endpointTarget, routePath, token, JSON.stringify(body), io.timeoutMs ?? HUB_CLI_TIMEOUT_MS);
  if (outcome.kind === "not-sent") return usage("请求没发出去：令牌或参数里有不能放进请求的字符", false);
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
    io.stdout.write(parsed.command === "persona.show" ? personaStdout(r.text) : line(r.text));
    return HUB_EXIT.ok;
  }
  if (r !== null && typeof r === "object" && r.ok === false && typeof r.message === "string") {
    io.stderr.write(line(r.message));
    return HUB_EXIT.rejected;
  }
  io.stderr.write(`${PRODUCT_ID} 的回答看不懂（HTTP ${outcome.status}）\n`);
  return HUB_EXIT.rejected;
}

export async function runHubSafely(io: HubIo): Promise<number> {
  try {
    return await runHub(io);
  } catch {
    io.stderr.write(`${hub}：${INTERNAL_MESSAGE}\n`);
    return HUB_EXIT.internal;
  }
}
