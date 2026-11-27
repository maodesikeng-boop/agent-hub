import { parseArgs } from "node:util";
import { parseHubChecklistArgs } from "../shared/hub-checklist.ts";
import {
  UsageError,
  describeParseError,
  expectPositionals,
  type Options,
  type Parsed,
  type GroupArgs,
  type HubEnv,
  HUB_ARG_OPTIONS,
  findGitBashMangledArg,
} from "./args.ts";
import {
  findRegistryEntry,
  formatMissingActionError,
  isKnownActionGroup,
  suggestSubcommands,
} from "./registry.ts";
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

// self-reload uses boolean --status whereas graph list uses string --status, so it parses with its own flag schema.
const SELF_RELOAD_ARG_OPTIONS = {
  build: { type: "boolean" },
  cancel: { type: "boolean" },
  status: { type: "boolean" },
} as const;

function parseSelfReload(argv: string[]): Parsed {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: SELF_RELOAD_ARG_OPTIONS,
    });
  } catch (err) {
    throw new UsageError(describeParseError(err, ["build", "cancel", "status"]));
  }
  expectPositionals(parsed.positionals.slice(1), 0, "self-reload");
  const { build, cancel, status } = parsed.values;
  const count = Number(build === true) + Number(cancel === true) + Number(status === true);
  if (count > 1) throw new UsageError("--build、--cancel 和 --status 不能同时用");
  const body: Record<string, unknown> = {};
  if (build === true) body.build = true;
  if (cancel === true) body.cancel = true;
  if (status === true) body.status = true;
  return { command: "self.reload", body, textSource: null };
}

function allowedFlagsHintFor(argv: readonly string[]): readonly string[] | undefined {
  const leading: string[] = [];
  for (const token of argv) {
    if (token.startsWith("-")) break;
    leading.push(token);
  }
  return findRegistryEntry(leading[0], leading[1])?.allowedFlags;
}

export function parseCommand(argv: string[], env: HubEnv, cwd: string): Parsed {
  if (argv[0] === "checklist") {
    const checklist = parseHubChecklistArgs(argv.slice(1));
    if (!checklist.ok) throw new UsageError(checklist.reason);
    return { command: "checklist", body: checklist.request, textSource: null };
  }
  const mangled = findGitBashMangledArg(argv, env);
  if (mangled !== null) {
    throw new UsageError(
      `检测到 Git Bash (MSYSTEM) 自动把以 / 开头的参数改写成了安装目录路径（${mangled}）；请改用 --stdin 传正文，或在命令前加 MSYS_NO_PATHCONV=1（或写成 //）`,
    );
  }
  if (argv[0] === "self-reload") return parseSelfReload(argv);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: HUB_ARG_OPTIONS,
    });
  } catch (err) {
    throw new UsageError(describeParseError(err, allowedFlagsHintFor(argv)));
  }
  const values = parsed.values as Options;
  const [group, action, ...rest] = parsed.positionals;
  if (group === undefined) throw new UsageError("缺子命令");

  const args: GroupArgs = { group, action, rest, positionals: parsed.positionals, values, env, cwd };
  for (const parse of GROUP_PARSERS) {
    const result = parse(args);
    if (result !== undefined) return result;
  }
  if (isKnownActionGroup(group)) {
    if (action === undefined) throw new UsageError(formatMissingActionError(group));
    const suggestions = suggestSubcommands(group, action);
    const hint = suggestions.length > 0 ? `（你是不是想写 ${suggestions.map((s) => `${group} ${s}`).join("、")}？）` : "";
    throw new UsageError(`不认识的子命令：${group} ${action}${hint}`);
  }
  const suggestions = suggestSubcommands(undefined, group);
  const hint = suggestions.length > 0 ? `（你是不是想写 ${suggestions.join("、")}？）` : "";
  throw new UsageError(`不认识的子命令：${[group, action].filter((s) => s !== undefined).join(" ")}${hint}`);
}
