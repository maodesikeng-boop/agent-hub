import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_VENDORS,
  ENV_HUB_SOCK,
  ENV_HUB_TOKEN,
  REVIEW_HOOKS_DIR,
  REVIEW_PRE_PUSH_HOOK,
  TASK_GRAPH_SKILL_NAME,
  WORKER_BACKGROUND_HOLD_MAX_MS,
  applyCapabilitiesPatch,
  buildReadonlyPolicy,
  defaultCapabilityPolicy,
  taskGraphSkillCatalogEntry,
  taskGraphSkillMarkdown,
  type AgentSessionRow,
  type CapabilityInventory,
  type LaunchContext,
  type CapabilityPolicy,
} from "../shared/index.ts";
import { WORKER_ENV, buildSessionSettings, stateDirDenyRule } from "../vendors/claude/settings.ts";
import { launchFingerprint } from "../shared/launch.ts";
import { readCodexLaunchConfig } from "../vendors/codex/protocol.ts";
import { projectWorktreesDir } from "../shared/paths.ts";
import { createLaunchPreparer } from "./launch.ts";
import { taskGraphSkillFile } from "./task-graph-skill.ts";
import { buildFingerprintPrompt, buildLaunchPrompt, buildWorkerPrompt } from "./prompt.ts";
import { noProjectContext, projectContext, workerContext } from "./test-helpers.ts";

let dir: string;
beforeEach(() => {
  // 和守护进程一样传真实路径（macOS 的 /var 是 /private/var）：沙箱规则按真实路径比
  dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-prompt-")));
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
    launchDir = join(dir, "state", "launch");
    worktreesDir = join(dir, "worktrees");
  });

  it("写 prompt.md、settings.json（放行 hub、hub.sock）；env 带令牌、socket、PATH；fingerprint 按两份内容算（性格设定、模式除外）", async () => {
    const files = await make()(row(7));
    const base = join(launchDir, "7");
    expect(files).toMatchObject({
      promptFile: join(base, "prompt.md"),
      settingsFile: join(base, "settings.json"),
      env: { [ENV_HUB_TOKEN]: "token-of-7", [ENV_HUB_SOCK]: hubSock, PATH: `/agent-hub/run/bin${delimiter}/usr/bin:/bin` },
    });
    const prompt = readFileSync(files.promptFile, "utf8");
    const settings = readFileSync(files.settingsFile!, "utf8");
    const promptOptions = { taskGraphSkillFile: taskGraphSkillFile(base) };
    expect(prompt).toBe(buildLaunchPrompt(projectContext(), dir, promptOptions));
    expect(JSON.parse(settings)).toEqual(buildSessionSettings({ role: "pm", hubSock, stateDir: join(dir, "state"), osSandboxed: true }));
    expect(files.fingerprint).toBe(
      launchFingerprint({ prompt: buildFingerprintPrompt(projectContext(), dir, promptOptions), settings, skills: taskGraphSkillCatalogEntry() }),
    );
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
      expect(readFileSync(files.promptFile, "utf8")).toBe(buildLaunchPrompt(v, dir, { taskGraphSkillFile: taskGraphSkillFile(join(launchDir, "7")) }));
    }
  });

  it("项目经理：启动目录里写唯一一份任务图技能 skills/fusa-task-graph/SKILL.md（0600），LaunchFiles.skillsDir 指向它的根；提示词里写它的绝对路径", async () => {
    const files = await make()(row(7));
    const base = join(launchDir, "7");
    expect(files.skillsDir).toBe(join(base, "skills"));
    const file = taskGraphSkillFile(base);
    expect(file).toBe(join(base, "skills", TASK_GRAPH_SKILL_NAME, "SKILL.md"));
    expect(readFileSync(file, "utf8")).toBe(taskGraphSkillMarkdown());
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(base, "skills", TASK_GRAPH_SKILL_NAME)).mode & 0o777).toBe(0o700);
    }
    expect(readdirSync(join(base, "skills"))).toEqual([TASK_GRAPH_SKILL_NAME]);
    expect(readFileSync(files.promptFile, "utf8")).toContain(file);
  });

  it("任务图技能内容没变就不重写（inode、mtime 不变：agy 的硬链接和各家缓存都还有效）；被改坏了下次启动写回", async () => {
    const prepare = make();
    const first = await prepare(row(7));
    const file = taskGraphSkillFile(join(launchDir, "7"));
    const before = statSync(file);
    const second = await prepare(row(7));
    const after = statSync(file);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(second.fingerprint).toBe(first.fingerprint);
    writeFileSync(file, "被改坏了");
    const third = await prepare(row(7));
    expect(readFileSync(file, "utf8")).toBe(taskGraphSkillMarkdown());
    // 正文不进 fingerprint（加载时才读文件，改了不用重启）
    expect(third.fingerprint).toBe(first.fingerprint);
  });

  it("任务图技能的名字和说明进 fingerprint（各家在会话开头读进技能清单）；正文不进", () => {
    const base = { prompt: "p", settings: "s" };
    expect(launchFingerprint({ ...base, skills: "a\nb" })).not.toBe(launchFingerprint(base));
    expect(launchFingerprint({ ...base, skills: "a\nb" })).not.toBe(launchFingerprint({ ...base, skills: "a\nc" }));
    expect(launchFingerprint({ ...base, skills: taskGraphSkillCatalogEntry() })).toBe(launchFingerprint({ ...base, skills: taskGraphSkillCatalogEntry() }));
    expect(taskGraphSkillCatalogEntry()).not.toContain("## 建图");
  });

  it("Worker：不写、不挂任务图技能（没有 skillsDir，提示词里没有路径）；启动目录里残留的也删掉", async () => {
    contexts.set(9, workerContext());
    const stale = join(launchDir, "9", "skills", TASK_GRAPH_SKILL_NAME);
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "SKILL.md"), "旧的");
    const files = await make()(row(9, dir, "worker"));
    expect(files.skillsDir).toBeUndefined();
    expect(existsSync(join(launchDir, "9", "skills"))).toBe(false);
    const prompt = readFileSync(files.promptFile, "utf8");
    expect(prompt).not.toContain("SKILL.md");
    expect(prompt).not.toContain(TASK_GRAPH_SKILL_NAME);
    expect(files.fingerprint).toBe(launchFingerprint({ prompt: buildFingerprintPrompt(workerContext(), dir), settings: readFileSync(files.settingsFile!, "utf8") }));
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
    expect(JSON.parse(readFileSync(files.settingsFile!, "utf8"))).toEqual(buildSessionSettings({ role: "worker", hubSock, stateDir: join(dir, "state"), osSandboxed: true }));
    expect(files.env).toMatchObject({ ...WORKER_ENV, [ENV_HUB_TOKEN]: "token-of-9", [ENV_HUB_SOCK]: hubSock, PATH: `/agent-hub/run/bin${delimiter}/usr/bin:/bin` });
    expect(files.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    // 可写范围：数据目录里只有自己的 worktree
    expect(files.writeScope).toMatchObject({ dataDir: dir, protectedRoots: [dir], writableDirs: [worktree] });
    // 有后台命令时最多等多久（到点驱动层关进程、账本照常汇报）
    expect(files.backgroundHoldMaxMs).toBe(WORKER_BACKGROUND_HOLD_MAX_MS);
  });

  it("在主文件夹干活的 Worker：数据目录整个不能写，主文件夹在数据目录外不受影响", async () => {
    const main = "/Users/u/code/app";
    contexts.set(9, workerContext());
    expect((await make()(row(9, main, "worker"))).writeScope).toMatchObject({
      dataDir: dir,
      protectedRoots: [dir],
      writableDirs: [],
    });
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

  it("没有 OS 沙箱的机器（不是 macOS）：不关 claude 自带的沙箱，state/ 的拒绝规则照样有；跑完配置脚本沙箱就绪后无需重建 preparer 立即生效", async () => {
    contexts.set(9, workerContext());
    let sandboxReady = false;
    const prepare = createLaunchPreparer({
      launchDir,
      dataDir: dir,
      stateDir: join(dir, "state"),
      osSandboxed: () => sandboxReady,
      worktreesDir,
      getLaunchContext: (id) => contexts.get(id)!,
      tokens,
      hubSock,
      hubBinDir: "/agent-hub/run/bin",
    });
    const before = JSON.parse(readFileSync((await prepare(row(9, dir, "worker"))).settingsFile!, "utf8"));
    expect(before.sandbox.enabled).toBeUndefined();
    expect(before.permissions.deny).toEqual([stateDirDenyRule(join(dir, "state"))]);

    sandboxReady = true;
    const after = JSON.parse(readFileSync((await prepare(row(9, dir, "worker"))).settingsFile!, "utf8"));
    expect(after.sandbox.enabled).toBe(false);
  });

  it("claude 只读 Worker：设置文件是只读翻译（沙箱 denyWrite 盖住工作目录和 add-dir 的真实路径）；进程不包外层沙箱（没有 writeScope）；开关变了 fingerprint 跟着变", async () => {
    const make2 = () => createLaunchPreparer({ launchDir, dataDir: dir, stateDir: join(dir, "state"), homeDir: "/Users/u", osSandboxed: true, worktreesDir, getLaunchContext: (id) => contexts.get(id)!, tokens, hubSock, hubBinDir: "/agent-hub/run/bin" });
    contexts.set(9, workerContext());
    const prepare = make2();
    const wt = join(dir, "wt");
    const extra = join(dir, "extra");
    mkdirSync(wt, { recursive: true });
    mkdirSync(extra, { recursive: true });
    const worker = { ...row(9, wt, "worker"), addDirs: [extra, join(dir, "not-created-yet")] };
    const normal = await prepare(worker);
    contexts.set(9, workerContext({ readonly: true }));
    const readonly = await prepare(worker);
    const policy = readonly.readonly!;
    expect(policy).toMatchObject(buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: join(dir, "state") }));
    const settings = JSON.parse(readFileSync(readonly.settingsFile!, "utf8"));
    expect(settings).toEqual(
      buildSessionSettings({ role: "worker", readonly: { policy, denyWrite: [realpathSync(wt), realpathSync(extra), join(dir, "not-created-yet")] }, hubSock, stateDir: join(dir, "state"), osSandboxed: true }),
    );
    expect(settings.permissions.defaultMode).toBe("default");
    if (process.platform === "win32") {
      expect(settings.sandbox).toMatchObject({ enabled: false });
    } else {
      expect(settings.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, enableWeakerNetworkIsolation: true });
      // 数据目录里启动时还没有的已知敏感项（备份、遗留的 run/tunnel）也进了 claude 的禁读：运行期才建的照样读不到
      for (const known of [join(dir, "backups"), join(dir, "run", "tunnel")]) {
        expect(existsSync(known)).toBe(false);
        expect(settings.sandbox.filesystem.denyRead).toContain(known);
        expect(settings.permissions.deny.filter((rule: string) => rule.startsWith("Read(") && rule.includes(known))).not.toEqual([]);
      }
    }
    expect(readonly.writeScope).toBeUndefined();
    expect(normal.writeScope).toMatchObject({ dataDir: dir, protectedRoots: [dir], writableDirs: [wt] });
    expect(readonly.fingerprint).not.toBe(normal.fingerprint);
  });

  it("agy 的只读 Worker：不写 launchFiles 的厂商不生成设置文件；可写范围照旧（外层沙箱是 agy 自己那条线）；LaunchFiles.readonly 照给", async () => {
    contexts.set(9, workerContext({ readonly: true }));
    const files = await make()({ ...row(9, dir, "worker"), vendor: "agy" });
    expect(files.settingsFile).toBeUndefined();
    expect(existsSync(join(launchDir, "9", "settings.json"))).toBe(false);
    expect(files.writeScope).toMatchObject({ dataDir: dir, protectedRoots: [dir], writableDirs: [] });
    expect(files.readonly).toBeDefined();
  });

  it("不写 launchFiles 的厂商（agy、codex）：不生成 claude 的设置文件、Worker 也不多设 claude 的环境变量；令牌、socket、PATH 照给（A15）", async () => {
    contexts.set(9, workerContext());
    for (const vendor of ["agy", "codex"] as const) {
      const files = await make()({ ...row(9, dir, "worker"), vendor });
      expect(files.settingsFile, vendor).toBeUndefined();
      for (const key of Object.keys(WORKER_ENV)) expect(files.env[key], `${vendor}:${key}`).toBeUndefined();
      expect(files.env).toMatchObject({ [ENV_HUB_TOKEN]: "token-of-9", [ENV_HUB_SOCK]: hubSock, PATH: `/agent-hub/run/bin${delimiter}/usr/bin:/bin` });
    }
  });

  it("只读 Worker：LaunchFiles.readonly 是统一策略（密钥清单按主目录展开，数据目录按读边界禁读）；普通 Worker、项目经理没有", async () => {
    const make2 = () => createLaunchPreparer({ launchDir, dataDir: dir, stateDir: join(dir, "state"), homeDir: "/Users/u", osSandboxed: true, worktreesDir, getLaunchContext: (id) => contexts.get(id)!, tokens, hubSock, hubBinDir: "/agent-hub/run/bin" });
    contexts.set(9, workerContext({ readonly: true }));
    const readonly = await make2()(row(9, dir, "worker"));
    expect(readonly.readonly).toMatchObject(buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: join(dir, "state") }));
    expect(readonly.readonly!.secretPaths).toContain("/Users/u/.ssh");
    expect(readonly.readonly!.dataDirScope?.dataDir).toBe(dir);
    contexts.set(9, workerContext());
    expect((await make2()(row(9, dir, "worker"))).readonly).toBeUndefined();
    contexts.set(1, projectContext());
    expect((await make2()(row(1))).readonly).toBeUndefined();
  });

  it("数据目录读边界：普通 Worker 的 writeScope.readScope、只读 Worker 的 readonly.dataDirScope 都放行这次会话自己的启动目录；工具层禁读清单列出数据目录里别的顶层项、run/admin.sock 和遗留的 run/tunnel", async () => {
    const make2 = () => createLaunchPreparer({ launchDir, dataDir: dir, stateDir: join(dir, "state"), homeDir: "/Users/u", osSandboxed: true, worktreesDir, getLaunchContext: (id) => contexts.get(id)!, tokens, hubSock, hubBinDir: "/agent-hub/run/bin" });
    for (const name of ["state", "backups", "pm-home", "pm-notes", "sent-files", "uploads", "tools"]) mkdirSync(join(dir, name), { recursive: true });
    mkdirSync(join(dir, "run", "bin"), { recursive: true });
    writeFileSync(join(dir, "run", "admin.sock"), "");
    writeFileSync(join(dir, "run", "hub.sock"), "");
    const wt = join(worktreesDir, "1", "9");
    mkdirSync(wt, { recursive: true });
    const ownLaunch = join(launchDir, "9");
    contexts.set(9, workerContext());
    const normal = await make2()({ ...row(9, wt, "worker"), vendor: "agy" });
    expect(normal.writeScope?.readScope).toEqual({
      dataDir: dir,
      readable: [join(dir, "worktrees"), join(dir, "uploads"), join(dir, "tools"), join(dir, "run", "bin"), ownLaunch],
      connectable: [join(dir, "run", "hub.sock")],
    });
    contexts.set(9, workerContext({ readonly: true }));
    const readonly = await make2()({ ...row(9, wt, "worker"), vendor: "agy" });
    expect(readonly.readonly?.dataDirScope?.readable).toContain(ownLaunch);
    expect([...(readonly.readonly?.dataDirDenied ?? [])].sort()).toEqual(
      [join(dir, "backups"), join(dir, "pm-home"), join(dir, "pm-notes"), join(dir, "sent-files"), join(dir, "state"), join(dir, "run", "admin.sock"), join(dir, "run", "tunnel")].sort(),
    );
    expect(readonly.readonly?.secretPaths.some((p) => p.startsWith(`${dir}/`))).toBe(false);
  });

  it("只读 Worker：策略变了 fingerprint 跟着变（驱动层下一条消息前重启）；同样的策略 fingerprint 不变", () => {
    const policy = buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: "/s" });
    const base = { prompt: "p", settings: "{}" };
    expect(launchFingerprint({ ...base, readonly: policy })).toBe(launchFingerprint({ ...base, readonly: buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: "/s" }) }));
    expect(launchFingerprint({ ...base, readonly: policy })).not.toBe(launchFingerprint(base));
    expect(launchFingerprint({ ...base, readonly: buildReadonlyPolicy({ homeDir: "/Users/u", stateDir: "/s", connectors: { deny: ["jenkins/*"] } }) })).not.toBe(launchFingerprint({ ...base, readonly: policy }));
  });

  it("审查 Worker（6 家都一样）：启动目录里写拒绝推送的 pre-push，env 用 GIT_CONFIG_* 把 core.hooksPath 指过去；codex 原样透传给它起的 shell；普通 Worker 没有", async () => {
    const hooksDir = join(launchDir, "9", REVIEW_HOOKS_DIR);
    contexts.set(9, workerContext({ branch: null, review: { branch: "hub/1-impl", snapshot: null } }));
    for (const vendor of AGENT_VENDORS) {
      const files = await make()({ ...row(9, dir, "worker"), vendor });
      expect(files.env, vendor).toMatchObject({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: hooksDir });
      if (vendor === "codex") {
        expect(readCodexLaunchConfig(files).config["shell_environment_policy.set"]).toMatchObject({ GIT_CONFIG_VALUE_0: hooksDir });
      }
    }
    expect(readFileSync(join(hooksDir, "pre-push"), "utf8")).toBe(REVIEW_PRE_PUSH_HOOK);
    if (process.platform !== "win32") expect(statSync(join(hooksDir, "pre-push")).mode & 0o777).toBe(0o755);
    contexts.set(9, workerContext());
    expect((await make()(row(9, dir, "worker"))).env.GIT_CONFIG_COUNT).toBeUndefined();
  });

  it("不是项目经理也不是 Worker 的会话：抛错", async () => {
    contexts.set(10, { ...projectContext(), role: "assistant" });
    await expect(make()(row(10))).rejects.toThrow(/assistant/);
  });

  describe("按项目经理收窄 Skill、MCP 与 Connector（LaunchFiles.capabilities）", () => {
    const policies = (pm: () => CapabilityPolicy, router: () => CapabilityPolicy = () => defaultCapabilityPolicy("router")) => ({
      getPmCapabilityPolicy: pm,
      getRouterCapabilityPolicy: router,
    });
    const sampleInventory: CapabilityInventory = {
      scannedAt: 1_000,
      items: [
        {
          key: "skill:aws-auth",
          kind: "skill",
          name: "aws-auth",
          description: "AWS auth",
          groupId: "skill:global",
          vendors: ["claude", "codex", "pi", "deepseek"],
          dir: "/skills/aws-auth",
        },
        {
          key: "mcp:codegraph",
          kind: "mcp",
          name: "codegraph",
          description: null,
          groupId: "mcp:global",
          vendors: ["claude", "codex", "agy", "pi", "deepseek"],
        },
        {
          key: "connector:claude:claude.ai Gmail",
          kind: "connector",
          name: "Gmail",
          description: null,
          groupId: "connector:account:claude",
          vendors: ["claude"],
        },
      ],
      groups: [],
      truncated: false,
    };

    it("全开（defaultCapabilityPolicy）时 capabilities 为 undefined，设置文件和 fingerprint 与未接入时逐字一致", async () => {
      const baseline = await make()(row(7));
      const withAllOpen = createLaunchPreparer({
        launchDir,
        dataDir: dir,
        stateDir: join(dir, "state"),
        osSandboxed: true,
        worktreesDir,
        getLaunchContext: (id) => contexts.get(id)!,
        tokens,
        hubSock,
        hubBinDir: "/agent-hub/run/bin",
        basePath: "/usr/bin:/bin",
        capabilityPolicies: policies(() => defaultCapabilityPolicy("pm")),
        capabilityInventory: { get: async () => sampleInventory },
      });
      const files = await withAllOpen(row(7));
      expect(files.capabilities).toBeUndefined();
      expect(readFileSync(files.settingsFile!, "utf8")).toBe(readFileSync(baseline.settingsFile!, "utf8"));
      expect(files.fingerprint).toBe(baseline.fingerprint);
    });

    it("PM 与名下普通、只读、审查 Worker 均继承该 PM 选择并计入 fingerprint；总助不跟项目走，默认一个不带", async () => {
      let currentPolicy: CapabilityPolicy = applyCapabilitiesPatch(defaultCapabilityPolicy("pm"), {
        set: {
          "skill:aws-auth": false,
          "mcp:codegraph": false,
          "connector:claude:claude.ai Gmail": false,
        },
      });
      const seenProjectDirs: Array<string | null> = [];
      const prepare = createLaunchPreparer({
        launchDir,
        dataDir: dir,
        stateDir: join(dir, "state"),
        homeDir: "/Users/u",
        osSandboxed: true,
        worktreesDir,
        getLaunchContext: (id) => contexts.get(id)!,
        tokens,
        hubSock,
        hubBinDir: "/agent-hub/run/bin",
        basePath: "/usr/bin:/bin",
        capabilityPolicies: policies(() => currentPolicy),
        capabilityInventory: {
          get: async ({ projectDir }) => {
            seenProjectDirs.push(projectDir);
            return sampleInventory;
          },
        },
      });

      const pmFiles = await prepare(row(7));
      expect(pmFiles.capabilities?.deny).toEqual({
        skills: ["aws-auth"],
        mcp: ["codegraph"],
        connectors: ["claude.ai Gmail"],
        plugins: [],
        pluginOf: { skills: {}, mcp: {} },
      });
      const pmSettings = JSON.parse(readFileSync(pmFiles.settingsFile!, "utf8"));
      expect(pmSettings.skillOverrides).toEqual({ "aws-auth": "off" });
      expect(pmSettings.deniedMcpServers).toEqual([
        { serverName: "claude.ai Gmail" },
        { serverName: "codegraph" },
      ]);

      contexts.set(9, workerContext());
      const workerRestricted = await prepare({ ...row(9, dir, "worker"), vendor: "codex" });
      expect(workerRestricted.capabilities?.deny.mcp).toEqual(["codegraph"]);
      expect(workerRestricted.capabilities?.deny.skills).toEqual(["aws-auth"]);

      contexts.set(11, workerContext({ readonly: true }));
      const roWorker = await prepare({ ...row(11, dir, "worker"), vendor: "agy" });
      expect(roWorker.readonly).toBeDefined();
      expect(roWorker.capabilities?.deny.mcp).toEqual(["codegraph"]);

      contexts.set(12, workerContext({ branch: null, review: { branch: "hub/1-impl", snapshot: null } }));
      const reviewWorker = await prepare({ ...row(12, dir, "worker"), vendor: "pi" });
      expect(reviewWorker.env.GIT_CONFIG_COUNT).toBe("1");
      expect(reviewWorker.capabilities?.deny.mcp).toEqual(["codegraph"]);

      const routerHome = join(dir, "state", "router-home");
      mkdirSync(routerHome, { recursive: true });
      const assistantRow: AgentSessionRow = {
        ...row(20, routerHome, "pm"),
        role: "assistant",
        conversationId: null,
        pmId: null,
        workerId: null,
        vendor: "claude",
      };
      const assistantFiles = await prepare(assistantRow);
      expect(assistantFiles.capabilities?.deny).toEqual({
        skills: ["aws-auth"],
        mcp: ["codegraph"],
        connectors: ["claude.ai Gmail"],
        plugins: [],
        pluginOf: { skills: {}, mcp: {} },
      });
      expect(assistantFiles.capabilities?.allow).toEqual({ skills: [], mcp: [] });
      const assistantSettings = JSON.parse(readFileSync(assistantFiles.settingsFile!, "utf8"));
      expect(assistantSettings.skillOverrides).toEqual({ "aws-auth": "off" });
      expect(assistantSettings.deniedMcpServers).toEqual([{ serverName: "claude.ai Gmail" }, { serverName: "codegraph" }]);

      currentPolicy = defaultCapabilityPolicy("pm");
      const workerAllOpen = await prepare({ ...row(9, dir, "worker"), vendor: "codex" });
      expect(workerAllOpen.capabilities).toBeUndefined();
      expect(workerAllOpen.fingerprint).not.toBe(workerRestricted.fingerprint);
      expect(new Set(seenProjectDirs)).toEqual(new Set([projectContext().project!.mainFolder, null]));
    });

    const preparerWith = (pm: () => CapabilityPolicy, router?: () => CapabilityPolicy, seen?: Array<string | null>) =>
      createLaunchPreparer({
        launchDir,
        dataDir: dir,
        stateDir: join(dir, "state"),
        homeDir: "/Users/u",
        osSandboxed: true,
        worktreesDir,
        getLaunchContext: (id) => contexts.get(id)!,
        tokens,
        hubSock,
        hubBinDir: "/agent-hub/run/bin",
        basePath: "/usr/bin:/bin",
        capabilityPolicies: policies(pm, router),
        capabilityInventory: {
          get: async ({ projectDir }) => {
            seen?.push(projectDir);
            return sampleInventory;
          },
        },
      });
    const routerRow = (): AgentSessionRow => {
      const routerHome = join(dir, "state", "router-home");
      mkdirSync(routerHome, { recursive: true });
      return { ...row(20, routerHome, "pm"), role: "assistant", conversationId: null, pmId: null, workerId: null, vendor: "codex" };
    };

    it("总助只挂用户在能力设置里打开的那几项，只看全局清单，改了设置 fingerprint 跟着变", async () => {
      let routerPolicy = defaultCapabilityPolicy("router");
      const seen: Array<string | null> = [];
      const prepare = preparerWith(() => defaultCapabilityPolicy("pm"), () => routerPolicy, seen);
      const zero = await prepare(routerRow());
      expect(zero.capabilities?.allow).toEqual({ skills: [], mcp: [] });
      expect(zero.capabilities?.deny.mcp).toEqual(["codegraph"]);
      routerPolicy = applyCapabilitiesPatch(routerPolicy, { set: { "mcp:codegraph": true } });
      const opened = await prepare(routerRow());
      expect(opened.capabilities?.allow.mcp).toEqual(["codegraph"]);
      expect(opened.capabilities?.deny).toMatchObject({ skills: ["aws-auth"], mcp: [] });
      expect(opened.fingerprint).not.toBe(zero.fingerprint);
      expect(seen).toEqual([null, null]);
    });

    it("Worker 三档：inherit 跟项目，none 一个不带，custom 只挂点名且项目里开着的", async () => {
      const project = applyCapabilitiesPatch(defaultCapabilityPolicy("pm"), { set: { "skill:aws-auth": false } });
      const prepare = preparerWith(() => project);
      contexts.set(9, workerContext());
      const inherit = await prepare({ ...row(9, dir, "worker"), vendor: "codex" });
      expect(inherit.capabilities?.allow.mcp).toEqual(["codegraph"]);
      contexts.set(9, { ...workerContext(), workerCapabilities: { mode: "none" } });
      const none = await prepare({ ...row(9, dir, "worker"), vendor: "codex" });
      expect(none.capabilities?.allow).toEqual({ skills: [], mcp: [] });
      expect(none.capabilities?.deny.mcp).toEqual(["codegraph"]);
      expect(none.fingerprint).not.toBe(inherit.fingerprint);
      contexts.set(9, { ...workerContext(), workerCapabilities: { mode: "custom", allow: ["mcp:codegraph", "skill:aws-auth"] } });
      const custom = await prepare({ ...row(9, dir, "worker"), vendor: "codex" });
      expect(custom.capabilities?.allow).toEqual({ skills: [], mcp: ["codegraph"] });
      expect(custom.capabilities?.deny.skills).toEqual(["aws-auth"]);
    });

    it("只读 Worker 点名挂了 MCP 也照样受只读策略和沙箱约束，不放宽", async () => {
      const prepare = preparerWith(() => defaultCapabilityPolicy("pm"));
      contexts.set(11, workerContext({ readonly: true }));
      const plain = await prepare({ ...row(11, dir, "worker"), vendor: "codex" });
      contexts.set(11, { ...workerContext({ readonly: true }), workerCapabilities: { mode: "custom", allow: ["mcp:codegraph"] } });
      const custom = await prepare({ ...row(11, dir, "worker"), vendor: "codex" });
      expect(custom.capabilities?.allow.mcp).toEqual(["codegraph"]);
      expect(custom.readonly).toEqual(plain.readonly);
      expect(custom.readonly).toBeDefined();
      expect(custom.writeScope).toEqual(plain.writeScope);
    });

    it("fingerprint 只算各家翻出来的结果：多了一个开着的全局技能，claude、codex 不重启，靠允许清单的 pi 重启", async () => {
      const policy = applyCapabilitiesPatch(defaultCapabilityPolicy("pm"), {
        set: { "skill:aws-auth": false, "mcp:codegraph": false },
      });
      let inventory = sampleInventory;
      const prepare = createLaunchPreparer({
        launchDir,
        dataDir: dir,
        stateDir: join(dir, "state"),
        homeDir: "/Users/u",
        osSandboxed: true,
        worktreesDir,
        getLaunchContext: (id) => contexts.get(id)!,
        tokens,
        hubSock,
        hubBinDir: "/agent-hub/run/bin",
        basePath: "/usr/bin:/bin",
        capabilityPolicies: policies(() => policy),
        capabilityInventory: { get: async () => inventory },
      });
      contexts.set(9, workerContext());
      const before = {
        claude: (await prepare(row(7))).fingerprint,
        codex: (await prepare({ ...row(9, dir, "worker"), vendor: "codex" })).fingerprint,
        pi: (await prepare({ ...row(9, dir, "worker"), vendor: "pi" })).fingerprint,
      };
      inventory = {
        ...sampleInventory,
        items: [
          ...sampleInventory.items,
          {
            key: "skill:new-global",
            kind: "skill",
            name: "new-global",
            description: null,
            groupId: "skill:global",
            vendors: ["claude", "codex", "pi"],
            dir: "/skills/new-global",
          },
        ],
      };
      const after = {
        claude: (await prepare(row(7))).fingerprint,
        codex: (await prepare({ ...row(9, dir, "worker"), vendor: "codex" })).fingerprint,
        pi: (await prepare({ ...row(9, dir, "worker"), vendor: "pi" })).fingerprint,
      };
      expect(after.claude).toBe(before.claude);
      expect(after.codex).toBe(before.codex);
      expect(after.pi).not.toBe(before.pi);
    });
  });
});
