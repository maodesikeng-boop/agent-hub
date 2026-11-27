import { HUB_COMMAND } from "../shared/names.ts";
import { parseDurationMs } from "../shared/schedule.ts";
import { UsageError, allowOnly, expectPositionals, idOf, requireStdin, type GroupArgs, type Parsed } from "./args.ts";

const hub = HUB_COMMAND;

function durationOf(raw: string, flag: string): number {
  const ms = parseDurationMs(raw);
  if (ms === null) throw new UsageError(`${flag} 要写成 15s、30m、2h 或 1h30m 这样的时长`);
  return ms;
}

export function parseWatchCommand({ group, action, rest, values }: GroupArgs): Parsed | undefined {
  if (group !== "watch") return undefined;
  if (action === "add") {
    allowOnly(values, ["until", "every", "after", "max", "graph", "worker", "stdin"], "watch add");
    expectPositionals(rest, 0, "watch add");
    if ((values.until === undefined) === (values.after === undefined)) {
      throw new UsageError(`${hub} watch add 的条件写 --until <命令> 或 --after <时长>，二选一`);
    }
    if (values.after !== undefined && values.every !== undefined) throw new UsageError("--every 只能配 --until");
    if (values.graph !== undefined && values.worker !== undefined) throw new UsageError("--graph 和 --worker 只能写一个");
    const body: Record<string, unknown> = {};
    if (values.until !== undefined) body.until = values.until;
    if (values.every !== undefined) body.everyMs = durationOf(values.every, "--every");
    if (values.after !== undefined) body.afterMs = durationOf(values.after, "--after");
    if (values.max !== undefined) body.maxMs = durationOf(values.max, "--max");
    if (values.graph !== undefined) body.graphId = idOf(values.graph, "watch add --graph", "图");
    if (values.worker !== undefined) body.workerId = idOf(values.worker, "watch add --worker", " Worker ");
    return { command: "watch.add", body, textSource: requireStdin(values, "watch add"), textField: "body" };
  }
  if (action === "list") {
    allowOnly(values, [], "watch list");
    expectPositionals(rest, 0, "watch list");
    return { command: "watch.list", body: {}, textSource: null };
  }
  if (action === "close") {
    allowOnly(values, [], "watch close");
    expectPositionals(rest, 1, "watch close");
    return { command: "watch.close", body: { watchId: idOf(rest[0], "watch close", "在盯条件") }, textSource: null };
  }
  return undefined;
}
