import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSessionRow } from "../shared/index.ts";
import { createLedger } from "./ledger/index.ts";
import {
  AGENTS_NOTE,
  DEFAULT_PM_PERSONA,
  PM_ROLE_PROMPT,
  buildPmPrompt,
  createLaunchPreparer,
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
    const { pm, sessionId } = createLedger(db).createPm({ name: "项目经理", pmHomeRoot: join(dir, "pm-home") });
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
