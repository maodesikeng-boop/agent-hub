import { parseArgs } from "node:util";
import {
  UsageError,
  describeParseError,
  type Options,
  type Parsed,
  type GroupArgs,
  type HubEnv,
  HUB_ARG_OPTIONS,
  findGitBashMangledArg,
} from "./args.ts";
import { parseCoreCommand, parseScheduleCommand } from "./parse-core.ts";
import { parseWorkerCommand, parseAskCommand } from "./parse-worker.ts";
import { parseRouterCommand } from "./parse-router.ts";
import { parseGraphAuthorCommand, parseGraphStepCommand } from "./parse-graph.ts";
import { parseDispatchPmCommand, parseDispatchWorkerCommand } from "./parse-dispatch.ts";

const GROUP_PARSERS: readonly ((args: GroupArgs) => Parsed | undefined)[] = [
  parseCoreCommand,
  parseWorkerCommand,
  parseAskCommand,
  parseScheduleCommand,
  parseRouterCommand,
  parseGraphAuthorCommand,
  parseGraphStepCommand,
  parseDispatchPmCommand,
  parseDispatchWorkerCommand,
];

export function parseCommand(argv: string[], env: HubEnv, cwd: string): Parsed | "help" | "help-graph" {
  const mangled = findGitBashMangledArg(argv, env);
  if (mangled !== null) {
    throw new UsageError(
      `检测到 Git Bash (MSYSTEM) 自动把以 / 开头的参数改写成了安装目录路径（${mangled}）；请改用 --stdin 传正文，或在命令前加 MSYS_NO_PATHCONV=1（或写成 //）`,
    );
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: HUB_ARG_OPTIONS,
    });
  } catch (err) {
    throw new UsageError(describeParseError(err));
  }
  const values = parsed.values as Options;
  const [group, action, ...rest] = parsed.positionals;
  if (group === "help" && action === "graph") return "help-graph";
  if (values.help === true || group === "help") return "help";
  if (group === undefined) throw new UsageError("缺子命令");

  const args: GroupArgs = { group, action, rest, positionals: parsed.positionals, values, env, cwd };
  for (const parse of GROUP_PARSERS) {
    const result = parse(args);
    if (result !== undefined) return result;
  }
  throw new UsageError(`不认识的子命令：${[group, action].filter((s) => s !== undefined).join(" ")}`);
}
