import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN, WORKER_BACKGROUND_HOLD_MAX_MS, WORKER_ENV, buildReadonlyPolicy, buildSessionSettings, stateDirDenyRule, type AgentSessionRow, type LaunchContext } from "../shared/index.ts";
import { launchFingerprint } from "../shared/launch.ts";
import { projectWorktreesDir } from "../shared/paths.ts";
import { createLaunchPreparer } from "./launch.ts";
import { buildFingerprintPrompt, buildLaunchPrompt, buildWorkerPrompt } from "./prompt.ts";
import { noProjectContext, projectContext, workerContext } from "./test-helpers.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-hub-prompt-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("prepareLaunch（M2、M3）", () => {
  const hubSock = "/private/var/agent-hub/run/hub.sock";
  let worktreesDir: string;
  let contexts: Map<number, LaunchContext>;
  let issued: number[];
  let launchDir: string;
  const tokens = {
    issue: (sessionId: number) => {
      issued.push(sessionId);
      return `token-of-${sessionId}`;
    },
  };
  const make = (basePath = "/usr/bin:/bin", osSandboxed = true) =>
    createLaunchPreparer({
      launchDir,
      // 数据目录：临时目录本身（Worker 的 worktree 建在它下面）
      dataDir: dir,
      stateDir: join(dir, "state"),
      osSandboxed,
      worktreesDir,
      getLaunchContext: (id) => {
        const ctx = contexts.get(id);
        if (!ctx) throw new Error(`no launch context for ${id}`);
        return ctx;
      },
      tokens,
      hubSock,
      hubBinDir: "/agent-hub/run/bin",
      basePath,
    });
  const row = (id: number, cwd = dir, role: "pm" | "worker" = "pm"): AgentSessionRow => ({
    id,
    role,
    conversationId: id,
    pmId: role === "pm" ? 1 : null,
    workerId: role === "worker" ? 5 : null,
    vendor: "claude",
    vendorSessionId: `vendor-${id}`,
    cwd,
    addDirs: [],
    generation: 1,
    model: null,
    effort: null,
    pid: null,
    status: "idle",
    hasCompletedTurn: false,
    lastEventAt: null,
    rateLimit: null,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: 0 },
    createdAt: 0,
    updatedAt: 0,
  });

  beforeEach(() => {
    contexts = new Map([
      [7, projectContext()],
      [8, noProjectContext()],
    ]);
    issued = [];
    launchDir = join(dir, "launch");
    worktreesDir = join(dir, "worktrees");
  });

  it("写 prompt.md、settings.json（放行 hub、hub.sock）；env 带令牌、socket、PATH；fingerprint 按两份内容算（性格设定、模式除外）", async () => {
    const files = await make()(row(7));
    const base = join(launchDir, "7");
    expect(files).toMatchObject({
      promptFile: join(base, "prompt.md"),
      settingsFile: join(base, "settings.json"),
      env: { [ENV_HUB_TOKEN]: "token-of-7", [ENV_HUB_SOCK]: hubSock, PATH: "/agent-hub/run/bin:/usr/bin:/bin" },
    });
    const prompt = readFileSync(files.promptFile, "utf8");
    const settings = readFileSync(files.settingsFile!, "utf8");
    expect(prompt).toBe(buildLaunchPrompt(projectContext(), dir));
    expect(JSON.parse(settings)).toEqual(buildSessionSettings({ role: "pm", readonly: false, hubSock, stateDir: join(dir, "state"), osSandboxed: true }));
    expect(files.fingerprint).toBe(launchFingerprint({ prompt: buildFingerprintPrompt(projectContext(), dir), settings }));
    expect(files.personaRevision).toBe(projectContext().pm.personaRevision);
    // 项目经理不受可写范围限制
    expect(files.writeScope).toBeUndefined();
    // 项目经理有后台任务时用驱动层的默认兜底
    expect(files.backgroundHoldMaxMs).toBeUndefined();
    // 令牌只在 env 里，不进任何文件
    for (const content of [prompt, settings]) expect(content).not.toContain("token-of-7");
  });

  it("同一个会话两次 prepareLaunch：令牌相同、fingerprint 相同", async () => {
    const prepare = make();
    const a = await prepare(row(7));
    const b = await prepare(row(7));
    expect(b.env[ENV_HUB_TOKEN]).toBe(a.env[ENV_HUB_TOKEN]);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(issued).toEqual([7, 7]);
  });

  it("建了项目：还没有项目的会话 fingerprint 变了（下一条消息前按新提示词重启）", async () => {
    const prepare = make();
    const before = await prepare(row(8));
    contexts.set(8, noProjectContext({ project: projectContext().project }));
    expect((await prepare(row(8))).fingerprint).not.toBe(before.fingerprint);
  });

  it("性格设定、模式变了：提示词里是新的、带上新的版本号，fingerprint 不变（不重启，下一条消息前加说明）", async () => {
    const prepare = make();
    const base = await prepare(row(7));
    const ctx = projectContext();
    const variants: LaunchContext[] = [
      { ...ctx, pm: { ...ctx.pm, persona: "以后回复都用列表。", personaRevision: 3 } },
      { ...ctx, pm: { ...ctx.pm, mode: ctx.pm.mode === "hands_on" ? "manage_only" : "hands_on", personaRevision: 4 } },
      { ...ctx, pm: { ...ctx.pm, persona: "", personaRevision: 5 } },
    ];
    for (const v of variants) {
      contexts.set(7, v);
      const files = await prepare(row(7));
      expect(files.fingerprint).toBe(base.fingerprint);
      expect(files.personaRevision).toBe(v.pm.personaRevision);
      expect(readFileSync(files.promptFile, "utf8")).toBe(buildLaunchPrompt(v, dir));
    }
  });

  it("Worker 的会话不带性格设定的版本号", async () => {
    contexts.set(9, workerContext());
    expect((await make()(row(9, dir, "worker"))).personaRevision).toBeUndefined();
  });

  it("文件夹变了：fingerprint 跟着变", async () => {
    const prepare = make();
    const base = (await prepare(row(7))).fingerprint;
    const ctx = projectContext();
    const variants: LaunchContext[] = [
      { ...ctx, project: { ...ctx.project!, otherFolders: ["/work/foo-docs", "/work/more"] } },
      { ...ctx, project: { ...ctx.project!, mainFolder: "/work/foo2" } },
    ];
    for (const v of variants) {
      contexts.set(7, v);
      expect((await prepare(row(7))).fingerprint).not.toBe(base);
    }
  });

  it("守护进程的 PATH 是空的：PATH 就是 hub 所在目录，没有多余的冒号", async () => {
    expect((await make("")(row(7))).env.PATH).toBe("/agent-hub/run/bin");
  });

  it("拿不到启动上下文（会话不存在）：抛错，驱动层按 spawn_failed 处理", async () => {
    await expect(make()(row(99))).rejects.toThrow(/no launch context/);
  });

  // ---- M3 ----

  it("项目经理：设置文件是 buildSessionSettings(pm)（auto 档，没有拒绝规则）；env 里没有关自动记忆", async () => {
    const files = await make()(row(7));
    const settings = JSON.parse(readFileSync(files.settingsFile!, "utf8"));
    expect(settings.permissions.defaultMode).toBe("auto");
    expect(settings.permissions.deny).toBeUndefined();
    for (const key of Object.keys(WORKER_ENV)) expect(files.env[key]).toBeUndefined();
  });

  it("有项目的项目经理：启动前建好 <数据目录>/worktrees/<项目编号>/（--add-dir 要求目录在）；重复调没事", async () => {
    const target = projectWorktreesDir(worktreesDir, projectContext().project!.id);
    expect(existsSync(target)).toBe(false);
    await make()(row(7));
    expect(existsSync(target)).toBe(true);
    await make()(row(7));
    expect(existsSync(target)).toBe(true);
  });

  it("还没有项目的项目经理：不建 worktrees 目录", async () => {
    await make()(row(8));
    expect(existsSync(worktreesDir)).toBe(false);
  });

  it("Worker：提示词是 buildWorkerPrompt（含规矩、没有先问用户清单）；设置文件是 buildSessionSettings(worker)；env 有自己的令牌和关自动记忆", async () => {
    const worktree = join(dir, "wt");
    contexts.set(9, workerContext({ worktreePath: worktree }));
    const files = await make()(row(9, worktree, "worker"));
    const prompt = readFileSync(files.promptFile, "utf8");
    expect(prompt).toBe(buildWorkerPrompt(workerContext({ worktreePath: worktree }), worktree));
    expect(prompt).not.toContain("先问用户的事");
    expect(JSON.parse(readFileSync(files.settingsFile!, "utf8"))).toEqual(buildSessionSettings({ role: "worker", readonly: false, hubSock, stateDir: join(dir, "state"), osSandboxed: true }));
    expect(files.env).toMatchObject({ ...WORKER_ENV, [ENV_HUB_TOKEN]: "token-of-9", [ENV_HUB_SOCK]: hubSock, PATH: "/agent-hub/run/bin:/usr/bin:/bin" });
    expect(files.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    // 可写范围：数据目录里只有自己的 worktree
    expect(files.writeScope).toEqual({ dataDir: dir, writableDirs: [worktree] });
    // 有后台命令时最多等多久（到点驱动层关进程、账本照常汇报）
    expect(files.backgroundHoldMaxMs).toBe(WORKER_BACKGROUND_HOLD_MAX_MS);
  });

  it("在主文件夹干活的 Worker：数据目录整个不能写，主文件夹在数据目录外不受影响", async () => {
    const main = "/Users/u/code/app";
    contexts.set(9, workerContext());
    expect((await make()(row(9, main, "worker"))).writeScope).toEqual({ dataDir: dir, writableDirs: [] });
  });

  it("同一个项目的项目经理和 Worker：Worker 多 autoMemoryEnabled、state/ 的兜底拒绝规则，包进 OS 沙箱时关掉 claude 自带的沙箱", async () => {
    contexts.set(9, workerContext());
    const pm = JSON.parse(readFileSync((await make()(row(7))).settingsFile!, "utf8"));
    const worker = JSON.parse(readFileSync((await make()(row(9, dir, "worker"))).settingsFile!, "utf8"));
    expect(worker.permissions).toEqual({ ...pm.permissions, deny: [stateDirDenyRule(join(dir, "state"))] });
    expect(worker.sandbox).toEqual({ ...pm.sandbox, enabled: false });
    expect(worker.autoMemoryEnabled).toBe(false);
    expect(pm.autoMemoryEnabled).toBeUndefined();
    expect(pm.sandbox.enabled).toBeUndefined();
  });

  it("没有 OS 沙箱的机器（不是 macOS）：不关 claude 自带的沙箱，state/ 的拒绝规则照样有", async () => {
    contexts.set(9, workerContext());
    const worker = JSON.parse(readFileSync((await make(undefined, false)(row(9, dir, "worker"))).settingsFile!, "utf8"));
    expect(worker.sandbox.enabled).toBeUndefined();
    expect(worker.permissions.deny).toEqual([stateDirDenyRule(join(dir, "state"))]);
  });

  it("只读 Worker：只读档；开关变了 fingerprint 跟着变", async () => {
    contexts.set(9, workerContext());
    const prepare = make();
    const normal = await prepare(row(9, dir, "worker"));
    contexts.set(9, workerContext({ readonly: true }));
    const readonly = await prepare(row(9, dir, "worker"));
    expect(JSON.parse(readFileSync(readonly.settingsFile!, "utf8"))).toEqual(buildSessionSettings({ role: "worker", readonly: true, hubSock, stateDir: join(dir, "state"), osSandboxed: true, projectWorktreesDir: projectWorktreesDir(worktreesDir, projectContext().project!.id) }));
    expect(readonly.fingerprint).not.toBe(normal.fingerprint);
  });

  it("只读 Worker：LaunchFiles.readonly 是统一策略（密钥清单按主目录和数据目录展开）；普通 Worker、项目经理没有", async () => {
    const make2 = () => createLaunchPreparer({ launchDir, dataDir: dir, stateDir: join(dir, "state"), homeDir: "/Users/u", osSandboxed: true, worktreesDir, getLaunchContext: (id) => contexts.get(id)!, tokens, hubSock, hubBinDir: "/agent-hub/run/bin" });
    contexts.set(9, workerContext({ readonly: true }));
    const readonly = await make2()(row(9, dir, "worker"));
    expect(readonly.readonly).toEqual(buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: join(dir, "state") }));
    expect(readonly.readonly!.secretPaths).toContain("/Users/u/.ssh");
    expect(readonly.readonly!.secretPaths).toContain(join(dir, "state", "ui-token"));
    contexts.set(9, workerContext());
    expect((await make2()(row(9, dir, "worker"))).readonly).toBeUndefined();
    contexts.set(1, projectContext());
    expect((await make2()(row(1))).readonly).toBeUndefined();
  });

  it("只读 Worker：策略变了 fingerprint 跟着变（驱动层下一条消息前重启）；同样的策略 fingerprint 不变", () => {
    const policy = buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: "/s" });
    const base = { prompt: "p", settings: "{}" };
    expect(launchFingerprint({ ...base, readonly: policy })).toBe(launchFingerprint({ ...base, readonly: buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: "/s" }) }));
    expect(launchFingerprint({ ...base, readonly: policy })).not.toBe(launchFingerprint(base));
    expect(launchFingerprint({ ...base, readonly: buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: "/s", connectors: { deny: ["jenkins/*"] } }) })).not.toBe(launchFingerprint({ ...base, readonly: policy }));
  });

  it("不是项目经理也不是 Worker 的会话：抛错", async () => {
    contexts.set(10, { ...projectContext(), role: "assistant" });
    await expect(make()(row(10))).rejects.toThrow(/assistant/);
  });
});
