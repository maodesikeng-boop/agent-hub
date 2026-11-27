import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { HUB_USAGE_PROMPT, WORKER_HUB_USAGE_PROMPT } from "../daemon/prompt.ts";
import { buildRouterSystemPrompt } from "../daemon/router/prompt.ts";
import { HUB_COMMANDS, HUB_EXIT } from "../shared/hub.ts";
import { HUB_ERROR_SUGGESTIONS_MAX } from "../shared/limits.ts";
import { taskGraphSkillBody } from "../shared/task-graph-skill.ts";
import { runHub } from "./cli.ts";
import {
  HUB_CLI_REGISTRY,
  formatMissingActionError,
  formatPositionalCountError,
  renderFullHelp,
  renderHelpIndex,
  renderScopedHelp,
  resolveHelpTarget,
  suggestFlags,
  suggestSubcommands,
  type HelpResolution,
  type HubCliCommandId,
  type HubCliEntry,
  type HubCommandCategory,
} from "./registry.ts";
import { HUB_USAGE } from "./usage.ts";

async function invokeHub(argv: string[], env: Record<string, string | undefined> = {}) {
  let stdout = "";
  let stderr = "";
  const code = await runHub({
    argv,
    env,
    cwd: "/work/demo",
    stdin: () => Readable.from([]),
    stdout: { write: (chunk: string) => { stdout += chunk; } },
    stderr: { write: (chunk: string) => { stderr += chunk; } },
  });
  return { code, stdout, stderr };
}

describe("S1: progressive-disclosure help and exact scoping", () => {
  it("registers every HUB_COMMANDS entry plus caps, self-reload, and dispatch in HUB_CLI_REGISTRY", () => {
    const ids = new Set<HubCliCommandId>(HUB_CLI_REGISTRY.map((entry: HubCliEntry) => entry.id));
    for (const command of HUB_COMMANDS) {
      expect(ids.has(command), `missing registry entry for ${command}`).toBe(true);
    }
    expect(ids.has("caps")).toBe(true);
    expect(ids.has("self.reload")).toBe(true);
    expect(HUB_CLI_REGISTRY.some((entry) => entry.group === "dispatch")).toBe(true);
    const categories = new Set<HubCommandCategory>(HUB_CLI_REGISTRY.map((entry) => entry.category));
    expect(categories.has("core")).toBe(true);
    expect(categories.has("dispatch")).toBe(true);
  });

  it("classifies bare help, --all, help graph, scoped help, --help, and unknown targets", () => {
    const bare: HelpResolution | null = resolveHelpTarget(["help"]);
    expect(bare).toEqual({ kind: "index" });
    expect(resolveHelpTarget(["help", "--all"])).toEqual({ kind: "all" });
    expect(resolveHelpTarget(["help", "graph"])).toEqual({ kind: "graph-manual" });

    const routerHelp = resolveHelpTarget(["help", "router"]);
    expect(routerHelp?.kind).toBe("entries");
    if (routerHelp?.kind === "entries") {
      expect(routerHelp.entries.map((e) => e.cli)).toEqual(["router report"]);
    }

    const graphCreateHelp = resolveHelpTarget(["help", "graph", "create"]);
    expect(graphCreateHelp?.kind).toBe("entries");
    if (graphCreateHelp?.kind === "entries") {
      expect(graphCreateHelp.entries.map((e) => e.cli)).toEqual(["graph create"]);
    }

    const flagHelp = resolveHelpTarget(["worker", "start", "--help"]);
    expect(flagHelp?.kind).toBe("entries");
    if (flagHelp?.kind === "entries") {
      expect(flagHelp.entries.map((e) => e.cli)).toEqual(["worker start"]);
    }

    const unknownHelp = resolveHelpTarget(["help", "workr"]);
    expect(unknownHelp?.kind).toBe("unknown");
    if (unknownHelp?.kind === "unknown") {
      expect(unknownHelp.suggestions).toContain("worker");
    }
    expect(resolveHelpTarget(["status"])).toBeNull();
  });

  it("renders a compact index under 4 KB for bare hub help and full manual for hub help --all", async () => {
    const indexText = renderHelpIndex();
    expect(Buffer.byteLength(indexText, "utf8")).toBeLessThan(4_096);
    expect(indexText).toContain("hub help <组>");
    expect(indexText).toContain("hub help --all");

    const fullText = renderFullHelp();
    expect(fullText).toContain("hub router report");
    expect(fullText).toContain("hub self-reload");

    const bare = await invokeHub(["help"]);
    expect(bare.code).toBe(HUB_EXIT.ok);
    expect(Buffer.byteLength(bare.stdout, "utf8")).toBeLessThan(4_096);

    const all = await invokeHub(["help", "--all"]);
    expect(all.code).toBe(HUB_EXIT.ok);
    expect(all.stdout).toBe(HUB_USAGE);
  });

  it("returns focused scoped help for subcommands and --help/-h without dumping unrelated commands", async () => {
    const routerRes = await invokeHub(["help", "router"]);
    expect(routerRes.code).toBe(HUB_EXIT.ok);
    expect(routerRes.stdout).toContain("hub router report");
    expect(routerRes.stdout).not.toContain("hub worker start");
    expect(Buffer.byteLength(routerRes.stdout, "utf8")).toBeLessThan(2_048);

    const workerStartRes = await invokeHub(["worker", "start", "--help"]);
    expect(workerStartRes.code).toBe(HUB_EXIT.ok);
    expect(workerStartRes.stdout).toContain("hub worker start");
    expect(workerStartRes.stdout).not.toContain("hub worker search");
    expect(workerStartRes.stdout).toContain("上限：");

    const graphCreateRes = await invokeHub(["help", "graph", "create"]);
    expect(graphCreateRes.code).toBe(HUB_EXIT.ok);
    expect(graphCreateRes.stdout).toContain("hub graph create");
    expect(graphCreateRes.stdout).not.toContain("# 任务图手册");

    const dispatchRes = await invokeHub(["help", "dispatch"]);
    expect(dispatchRes.code).toBe(HUB_EXIT.ok);
    expect(dispatchRes.stdout).toContain("hub dispatch pm");
    expect(dispatchRes.stdout).not.toContain("hub persona edit");

    const reloadRes = await invokeHub(["self-reload", "--help"]);
    expect(reloadRes.code).toBe(HUB_EXIT.ok);
    expect(reloadRes.stdout).toContain("hub self-reload");
    expect(reloadRes.stdout).not.toContain("hub worker start");

    const scoped = renderScopedHelp(HUB_CLI_REGISTRY.filter((e) => e.group === "router"));
    expect(scoped).toContain("hub router report");
  });

  it("exits with usage code 2 and suggestions on unknown help target, and never dumps full help on missing HUB_TOKEN", async () => {
    const unknown = await invokeHub(["help", "nonexistent"]);
    expect(unknown.code).toBe(HUB_EXIT.usage);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toContain("nonexistent");
    expect(Buffer.byteLength(unknown.stderr, "utf8")).toBeLessThan(2_048);

    const noToken = await invokeHub(["status"]);
    expect(noToken.code).toBe(HUB_EXIT.usage);
    expect(noToken.stderr).toContain("HUB_TOKEN");
    expect(Buffer.byteLength(noToken.stderr, "utf8")).toBeLessThan(1_024);
  });

  it("regression: hub help graph still returns the Task Graph manual", async () => {
    const res = await invokeHub(["help", "graph"]);
    expect(res.code).toBe(HUB_EXIT.ok);
    expect(res.stdout).toBe(taskGraphSkillBody());
  });
});

describe("S2: actionable CLI usage errors and recovery suggestions", () => {
  it("suggests close subcommands and flags bounded by HUB_ERROR_SUGGESTIONS_MAX", () => {
    const subSuggestions = suggestSubcommands("worker", "stat");
    expect(subSuggestions.length).toBeGreaterThan(0);
    expect(subSuggestions.length).toBeLessThanOrEqual(HUB_ERROR_SUGGESTIONS_MAX);
    expect(subSuggestions).toContain("start");

    const flagSuggestions = suggestFlags("--tite", ["title", "vendor", "model", "stdin"]);
    expect(flagSuggestions).toEqual(["--title"]);

    expect(formatMissingActionError("worker")).toContain("start");
    expect(formatPositionalCountError("graph show", { min: 0, max: 1, hint: "[<图编号>]" }, 2)).toContain("2");
  });

  it("prints group actions on bare group, closest suggestion on typo, single-command usage on bad ask flag, and expected count on extra positionals", async () => {
    const bareGroup = await invokeHub(["worker"]);
    expect(bareGroup.code).toBe(HUB_EXIT.usage);
    expect(bareGroup.stderr).not.toContain("不认识的子命令：worker");
    expect(bareGroup.stderr).toContain("start");
    expect(bareGroup.stderr).toContain("show");

    const typo = await invokeHub(["worker", "stat"]);
    expect(typo.code).toBe(HUB_EXIT.usage);
    expect(typo.stderr).toContain("start");

    const badFlag = await invokeHub(["worker", "start", "--tite", "hi"]);
    expect(badFlag.code).toBe(HUB_EXIT.usage);
    expect(badFlag.stderr).toContain("--title");

    const badAskFlag = await invokeHub(["ask", "--foo"]);
    expect(badAskFlag.code).toBe(HUB_EXIT.usage);
    expect(badAskFlag.stderr).toContain("hub ask ");
    expect(badAskFlag.stderr).not.toContain("hub ask close");

    const extraPos = await invokeHub(["graph", "show", "1", "2"]);
    expect(extraPos.code).toBe(HUB_EXIT.usage);
    expect(extraPos.stderr).toContain("2");
    expect(extraPos.stderr).toContain("1");
  });
});

describe("S10: prompt cache stability and clean copy", () => {
  it("regression: system prompts omit hub caps and stay free of extra help bloat", () => {
    expect(HUB_USAGE_PROMPT).not.toContain("hub caps");
    expect(WORKER_HUB_USAGE_PROMPT).not.toContain("hub caps");
    expect(buildRouterSystemPrompt()).not.toContain("hub caps");
  });
});

function walkProductionTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkProductionTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("S11: shipped hub command hints match valid CLI commands", () => {
  it("every ${HUB_COMMAND} <group> <action> hint in src/daemon and src/shared resolves to a real command", () => {
    const validActionsByGroup = new Map<string, Set<string>>();
    for (const command of HUB_COMMANDS) {
      const [group, action] = command.split(".");
      if (group && action) {
        let actions = validActionsByGroup.get(group);
        if (!actions) {
          actions = new Set<string>();
          validActionsByGroup.set(group, actions);
        }
        actions.add(action);
      }
    }
    const groupsWithActions = [...validActionsByGroup.keys()].join("|");
    const pattern = new RegExp(`\\$\\{HUB_COMMAND\\} (${groupsWithActions}) ([a-z][a-z-]*)`, "g");

    const invalid: string[] = [];
    for (const root of ["src/daemon", "src/shared"]) {
      for (const file of walkProductionTsFiles(join(process.cwd(), root))) {
        const lines = readFileSync(file, "utf8").split("\n");
        for (let idx = 0; idx < lines.length; idx++) {
          const line = lines[idx]!;
          for (const match of line.matchAll(pattern)) {
            const group = match[1]!;
            const action = match[2]!;
            if (!validActionsByGroup.get(group)?.has(action)) {
              const rel = file.slice(process.cwd().length + 1);
              invalid.push(`${rel}:${idx + 1}: "${group} ${action}"`);
            }
          }
        }
      }
    }

    expect(invalid, `found invalid hub subcommand hints: ${invalid.join(", ")}`).toEqual([]);
  });
});
