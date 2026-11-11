import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENT_VENDORS, type AgentSessionRow, type AgentVendor, type LaunchFiles, type SessionStore } from "../../shared/index.ts";
import { pmMemoryDirPath } from "../../shared/paths.ts";
import { buildAgyArgs } from "../../vendors/agy/protocol.ts";
import { buildClaudeArgs } from "../../vendors/claude/protocol.ts";
import { buildSessionSettings } from "../../vendors/claude/settings.ts";
import claudeDaemon from "../../vendors/claude/daemon.ts";
import { buildSandboxPolicy } from "../../vendors/codex/protocol.ts";
import { buildPiArgs } from "../../vendors/pi/protocol.ts";
import { DAEMON_VENDORS } from "../vendors/index.ts";
import { BaseSessionDriver, launchChanged } from "./base-driver.ts";
import { withPmMemoryAddDir } from "./pm-memory-dirs.ts";

function makeSessionRow(over: Partial<AgentSessionRow> = {}): AgentSessionRow {
  return {
    id: 1,
    vendor: "claude",
    vendorSessionId: "11111111-1111-4111-8111-111111111111",
    role: "pm",
    conversationId: 10,
    pmId: 7,
    workerId: null,
    cwd: "/tmp/project",
    addDirs: [],
    model: null,
    effort: null,
    personaRevision: null,
    status: "idle",
    hasCompletedTurn: false,
    pid: null,
    lastEventAt: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, context: 0 },
    rateLimit: null,
    generation: 1,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe("6 家厂商统一挂载 PM 专属 pm-memory addDirs 与 Worker 隔离", () => {
  let root: string;
  let pmMemoryDir: string;
  let cwd: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ah-driver-pm-mem-"));
    pmMemoryDir = join(root, "state", "pm-memory");
    cwd = join(root, "proj");
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("withPmMemoryAddDir：为 PM 会话自动创建并追加 realpath 后的 pm-memory/<pmId>（去重），Worker 与 assistant 绝不挂载", () => {
    const pmRow = makeSessionRow({ role: "pm", pmId: 7, cwd, addDirs: ["/extra/docs"] });
    const mounted = withPmMemoryAddDir(pmRow, pmMemoryDir);
    const expectedDir = realpathSync.native(pmMemoryDirPath(pmMemoryDir, 7));
    expect(existsSync(expectedDir)).toBe(true);
    expect(mounted.addDirs).toEqual(["/extra/docs", expectedDir]);

    // 重复调用不会重复追加，且与 launchChanged 保持稳定一致（不触发误重启）
    const mountedAgain = withPmMemoryAddDir(mounted, pmMemoryDir);
    expect(mountedAgain.addDirs).toEqual(["/extra/docs", expectedDir]);
    expect(
      launchChanged(
        { fingerprint: "fp1", cwd, addDirs: [...mounted.addDirs], model: null, effort: null },
        mountedAgain,
        "fp1",
      ),
    ).toBe(false);

    // 普通 Worker（无论 worktree 还是主文件夹）与 assistant 会话绝不追加 pm-memory
    const workerRow = makeSessionRow({ id: 2, role: "worker", pmId: null, workerId: 42, cwd, addDirs: [] });
    expect(withPmMemoryAddDir(workerRow, pmMemoryDir).addDirs).toEqual([]);
    const assistantRow = makeSessionRow({ id: 3, role: "assistant", pmId: null, cwd, addDirs: [] });
    expect(withPmMemoryAddDir(assistantRow, pmMemoryDir).addDirs).toEqual([]);
  });

  it("6 家厂商（claude / codex / agy / pi / cursor / deepseek）驱动底座统一注入 pm-memory/<pmId>", async () => {
    expect(AGENT_VENDORS).toHaveLength(6);
    const rows = new Map<number, AgentSessionRow>();
    const store: SessionStore = {
      get: (id) => rows.get(id) ?? null,
      update: (id, patch) => {
        const next = { ...rows.get(id)!, ...patch };
        rows.set(id, next);
        return next;
      },
      listWithProcess: () => [],
    };
    const seenByPrepare = new Map<AgentVendor, string[]>();
    const prepareLaunch = async (session: AgentSessionRow): Promise<LaunchFiles> => {
      seenByPrepare.set(session.vendor as AgentVendor, [...session.addDirs]);
      return { promptFile: join(root, "prompt.md"), env: {}, fingerprint: "fp" };
    };

    for (const [idx, vendor] of AGENT_VENDORS.entries()) {
      const sid = idx + 100;
      const pmId = idx + 1;
      rows.set(sid, makeSessionRow({ id: sid, vendor, pmId, cwd, addDirs: [] }));
      const driver = DAEMON_VENDORS[vendor].createDriver({
        composer: DAEMON_VENDORS[vendor].base,
        executablePath: join(root, `missing-${vendor}`),
        store,
        prepareLaunch,
        pmMemoryDir,
      });
      // 因可执行文件不存在会在 spawn 阶段抛 not_found，但 resolveLaunchFiles 已走完 BaseSessionDriver.store(st)
      await expect(driver.start(sid)).rejects.toThrow();
      const expectedDir = realpathSync.native(pmMemoryDirPath(pmMemoryDir, pmId));
      expect(seenByPrepare.get(vendor), vendor).toEqual([expectedDir]);
      await driver.shutdown();
    }

    // 同时核验各家协议构造均拿到该可读写附加目录
    const pmDir = realpathSync.native(pmMemoryDirPath(pmMemoryDir, 1));
    const session = makeSessionRow({ cwd, addDirs: [pmDir] });
    const dummyFiles: LaunchFiles = { promptFile: "/p.md", env: {}, fingerprint: "f" };
    expect(buildClaudeArgs(session, dummyFiles, false)).toContain(pmDir);
    expect(buildAgyArgs(session, dummyFiles, false)).toContain(pmDir);
    const codexSandbox = buildSandboxPolicy(session, false, null, false);
    expect(codexSandbox).toMatchObject({ type: "workspaceWrite", writableRoots: [cwd, pmDir] });
    const piSkillDir = join(pmDir, ".agents", "skills");
    mkdirSync(piSkillDir, { recursive: true });
    expect(buildPiArgs({ row: session, files: { promptFile: "/p.md" }, sessionId: "pm-1" })).toContain(piSkillDir);
    // BaseSessionDriver 子类通用断言
    expect(BaseSessionDriver).toBeDefined();
  });

  it("Claude 原生记忆保持原状：不写 autoMemoryEnabled，也不给 PM 注入 CLAUDE_CODE_DISABLE_AUTO_MEMORY", () => {
    const pmSettings = buildSessionSettings({ role: "pm", hubSock: "/tmp/hub.sock", stateDir: "/tmp/state", osSandboxed: true });
    expect("autoMemoryEnabled" in pmSettings).toBe(false);
    const pmLaunch = claudeDaemon.launchFiles?.({
      role: "pm",
      hubSock: "/tmp/hub.sock",
      stateDir: "/tmp/state",
      osSandboxed: true,
    });
    expect(pmLaunch?.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBeUndefined();
  });
});
