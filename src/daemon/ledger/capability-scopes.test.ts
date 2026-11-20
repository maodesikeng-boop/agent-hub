import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Change } from "../../shared/api.ts";
import type { PmId, SessionId, WorkerId } from "../../shared/domain.ts";
import type { HubArgs } from "../../shared/hub.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import { MAX_SETUP_COMMAND_BYTES } from "../../shared/limits.ts";
import { migrate, type Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger, type SqliteLedger } from "./index.ts";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
}

describe("统一能力底座：总助能力、Worker 三档、项目准备命令", () => {
  let db: Db;
  let root: string;
  let ledger: SqliteLedger;
  let changes: Change[];
  let lin: { pmId: PmId; sessionId: SessionId; projectId: number };
  let now = 1_700_000_000_000;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-caps-")));
    const dataHome = join(root, "data");
    const repo = join(root, "repo");
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-b", "main");
    writeFileSync(join(repo, "README.md"), "# repo\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "init");
    db = openTestDb();
    migrate(db);
    ledger = createLedger(db, {
      now: () => ++now,
      pmHomeRoot: join(dataHome, "pm-home"),
      dataHome,
      worktreesDir: join(dataHome, "worktrees"),
      launchDir: join(dataHome, "state", "launch"),
      userHome: root,
      osSandboxed: () => true,
      models: { current: () => null, availability: () => "available" },
      resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    });
    const created = ledger.createPm({ name: "林经理", mode: "manage_only", persona: "", folder: repo });
    lin = { pmId: created.pm.id, sessionId: created.sessionId, projectId: created.project!.id };
    changes = [];
    ledger.onChange((c) => changes.push(c));
  });

  afterEach(() => {
    ledger.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const ctx = { workspace: { kind: "ok", isRepoWithCommit: true, hasUncommittedChanges: false } } as const;
  const start = (args: HubArgs<"worker.start">) => ledger.hubCall(lin.sessionId, "worker.start", args, ctx);

  const workerCapsOf = (workerId: WorkerId) => {
    const session = db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE worker_id = ?", workerId)!;
    return ledger.getLaunchContext(session.id).workerCapabilities ?? { mode: "inherit" };
  };

  it("总助默认一个不带；只存和默认不同的部分，改回默认就清空", () => {
    expect(ledger.getRouterCapabilityPolicy()).toEqual({ base: { skill: "none", mcp: "none", connector: "none" }, overrides: {} });
    const next = ledger.patchRouterCapabilities({ base: { skill: "all" }, set: { "mcp:codegraph": true, "skill:aws-auth": false } });
    expect(next).toEqual({ base: { skill: "all", mcp: "none", connector: "none" }, overrides: { "mcp:codegraph": true, "skill:aws-auth": false } });
    expect(ledger.getRouterCapabilityPolicy()).toEqual(next);
    expect(db.all("SELECT kind, base FROM router_capability_policies")).toEqual([{ kind: "skill", base: "all" }]);
    ledger.patchRouterCapabilities({ base: { skill: "none" }, set: { "mcp:codegraph": null, "skill:aws-auth": null } });
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM router_capability_policies")!.c).toBe(0);
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM router_capability_overrides")!.c).toBe(0);
    expect(() => ledger.patchRouterCapabilities({ set: { "no-colon": true } })).toThrowError(LedgerRequestError);
    expect(ledger.getPmCapabilityPolicy(lin.pmId).base).toEqual({ skill: "all", mcp: "all", connector: "all" });
  });

  it("项目准备命令：网页设置与清空写回 toProject 并推 project.updated；PM 用 hub 改也推", () => {
    expect(ledger.snapshot().projects.find((p) => p.id === lin.projectId)?.setupCommand).toBeNull();
    const multi = "pnpm install --frozen-lockfile\npnpm exec playwright install chromium";
    expect(ledger.setProjectSetupCommand(lin.projectId, multi).setupCommand).toBe(multi);
    expect(changes.filter((c) => c.type === "project.updated").map((c) => (c.data as { project: { setupCommand: string | null } }).project.setupCommand)).toEqual([multi]);
    expect(ledger.snapshot().projects.find((p) => p.id === lin.projectId)?.setupCommand).toBe(multi);
    expect(ledger.hubCall(lin.sessionId, "status", {}).data).toMatchObject({ setupCommand: multi });
    expect(ledger.setProjectSetupCommand(lin.projectId, null).setupCommand).toBeNull();
    for (const bad of ["   ", "a\0b", "x".repeat(MAX_SETUP_COMMAND_BYTES + 1)]) {
      expect(() => ledger.setProjectSetupCommand(lin.projectId, bad)).toThrowError(LedgerRequestError);
    }
    expect(() => ledger.setProjectSetupCommand(9_999, "x")).toThrowError(/9999/);
    ledger.hubCall(lin.sessionId, "project.setup", { command: "make deps" });
    expect(changes.at(-1)).toMatchObject({ type: "project.updated", data: { project: { id: lin.projectId, setupCommand: "make deps" } } });
  });

  it("hub worker start 三档：默认继承不落行，none 落行，custom 去重排序且回执点出项目里关掉的项", () => {
    ledger.patchPmCapabilities(lin.pmId, { set: { "mcp:slack": false } });
    const inherit = start({ title: "默认", task: "t" });
    expect(workerCapsOf(inherit.data.worker.id)).toEqual({ mode: "inherit" });
    expect(db.get<{ c: number }>("SELECT count(*) AS c FROM worker_capabilities")!.c).toBe(0);

    const none = start({ title: "不带", task: "t", caps: "none", readonly: true });
    expect(workerCapsOf(none.data.worker.id)).toEqual({ mode: "none" });
    expect(none.text).toContain("不带外接能力");
    expect(none.data.worker.readonly).toBe(true);

    const custom = start({
      title: "点名",
      task: "t",
      caps: "custom",
      allow: ["mcp:slack", "mcp:codegraph", "mcp:codegraph"],
    });
    expect(workerCapsOf(custom.data.worker.id)).toEqual({ mode: "custom", allow: ["mcp:codegraph", "mcp:slack"] });
    expect(custom.text).toContain("外接能力只挂 mcp:codegraph");
    expect(custom.text).toContain("mcp:slack 在项目能力设置里是关的");

    for (const args of [{ caps: "custom" }, { caps: "none", allow: ["mcp:x"] }, { allow: ["mcp:x"] }, { caps: "all" }, { caps: "custom", allow: ["bogus"] }]) {
      expect(() => start({ title: "坏", task: "t", ...(args as object) })).toThrowError(LedgerRequestError);
    }
  });

  it("任务图步骤带 caps：自动开工的 Worker 照步骤挂；patch 能改能用 null 恢复默认；坏配置建图时就拦下", () => {
    const created = ledger.hubCall(lin.sessionId, "graph.create", {
      specJson: JSON.stringify({
        title: "能力图",
        steps: [
          { key: "impl", title: "实现", brief: "做", caps: "custom", allow: ["skill:frontend-rules"] },
          { key: "check", title: "核对", brief: "查", caps: "none" },
        ],
      }),
    });
    const graphId = created.data.graph.id;
    const impl = created.data.graph.nodes.find((n) => n.key === "impl")!;
    expect(workerCapsOf(impl.activeWorkerId!)).toEqual({ mode: "custom", allow: ["skill:frontend-rules"] });

    const stepCaps = (key: string) =>
      db.get<{ capabilities_json: string }>(
        "SELECT c.capabilities_json FROM task_graph_step_capabilities c JOIN task_graph_steps s ON s.id = c.step_id WHERE s.graph_id = ? AND s.node_key = ?",
        graphId,
        key,
      )?.capabilities_json ?? null;
    expect(stepCaps("check")).toBe(JSON.stringify({ mode: "none" }));
    ledger.hubCall(lin.sessionId, "graph.patch", { graphId, specJson: JSON.stringify({ updateSteps: [{ key: "check", caps: null }] }) });
    expect(stepCaps("check")).toBeNull();
    ledger.hubCall(lin.sessionId, "graph.patch", {
      graphId,
      specJson: JSON.stringify({ updateSteps: [{ key: "check", caps: "custom", allow: ["mcp:codegraph"] }] }),
    });
    expect(stepCaps("check")).toBe(JSON.stringify({ mode: "custom", allow: ["mcp:codegraph"] }));

    expect(() =>
      ledger.hubCall(lin.sessionId, "graph.create", {
        specJson: JSON.stringify({ title: "坏图", steps: [{ key: "a", title: "a", brief: "b", caps: "custom" }] }),
      }),
    ).toThrowError(/外接能力配置不对/);
  });
});
