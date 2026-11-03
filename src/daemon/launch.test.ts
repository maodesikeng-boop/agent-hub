import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN, buildHubSettings, type AgentSessionRow, type LaunchContext } from "../shared/index.ts";
import { launchFingerprint } from "../shared/launch.ts";
import { createPmLaunchPreparer } from "./launch.ts";
import { buildLaunchPrompt } from "./prompt.ts";
import { noProjectContext, projectContext } from "./test-helpers.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-hub-prompt-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("prepareLaunch（M2）", () => {
  const hubSock = "/private/var/agent-hub/run/hub.sock";
  let contexts: Map<number, LaunchContext>;
  let issued: number[];
  let launchDir: string;
  const tokens = {
    issue: (sessionId: number) => {
      issued.push(sessionId);
      return `token-of-${sessionId}`;
    },
  };
  const make = (basePath = "/usr/bin:/bin") =>
    createPmLaunchPreparer({
      launchDir,
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
  const row = (id: number, cwd = dir): AgentSessionRow => ({
    id,
    role: "pm",
    conversationId: id,
    pmId: 1,
    workerId: null,
    vendor: "claude",
    vendorSessionId: `vendor-${id}`,
    cwd,
    addDirs: [],
    generation: 1,
    model: null,
    pid: null,
    status: "idle",
    hasCompletedTurn: false,
    lastEventAt: null,
    rateLimit: null,
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
  });

  it("写 prompt.md、settings.json（放行 hub、hub.sock）、空的 MCP 配置；env 带令牌、socket、PATH；fingerprint 按三份内容算", async () => {
    const files = await make()(row(7));
    const base = join(launchDir, "7");
    expect(files).toMatchObject({
      promptFile: join(base, "prompt.md"),
      settingsFile: join(base, "settings.json"),
      mcpConfigFile: join(base, "mcp.json"),
      env: { [ENV_HUB_TOKEN]: "token-of-7", [ENV_HUB_SOCK]: hubSock, PATH: "/agent-hub/run/bin:/usr/bin:/bin" },
    });
    const prompt = readFileSync(files.promptFile, "utf8");
    const settings = readFileSync(files.settingsFile!, "utf8");
    const mcpConfig = readFileSync(files.mcpConfigFile, "utf8");
    expect(prompt).toBe(buildLaunchPrompt(projectContext(), dir));
    expect(JSON.parse(settings)).toEqual(buildHubSettings(hubSock));
    expect(JSON.parse(mcpConfig)).toEqual({ mcpServers: {} });
    expect(files.fingerprint).toBe(launchFingerprint({ prompt, settings, mcpConfig }));
    // 令牌只在 env 里，不进任何文件
    for (const content of [prompt, settings, mcpConfig]) expect(content).not.toContain("token-of-7");
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

  it("性格设定、模式、文件夹变了：fingerprint 都跟着变", async () => {
    const prepare = make();
    const base = (await prepare(row(7))).fingerprint;
    const ctx = projectContext();
    const variants: LaunchContext[] = [
      { ...ctx, pm: { ...ctx.pm, persona: "以后回复都用列表。" } },
      { ...ctx, pm: { ...ctx.pm, mode: "hands_on" } },
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
});
