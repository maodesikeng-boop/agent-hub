import { validateAskOptions } from "../shared/domain.ts";
import { MAX_GATE_OPTIONS, WORKER_LOG_MAX_STEPS, WORKER_SEARCH_MAX_LIMIT } from "../shared/limits.ts";
import { HUB_COMMAND } from "../shared/names.ts";
import { AGENT_VENDORS, ALL_EFFORTS, isAgentVendor } from "../shared/vendors.ts";
import {
  UsageError,
  type Parsed,
  type GroupArgs,
  fileArgsOf,
  allowOnly,
  expectPositionals,
  idOf,
  workerIdOf,
  maxTimeMsOf,
  requireStdin,
} from "./args.ts";

const hub = HUB_COMMAND;

export function parseWorkerCommand({ group, action, rest, values }: GroupArgs): Parsed | undefined {
  if (group === "worker" && action === "start") {
    allowOnly(
      values,
      ["title", "vendor", "model", "effort", "max-time", "readonly", "no-worktree", "node", "graph", "stdin"],
      "worker start",
    );
    expectPositionals(rest, 0, "worker start");
    const takeover = values.node !== undefined;
    if (values.title === undefined && !takeover) throw new UsageError(`${hub} worker start 要 --title <标题>`);
    if (values.vendor !== undefined && !isAgentVendor(values.vendor)) {
      throw new UsageError(`--vendor 只能是 ${AGENT_VENDORS.join("、")}`);
    }
    if (values.effort !== undefined && !ALL_EFFORTS.includes(values.effort)) {
      throw new UsageError(`--effort 只能是 ${ALL_EFFORTS.join("、")}`);
    }
    if (values.graph !== undefined && values.node === undefined) {
      throw new UsageError(`${hub} worker start 传 --graph 时要同时传 --node <节点>`);
    }
    const body: Record<string, unknown> = values.title === undefined ? {} : { title: values.title };
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
    if (takeover) {
      return { command: "worker.start", body, textSource: values.stdin === true ? { kind: "stdin" } : null, textField: "task", textOptional: true };
    }
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
    allowOnly(values, [], "worker end");
    expectPositionals(rest, 1, "worker end");
    const body: Record<string, unknown> = { workerId: workerIdOf(rest[0], "worker end") };
    return { command: "worker.end", body, textSource: null };
  }
  if (group === "worker" && action === "list") {
    allowOnly(values, [], "worker list");
    expectPositionals(rest, 0, "worker list");
    return { command: "worker.list", body: {}, textSource: null };
  }
  if (group === "worker" && action === "show") {
    allowOnly(values, ["task", "report"], "worker show");
    if (values.task === true && values.report === true) throw new UsageError("--task 和 --report 只能用一个");
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
  return undefined;
}

export function parseAskCommand({ group, action, rest, positionals, values, env, cwd }: GroupArgs): Parsed | undefined {
  if (group === "ask" && action === "close") {
    allowOnly(values, [], "ask close");
    expectPositionals(rest, 1, "ask close");
    return { command: "ask.close", body: { itemId: idOf(rest[0], "ask close", "卡") }, textSource: null };
  }
  if (group === "ask") {
    allowOnly(values, ["node", "graph", "option", "recommended", "replace", "file", "stdin"], "ask");
    expectPositionals(positionals.slice(1), 0, "ask");
    const body: Record<string, unknown> = {};
    const files = fileArgsOf(values.file, env, cwd);
    if (files !== undefined) body.files = files;
    if (values.graph !== undefined && (values.node === undefined || values.node.trim() === "")) {
      throw new UsageError("--graph 要配合 --node <步骤> 一起用");
    }
    if (values.node !== undefined) {
      const node = values.node.trim();
      if (node === "") throw new UsageError("--node 不能为空");
      if (values.replace !== undefined) throw new UsageError("--replace 不能和 --node 一起用");
      body.node = node;
      if (values.graph !== undefined) body.graphId = idOf(values.graph, "ask", "任务图");
    } else if (values.replace !== undefined) {
      body.replaceItemId = idOf(values.replace, "ask", "卡片");
    }
    let options: string[] | undefined;
    if (values.option !== undefined) {
      const checked = validateAskOptions(values.option);
      if (!checked.ok) throw new UsageError(checked.error);
      if (body.node !== undefined && checked.options.length > MAX_GATE_OPTIONS) {
        throw new UsageError(`步骤拍板卡的选项最多 ${MAX_GATE_OPTIONS} 个`);
      }
      options = checked.options;
      body.options = checked.options;
    }
    if (values.recommended !== undefined) {
      const rec = values.recommended.trim();
      if (rec === "") throw new UsageError("--recommended 不能是空的");
      if (options === undefined) throw new UsageError("--recommended 要配合 --option <选项>... 一起用");
      let matched = options.find((o) => o === rec);
      if (matched === undefined && /^[1-9][0-9]*$/.test(rec)) {
        const oneBased = Number(rec);
        if (oneBased >= 1 && oneBased <= options.length) matched = options[oneBased - 1];
      }
      if (matched === undefined) {
        throw new UsageError(`--recommended 要写某个选项原文或 1 到 ${options.length} 的序号`);
      }
      body.recommended = matched;
    }
    return { command: "ask", body, textSource: requireStdin(values, "ask"), textField: "text" };
  }
  return undefined;
}
