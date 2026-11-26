import { TASK_GRAPH_STATUSES, validateAskOptions } from "../shared/domain.ts";
import { HUB_COMMAND } from "../shared/names.ts";
import { UsageError, type Parsed, type GroupArgs, allowOnly, expectPositionals, idOf, requireStdin } from "./args.ts";

const hub = HUB_COMMAND;

export function parseGraphAuthorCommand({ group, action, rest, values }: GroupArgs): Parsed | undefined {
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
    const body: Record<string, unknown> = { node: nodeKey };
    if (values.graph !== undefined) body.graphId = idOf(values.graph, "graph ask", "任务图");
    let options: string[] | undefined;
    if (values.option !== undefined) {
      const checked = validateAskOptions(values.option, "ask.stepOptions");
      if (!checked.ok) throw new UsageError(checked.error);
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
    if (values.question !== undefined) {
      if (values.question.trim() === "") throw new UsageError("--question 不能是空的");
      const q = values.question.trim();
      body.text = q;
      if (values.stdin === true) {
        return {
          command: "ask",
          body,
          textSource: { kind: "stdin" },
          textField: "text",
          textOptional: true,
          textPrefix: `${q}\n`,
        };
      }
      return { command: "ask", body, textSource: null };
    }
    return { command: "ask", body, textSource: requireStdin(values, "graph ask"), textField: "text" };
  }
  return undefined;
}

export function parseGraphStepCommand({ group, action, rest, values }: GroupArgs): Parsed | undefined {
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
    const nodeKey = (rest[0] ?? "").trim();
    if (nodeKey === "") throw new UsageError("节点名称不能是空的");
    const body: Record<string, unknown> = { nodeKey };
    if (values.graph !== undefined) body.graphId = idOf(values.graph, "graph done", "任务图");
    if (values.pr !== undefined) body.prUrl = values.pr;
    if (values.commit !== undefined) body.commit = values.commit;
    if (values.branch !== undefined) body.branch = values.branch;
    if (values.summary !== undefined) {
      if (values.summary.trim() === "") throw new UsageError("--summary 的正文是空的");
      body.summary = values.summary;
    }
    return {
      command: "graph.done",
      body,
      textSource: values.stdin === true ? ({ kind: "stdin" } as const) : null,
      textField: "note",
    };
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
  if (group === "graph" && action === "finish") {
    allowOnly(values, ["unmerged-ok", "stdin"], "graph finish");
    if (rest.length > 1) throw new UsageError(`${hub} graph finish 的参数个数不对`);
    const body: Record<string, unknown> = {};
    if (rest[0] !== undefined) body.graphId = idOf(rest[0], "graph finish", "任务图");
    if (values["unmerged-ok"] === true) body.unmergedOk = true;
    return { command: "graph.finish", body, textSource: requireStdin(values, "graph finish"), textField: "summary" };
  }
  return undefined;
}
