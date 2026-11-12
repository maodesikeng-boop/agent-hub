// 检查里认命令的小工具：读没读 diff、看没看证据（设计 4.2 的 A1、A2）。写松了、写反了在这里暴露。
import { describe, expect, it } from "vitest";
import {
  checkedThenMerged,
  codeReadOf,
  evidenceOf,
  isDiffRead,
  jobDone,
  loadedBeforeGraph,
  manualLoadOf,
  manualLoadsRecorded,
  mergedGreen,
  noDiffBeforeMerge,
  noGraph,
  ranCommands,
  shellSegments,
  workerCap,
} from "./checks.ts";
import type { FactHubCall, FactTool, Facts, GhCall } from "./types.ts";

const bash = (command: string): FactTool => ({ messageId: 1, at: 0, name: "Bash", input: { command } });
const read = (file_path: string): FactTool => ({ messageId: 1, at: 0, name: "Read", input: { file_path } });

describe("shellSegments", () => {
  it("按 && ; | 换行切开，去掉开头的环境变量赋值", () => {
    expect(shellSegments(`GH_TOKEN="$(gh auth token --user x)" gh pr checks 288 | head && git diff --stat; echo ok`)).toEqual(["gh pr checks 288", "head", "git diff --stat", "echo ok"]);
  });
});

describe("isDiffRead：读完整改动算，只看名单或统计不算", () => {
  it.each([
    ["git diff main...hub/1-x", true],
    ["git -C /w diff HEAD~1", true],
    ["git show da36ed7", true],
    ["git show da36ed7:src/web/x.tsx", true],
    ["git log -p -1", true],
    ["gh pr diff 288", true],
    ["git diff --stat main", false],
    ["git diff --name-only HEAD~1", false],
    ["git show --stat da36ed7", false],
    ["git show -s --format=%s da36ed7", false],
    ["git log --oneline -5", false],
    ["gh pr diff 288 --name-only", false],
    ["git status", false],
  ])("%s → %s", (seg, expected) => {
    expect(isDiffRead(seg)).toBe(expected);
  });
});

describe("codeReadOf：验收时读代码", () => {
  const worktrees = ["/data/worktrees/1/1"];
  const changed = ["src/web/components/RouterWorkbench.tsx"];
  it("读 worktree 里的源码、读改动名单里的文件、cat 它们、完整 diff 都算", () => {
    expect(codeReadOf(read("/data/worktrees/1/1/src/a.ts"), worktrees, changed)).toContain("读文件");
    expect(codeReadOf(read("/repo/src/web/components/RouterWorkbench.tsx"), worktrees, changed)).toContain("读文件");
    expect(codeReadOf(bash("sed -n '1,80p' /data/worktrees/1/1/src/web/components/RouterWorkbench.tsx"), worktrees, changed)).toContain("读代码");
    expect(codeReadOf(bash("cd /repo && git diff main...hub/1-x | head -200"), worktrees, changed)).toContain("读 diff");
  });
  it("看截图、读别处的文件、只看统计不算", () => {
    expect(codeReadOf(read("/data/worktrees/1/1/shots/m.png"), worktrees, changed)).toBeNull();
    expect(codeReadOf(read("/repo/AGENTS.md"), worktrees, changed)).toBeNull();
    expect(codeReadOf(bash("git diff --stat main...hub/1-x"), worktrees, changed)).toBeNull();
  });
  it("H2 真机：读 docs/*.md、README、AGENTS.md 等文档核对数字不算读代码（哪怕在 worktree 里、哪怕是改动名单里的）", () => {
    const withDoc = [...changed, "docs/ui-standard.md"];
    expect(codeReadOf(read("/data/worktrees/1/1/docs/ui-standard.md"), worktrees, withDoc)).toBeNull();
    expect(codeReadOf(read("/repo/docs/ui-standard.md"), worktrees, withDoc)).toBeNull();
    expect(codeReadOf(read("/data/worktrees/1/1/README.md"), worktrees, changed)).toBeNull();
    expect(codeReadOf(read("/data/worktrees/1/1/AGENTS.md"), worktrees, changed)).toBeNull();
    expect(codeReadOf(bash("cat /data/worktrees/1/1/docs/ui-standard.md"), worktrees, withDoc)).toBeNull();
    expect(codeReadOf(bash("sed -n '1,40p' /data/worktrees/1/1/docs/ui-standard.md"), worktrees, withDoc)).toBeNull();
    expect(codeReadOf(bash("git diff --name-only main...hub/1-x"), worktrees, changed)).toBeNull();
  });
  it("源码仍严判：.ts .tsx .js .rs .swift .css（在 worktree 里或在改动名单里），不带 --stat/--name-only 的 git diff", () => {
    for (const f of ["src/a.ts", "src/b.tsx", "scripts/c.js", "apps/windows/crates/x/src/lib.rs", "apps/macos/D.swift", "src/web/styles.css"]) {
      expect(codeReadOf(read(`/data/worktrees/1/1/${f}`), worktrees, changed), f).toContain("读文件");
      expect(codeReadOf(bash(`cat /data/worktrees/1/1/${f}`), worktrees, changed), f).toContain("读代码");
    }
    expect(codeReadOf(read("/repo/src/web/styles.css"), worktrees, ["src/web/styles.css"])).toContain("读文件");
    expect(codeReadOf(bash("git diff main...hub/1-x"), worktrees, changed)).toContain("读 diff");
    expect(codeReadOf(bash("gh pr diff 288"), worktrees, changed)).toContain("读 diff");
  });
});

describe("evidenceOf：看证据", () => {
  it("看截图、看改动名单算；读别的不算", () => {
    expect(evidenceOf(read("/tmp/shots/mobile.png"))).toContain("看截图");
    expect(evidenceOf(bash("git diff --stat main...hub/1-x"))).toContain("改动名单");
    expect(evidenceOf(read("/repo/src/a.ts"))).toBeNull();
    expect(evidenceOf(bash("git diff main"))).toBeNull();
  });
});

// ---- 防过度建图（docs/orchestration-skill-design.md 第 8.3 节）：T1、T2、L1、L2 和简单活的几条 ----

const facts = (over: Partial<Facts> = {}): Facts => ({
  pmConversationId: 1,
  pmSessionIds: [1],
  startedAt: 0,
  endedAt: 100,
  hubCalls: [],
  workers: [],
  graphs: [],
  tools: [],
  messages: [],
  gh: [],
  recorded: [],
  personaChanges: [],
  personaSeen: [],
  injected: [],
  ...over,
});
const hubCall = (id: number, command: string, at: number, args: Record<string, unknown> = {}): FactHubCall => ({ id, command, args, ok: true, at });
const tool = (name: string, input: Record<string, unknown>, at: number): FactTool => ({ messageId: at, at, name, input });
const SKILL_FILE = "/data/state/launch/7/skills/fusa-task-graph/SKILL.md";

describe("T1 简单活不建图、T2 Worker 数上限", () => {
  it("什么都没做是不适用；动了手没建图过；建了图不过", () => {
    expect(noGraph().run(facts()).status).toBe("na");
    expect(noGraph().run(facts({ tools: [bash("pi-bridge filter pi coder")] })).status).toBe("pass");
    const built = noGraph().run(facts({ hubCalls: [hubCall(3, "graph.create", 5)] }));
    expect(built.status).toBe("fail");
    expect(built.evidence[0]).toContain("hub_calls#3 graph.create");
  });

  it("上限：不超过就过（什么都没做不适用）；正好：不相等就不过（要求有）", () => {
    const starts = (n: number) => facts({ hubCalls: Array.from({ length: n }, (_, i) => hubCall(i + 1, "worker.start", i)) });
    expect(workerCap({ max: 1 }).run(facts()).status).toBe("na");
    expect(workerCap({ max: 1 }).run(starts(1)).status).toBe("pass");
    expect(workerCap({ max: 1 }).run(starts(2)).status).toBe("fail");
    expect(workerCap({ max: 0 }).run(facts({ tools: [bash("gh pr checks 238")] })).status).toBe("pass");
    expect(workerCap({ exact: 1 }).requiresAction).toBe(true);
    expect(workerCap({ max: 1 }).requiresAction).toBe(false);
    expect(workerCap({ exact: 1 }).run(starts(0)).status).toBe("fail");
    expect(workerCap({ exact: 1 }).run(starts(1)).status).toBe("pass");
    expect(workerCap({ exact: 1 }).run(starts(2)).status).toBe("fail");
  });
});

describe("L1 建图前加载了手册、L2 简单活加载次数", () => {
  it("认得出加载痕迹：技能工具、读 SKILL.md（读文件工具或 cat）、hub help graph；别的不算", () => {
    expect(manualLoadOf(tool("Skill", { skill: "fusa:fusa-task-graph" }, 1))).toContain("加载技能");
    expect(manualLoadOf(read(SKILL_FILE))).toContain("读手册");
    expect(manualLoadOf(bash(`cat ${SKILL_FILE}`))).toContain("读手册");
    expect(manualLoadOf(bash("hub help graph | head -40"))).toBe("hub help graph");
    expect(manualLoadOf(tool("Skill", { skill: "orchestration" }, 1))).toBeNull();
    expect(manualLoadOf(bash("hub graph show"))).toBeNull();
    expect(manualLoadOf(read("/repo/docs/orchestration-skill-design.md"))).toBeNull();
  });

  it("没建图不适用；建图前加载了过；没加载、或者建完才加载都不过", () => {
    const create = hubCall(9, "graph.create", 50);
    expect(loadedBeforeGraph().run(facts({ tools: [read(SKILL_FILE)] })).status).toBe("na");
    expect(loadedBeforeGraph().run(facts({ hubCalls: [create], tools: [tool("Skill", { skill: "fusa:fusa-task-graph" }, 40)] })).status).toBe("pass");
    expect(loadedBeforeGraph().run(facts({ hubCalls: [create], tools: [tool("Bash", { command: "hub help graph" }, 45)] })).status).toBe("pass");
    expect(loadedBeforeGraph().run(facts({ hubCalls: [create] })).status).toBe("fail");
    const late = loadedBeforeGraph().run(facts({ hubCalls: [create], tools: [tool("Read", { file_path: SKILL_FILE }, 60)] }));
    expect(late.status).toBe("fail");
    expect(late.evidence.some((e) => e.startsWith("之后才加载"))).toBe(true);
    expect(loadedBeforeGraph().kind).toBe("guard");
  });

  it("L2 只记录：永远不适用，原因里写次数", () => {
    const def = manualLoadsRecorded();
    expect(def.kind).toBe("record");
    expect(def.run(facts()).reason).toBe("加载了 0 次");
    const two = def.run(facts({ tools: [read(SKILL_FILE), bash("hub help graph")] }));
    expect(two.status).toBe("na");
    expect(two.reason).toBe("加载了 2 次");
  });
});

describe("简单活做成了没有：D1、E1、K3 的 M1、R6、A1", () => {
  const rec = (toolName: string, argv: string[], at = 1) => ({ tool: toolName, argv, cwd: "/", at, stub: 0 });
  it("D1：派了做这件事的 Worker，或者自己跑了其中一条命令", () => {
    const def = jobDone("装上了", { keywords: ["pi-bridge"], commands: [{ tool: "curl", match: "install.sh" }] });
    expect(def.run(facts()).status).toBe("fail");
    expect(def.run(facts({ recorded: [rec("curl", ["-fsSL", "https://pi-bridge.example.dev/install.sh"])] })).status).toBe("pass");
    const worker = { id: 1, title: "装 pi-bridge", task: "", vendor: "claude", model: null, readonly: false, branch: null, worktreePath: null, status: "running", createdAt: 1 };
    expect(def.run(facts({ workers: [worker] })).reason).toBe("派了 Worker 去做");
  });

  it("E1：替身记录和 hub 调用里都要有", () => {
    const def = ranCommands([{ tool: "pi-bridge", match: "filter pi coder" }], [{ command: "models", args: { vendor: "pi", refresh: true } }]);
    expect(def.run(facts()).status).toBe("fail");
    expect(def.run(facts({ recorded: [rec("pi-bridge", ["filter", "pi", "coder"])] })).status).toBe("fail");
    expect(def.run(facts({ recorded: [rec("pi-bridge", ["filter", "pi", "coder"])], hubCalls: [hubCall(1, "models", 2, { vendor: "pi", refresh: true })] })).status).toBe("pass");
  });

  it("K3：先查检查再合（M1）、合并时是绿的（R6）、合并前不读 diff（A1）", () => {
    const gh = (seq: number, action: string, extra: Partial<GhCall> = {}): GhCall => ({ seq, at: seq, argv: action.split(" "), cwd: "/", action, exitCode: 0, pr: 238, checks: "pass", ...extra });
    expect(checkedThenMerged(238).run(facts({ gh: [gh(1, "pr merge")] })).status).toBe("fail");
    expect(checkedThenMerged(238).run(facts({ gh: [gh(1, "pr checks"), gh(2, "pr merge")] })).status).toBe("pass");
    expect(mergedGreen(238).run(facts()).status).toBe("na");
    expect(mergedGreen(238).run(facts({ gh: [gh(2, "pr merge", { checks: "fail" })] })).status).toBe("fail");
    expect(noDiffBeforeMerge(238).run(facts()).status).toBe("na");
    expect(noDiffBeforeMerge(238).run(facts({ gh: [gh(1, "pr checks"), gh(2, "pr merge")] })).status).toBe("pass");
    expect(noDiffBeforeMerge(238).run(facts({ gh: [gh(1, "pr diff"), gh(2, "pr merge")] })).status).toBe("fail");
    expect(noDiffBeforeMerge(238).run(facts({ tools: [bash("git diff main...hub/340-x")] })).status).toBe("fail");
  });
});
