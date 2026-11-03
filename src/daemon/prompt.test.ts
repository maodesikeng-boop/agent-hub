import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ENV_HUB_SOCK,
  ENV_HUB_TOKEN,
  PM_PERSONA_TEMPLATE,
  buildHubSettings,
  type AgentSessionRow,
  type LaunchContext,
  type ProjectCard,
} from "../shared/index.ts";
import { launchFingerprint } from "../shared/launch.ts";
import { createLedger } from "./ledger/index.ts";
import {
  AGENTS_NOTE,
  DEFAULT_PM_PERSONA,
  HUB_USAGE_PROMPT,
  PM_MODE_PROMPTS,
  PM_ROLE_PROMPT,
  buildLaunchPrompt,
  buildPmPrompt,
  createLaunchPreparer,
  createPmLaunchPreparer,
  needsAgentsNote,
  writeDefaultPersona,
} from "./prompt.ts";
import { getAgentSession, openStore, type Db } from "./store/index.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-hub-prompt-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("提示词", () => {
  it("角色说明在前、性格设定在后；没有 hub 用法", () => {
    const prompt = buildPmPrompt({ persona: "我是一个认真的人。\n", cwd: dir });
    expect(prompt).toBe(`${PM_ROLE_PROMPT}\n\n我是一个认真的人。\n`);
    expect(prompt).not.toMatch(/\bhub\b/);
    expect(buildPmPrompt({ persona: DEFAULT_PM_PERSONA, cwd: dir })).not.toMatch(/\bhub\b/);
  });

  it("“先读 AGENTS.md”只在 AGENTS.md、CLAUDE.md 都有，而且 CLAUDE.md 没写 @AGENTS.md 时加", () => {
    expect(needsAgentsNote(dir)).toBe(false); // 空目录
    writeFileSync(join(dir, "AGENTS.md"), "# 规矩");
    expect(needsAgentsNote(dir)).toBe(false); // 只有 AGENTS.md：Claude 自己会读
    writeFileSync(join(dir, "CLAUDE.md"), "# 说明");
    expect(needsAgentsNote(dir)).toBe(true);
    expect(buildPmPrompt({ persona: "p", cwd: dir }).trimEnd().endsWith(AGENTS_NOTE)).toBe(true);
    writeFileSync(join(dir, "CLAUDE.md"), "@AGENTS.md\n");
    expect(needsAgentsNote(dir)).toBe(false);
    rmSync(join(dir, "AGENTS.md"));
    writeFileSync(join(dir, "CLAUDE.md"), "# 只有 CLAUDE.md");
    expect(needsAgentsNote(dir)).toBe(false);
  });

  it("默认性格设定只在文件不存在时写，用户改过的不覆盖", () => {
    const personas = join(dir, "personas");
    const file = writeDefaultPersona(personas, 1);
    expect(readFileSync(file, "utf8")).toBe(DEFAULT_PM_PERSONA);
    writeFileSync(file, "改过的");
    writeDefaultPersona(personas, 1);
    expect(readFileSync(file, "utf8")).toBe("改过的");
  });
});

describe("prepareLaunch", () => {
  let db: Db;
  let session: AgentSessionRow;
  let personas: string;
  beforeEach(() => {
    db = openStore({ stateDir: join(dir, "state"), dbFile: join(dir, "state", "hub.sqlite") }).db;
    const { pm, sessionId } = createLedger(db, { pmHomeRoot: join(dir, "pm-home") }).createPm({ name: "项目经理", mode: "manage_only", persona: "" });
    session = getAgentSession(db, sessionId)!;
    personas = join(dir, "state", "personas");
    writeDefaultPersona(personas, pm.id);
  });
  afterEach(() => db.close());

  it("写 launch/<会话>/prompt.md 和空的 MCP 配置，不给 --settings 文件", async () => {
    const prepare = createLaunchPreparer({ db, launchDir: join(dir, "state", "launch"), personasDir: personas });
    const files = await prepare(session);
    expect(files).toEqual({
      promptFile: join(dir, "state", "launch", String(session.id), "prompt.md"),
      mcpConfigFile: join(dir, "state", "launch", String(session.id), "mcp.json"),
      env: {},
      fingerprint: "",
    });
    expect(readFileSync(files.promptFile, "utf8")).toBe(buildPmPrompt({ persona: DEFAULT_PM_PERSONA, cwd: session.cwd }));
    expect(JSON.parse(readFileSync(files.mcpConfigFile, "utf8"))).toEqual({ mcpServers: {} });
  });

  it("每次启动重新生成：性格设定改了、工作目录里加了 CLAUDE.md，下次启动就带上", async () => {
    const prepare = createLaunchPreparer({ db, launchDir: join(dir, "state", "launch"), personasDir: personas });
    writeFileSync(join(personas, "pm-1.md"), "新的性格设定");
    mkdirSync(session.cwd, { recursive: true });
    writeFileSync(join(session.cwd, "AGENTS.md"), "x");
    writeFileSync(join(session.cwd, "CLAUDE.md"), "y");
    const prompt = readFileSync((await prepare(session)).promptFile, "utf8");
    expect(prompt).toContain("新的性格设定");
    expect(prompt).toContain(AGENTS_NOTE);
  });

  it("性格设定文件不见了：用默认的，照样能启动", async () => {
    rmSync(personas, { recursive: true });
    const prepare = createLaunchPreparer({ db, launchDir: join(dir, "state", "launch"), personasDir: personas });
    expect(readFileSync((await prepare(session)).promptFile, "utf8")).toContain(DEFAULT_PM_PERSONA.trim());
  });
});

// ---- M2：m2-plan 第 4 节 W3 的提示词那几条 ----

const card = (id: number, name: string, mainFolder: string, otherFolders: string[] = [], description: string | null = null): ProjectCard => ({
  id,
  name,
  description,
  mainFolder,
  otherFolders,
});

function groupContext(over: Partial<LaunchContext> = {}): LaunchContext {
  const foo = card(1, "foo", "/work/foo", ["/work/foo-docs"], "做一个记账小工具");
  return {
    sessionId: 7,
    role: "pm",
    conversation: { id: 3, kind: "project_group" },
    pm: { id: 1, name: "小林", mode: "manage_only", persona: "# 性格设定\n\n- 说话直接。\n" },
    managedProjects: [foo, card(2, "bar", "/work/bar")],
    project: foo,
    handoff: { id: 5, fromPmName: "阿周", text: "发布日期定在周五。还差登录页。", createdAt: 1_700_000_000_000 },
    ...over,
  };
}

function privateContext(over: Partial<LaunchContext> = {}): LaunchContext {
  return {
    sessionId: 8,
    role: "pm",
    conversation: { id: 2, kind: "pm" },
    pm: { id: 1, name: "小林", mode: "hands_on", persona: PM_PERSONA_TEMPLATE },
    managedProjects: [card(1, "foo", "/work/foo", ["/work/foo-docs"], "做一个记账小工具"), card(2, "bar", "/work/bar")],
    project: null,
    handoff: null,
    ...over,
  };
}

describe("提示词：群", () => {
  it("manage_only：角色、性格、“只管理”的默认做法（要动手先问用户）、项目名和文件夹、交接正文、hub 用法", () => {
    const prompt = buildLaunchPrompt(groupContext(), dir);
    expect(prompt).toContain("小林");
    expect(prompt).toContain("项目群");
    expect(prompt).toContain("- 说话直接。");
    expect(prompt).toContain(PM_MODE_PROMPTS.manage_only);
    expect(PM_MODE_PROMPTS.manage_only).toMatch(/先问用户/);
    expect(prompt).not.toContain(PM_MODE_PROMPTS.hands_on);
    expect(prompt).toContain("foo");
    expect(prompt).toContain("做一个记账小工具");
    expect(prompt).toContain("/work/foo");
    expect(prompt).toContain("/work/foo-docs");
    expect(prompt).toContain("阿周");
    expect(prompt).toContain("发布日期定在周五。还差登录页。");
    expect(prompt).toContain(HUB_USAGE_PROMPT);
    // 群里只说这个项目：不放它管的别的项目
    expect(prompt).not.toContain("/work/bar");
    expect(prompt).not.toMatch(/\bbar\b/);
  });

  it("hub 用法写明直接敲 hub、不要在命令里写变量；长文本用 --stdin heredoc；列出 M2 的全部子命令", () => {
    expect(HUB_USAGE_PROMPT).toMatch(/不要在命令里写.*\$HUB_TOKEN/);
    expect(HUB_USAGE_PROMPT).toContain("--stdin <<'EOF'");
    for (const sub of [
      "hub status",
      "hub pm list",
      "hub project create --name",
      "hub project attach",
      "hub project detach",
      "hub project assign",
      "hub persona show",
      "hub persona edit",
    ]) {
      expect(HUB_USAGE_PROMPT).toContain(sub);
    }
  });

  it("按 M1 规则加“先读 AGENTS.md”：主文件夹里 AGENTS.md、CLAUDE.md 都有、CLAUDE.md 没引用时才加", () => {
    expect(buildLaunchPrompt(groupContext(), dir)).not.toContain(AGENTS_NOTE);
    writeFileSync(join(dir, "AGENTS.md"), "x");
    writeFileSync(join(dir, "CLAUDE.md"), "y");
    expect(buildLaunchPrompt(groupContext(), dir).trimEnd().endsWith(AGENTS_NOTE)).toBe(true);
  });

  it("没有交接、没有其他文件夹：不出交接那一节，文件夹写“没有”", () => {
    const foo = card(1, "foo", "/work/foo");
    const prompt = buildLaunchPrompt(groupContext({ project: foo, handoff: null }), dir);
    expect(prompt).not.toContain("最近一份交接");
    expect(prompt).toMatch(/其他文件夹：没有/);
  });

  it("性格设定是空的（用户清空了）：不出空的一节，其余照常", () => {
    const prompt = buildLaunchPrompt(groupContext({ pm: { id: 1, name: "小林", mode: "manage_only", persona: "  \n" } }), dir);
    expect(prompt).toContain(PM_MODE_PROMPTS.manage_only);
    expect(prompt).not.toMatch(/\n\n\n/);
  });
});

describe("提示词：私聊", () => {
  it("hands_on、管两个项目：有两个项目的名片和“自己也干活”的做法，没有某个项目的文件夹", () => {
    const prompt = buildLaunchPrompt(privateContext(), dir);
    expect(prompt).toContain("私聊");
    expect(prompt).toContain(PM_MODE_PROMPTS.hands_on);
    expect(prompt).not.toContain(PM_MODE_PROMPTS.manage_only);
    expect(prompt).toContain("foo");
    expect(prompt).toContain("做一个记账小工具");
    expect(prompt).toContain("bar");
    expect(prompt).not.toContain("/work/foo");
    expect(prompt).not.toContain("/work/bar");
    expect(prompt).not.toContain("项目信息");
    expect(prompt).toContain(HUB_USAGE_PROMPT);
    expect(prompt).toContain(PM_PERSONA_TEMPLATE.trim());
  });

  it("还没管项目：写明现在没有项目、怎么建", () => {
    const prompt = buildLaunchPrompt(privateContext({ managedProjects: [] }), dir);
    expect(prompt).toMatch(/还没有项目/);
    expect(prompt).toContain("hub project create");
  });
});

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
    ticketId: null,
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
      [7, groupContext()],
      [8, privateContext()],
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
    expect(prompt).toBe(buildLaunchPrompt(groupContext(), dir));
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

  it("群不随别的项目变：同一个项目经理又建了一个项目（managedProjects 多一个），群会话的 fingerprint 不变", async () => {
    const prepare = make();
    const before = await prepare(row(7));
    const ctx = groupContext();
    contexts.set(7, { ...ctx, managedProjects: [...ctx.managedProjects, card(9, "baz", "/work/baz")] });
    expect((await prepare(row(7))).fingerprint).toBe(before.fingerprint);
  });

  it("私聊会跟着变：多管一个项目，私聊会话的 fingerprint 变了", async () => {
    const prepare = make();
    const before = await prepare(row(8));
    const ctx = privateContext();
    contexts.set(8, { ...ctx, managedProjects: [...ctx.managedProjects, card(9, "baz", "/work/baz")] });
    expect((await prepare(row(8))).fingerprint).not.toBe(before.fingerprint);
  });

  it("性格设定、模式、文件夹、交接变了：fingerprint 都跟着变", async () => {
    const prepare = make();
    const base = (await prepare(row(7))).fingerprint;
    const ctx = groupContext();
    const variants: LaunchContext[] = [
      { ...ctx, pm: { ...ctx.pm, persona: "以后回复都用列表。" } },
      { ...ctx, pm: { ...ctx.pm, mode: "hands_on" } },
      { ...ctx, project: { ...ctx.project!, otherFolders: ["/work/foo-docs", "/work/more"] } },
      { ...ctx, handoff: null },
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
