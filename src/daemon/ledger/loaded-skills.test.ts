import { PM_AGENDA_PREAMBLE_HEADING } from "../../shared/pm-agenda.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationId, MessageId, PmId, SessionId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import { PM_ARCHIVE_RETENTION_MS, SKILL_CARRYOVER_INDEX_MAX_BYTES, SKILL_CARRYOVER_LIST_MAX, SKILL_CARRYOVER_RECORDS_MAX } from "../../shared/limits.ts";
import { createSessionStore } from "../store/index.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
import { createResolveFolder } from "./files.ts";
import { createLedger } from "./index.ts";
import type { SqliteLedger } from "./index.ts";

const SECTION = "## 上一个会话加载过的技能";

let db: Db;
let root: string;
let userHome: string;
let ledger: SqliteLedger;
let now: number;
let pmId: PmId;
let conversationId: ConversationId;
let firstSession: SessionId;
let cwd: string;
let seq = 0;

interface LoadedRow {
  conversation_id: number;
  skill_key: string;
  name: string;
  path: string;
  source: string;
  generation: number;
  loaded_at: number;
}

beforeEach(() => {
  db = openTestDb();
  root = mkdtempSync(join(tmpdir(), "agent-hub-skills-"));
  userHome = join(root, "user");
  mkdirSync(userHome);
  now = 1_000;
  ledger = createLedger(db, { now: () => now, pmHomeRoot: join(root, "pm-home"), userHome, launchDir: join(root, "launch") });
  const created = ledger.createPm({ name: "小林", mode: "manage_only", persona: "", defaultModel: "opus" });
  pmId = created.pm.id;
  conversationId = created.conversation.id;
  firstSession = created.sessionId;
  cwd = db.get<{ cwd: string }>("SELECT cwd FROM agent_sessions WHERE id = ?", firstSession)!.cwd;
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

/** 在 dir/<名字>/SKILL.md 写一个技能（带 frontmatter），返回路径。 */
function skill(name: string, body: string, dir = join(cwd, ".agents", "skills")): string {
  mkdirSync(join(dir, name), { recursive: true });
  const path = join(dir, name, "SKILL.md");
  writeFileSync(path, `---\nname: ${name}\ndescription: 测试技能 ${name}\n---\n\n${body}\n`);
  return path;
}

function rows(): LoadedRow[] {
  return db.all<LoadedRow>("SELECT * FROM loaded_skills WHERE conversation_id = ? ORDER BY loaded_at DESC, name", conversationId);
}

function currentSession(): SessionId {
  return db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE conversation_id = ? ORDER BY generation DESC LIMIT 1", conversationId)!.id;
}

function event(sessionId: SessionId, e: DriverEvent) {
  ledger.applyDriverEvent(sessionId, e);
}

/** 模型调一次工具；给了 output 就接着返回（parent 给了是子代理里的）。 */
function tool(sessionId: SessionId, name: string, input: unknown, options: { output?: string; parent?: string } = {}) {
  now += 10;
  seq++;
  const toolUseId = `t${seq}`;
  const subtask = options.parent === undefined ? {} : { parentToolUseId: options.parent };
  event(sessionId, { type: "agent.tool", at: now, uuid: `u${seq}`, toolUseId, name, input, ...subtask });
  if (options.output !== undefined) event(sessionId, { type: "agent.tool_result", at: now, toolUseIds: [toolUseId], outputs: { [toolUseId]: options.output }, ...subtask });
}

/** claude 的 Read 读一个文件：返回是现在磁盘上的内容，每行“行号\t正文”；文件不在返回报错。 */
function read(sessionId: SessionId, path: string, parent?: string) {
  let output = "File does not exist.";
  try {
    output = readFileSync(path, "utf8").split("\n").map((line, i) => `${i + 1}\t${line}`).join("\n");
  } catch {
    // 用上面的报错
  }
  tool(sessionId, "Read", { file_path: path }, { output, ...(parent === undefined ? {} : { parent }) });
}

/** 用户发一句、会话开始处理它（这一刻认用户手打的技能命令）、这一轮结束。 */
function userTurn(sessionId: SessionId, text: string): MessageId {
  now += 10;
  const id = ledger.postUserMessage({ conversationId, clientId: `c${++seq}`, text }).messageId;
  const preamble = ledger.sessionPreamble(sessionId) !== null;
  event(sessionId, { type: "message.delivered", at: now, messageIds: [id] });
  event(sessionId, { type: "message.processing", at: now, messageIds: [id], ...(preamble ? { preamble: true as const } : {}) });
  event(sessionId, { type: "turn.ended", at: now, ok: true, interrupted: false, messageIds: [id], durationMs: 1 });
  return id;
}

/** 资料页点开新会话、交接写完、旧会话空闲：换到下一代，返回新会话和它的开场说明。 */
function renew(): { next: SessionId; preamble: string } {
  now += 10;
  // 模型调过工具的那一轮先结束，会话空闲了才换
  event(currentSession(), { type: "turn.ended", at: now, ok: true, interrupted: false, messageIds: [], durationMs: 1 });
  const { handoverId } = ledger.renewSession(pmId);
  ledger.claimHandover();
  ledger.handoverForked(handoverId, { kind: "native", ref: { forker: "claude", handle: { forkId: `f${handoverId}` } } });
  ledger.handoverWritten(handoverId, { text: "交接正文", usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: 0 } });
  const next = currentSession();
  return { next, preamble: ledger.sessionPreamble(next) ?? "" };
}

/** 开场说明里技能那一节（到下一个二级标题为止）。 */
function sectionOf(preamble: string): string {
  const at = preamble.indexOf(SECTION);
  if (at === -1) return "";
  const end = preamble.indexOf("\n## ", at + SECTION.length);
  return end === -1 ? preamble.slice(at) : preamble.slice(at, end);
}

describe("记：加载那一刻", () => {
  it("模型读 SKILL.md、用原生技能工具、用户手打命令都记一行；带过的名字、来源、代数都对", () => {
    const path = skill("carry-model", "模型读的正文");
    skill("carry-tool", "技能工具的正文");
    skill("carry-user", "用户调用的正文");
    read(firstSession, path);
    tool(firstSession, "Skill", { skill: "carry-tool" });
    userTurn(firstSession, "/carry-user 记住它");
    expect(rows().map((r) => [r.name, r.source, r.generation])).toEqual([
      ["carry-user", "user", 1],
      ["carry-tool", "model", 1],
      ["carry-model", "model", 1],
    ]);
  });

  it("shell 命令按返回认：cd 进技能目录再读几个也都认", () => {
    const a = skill("ra", "甲");
    const b = skill("rb", "乙");
    const output = `${readFileSync(a, "utf8")}${readFileSync(b, "utf8")}`;
    tool(firstSession, "Bash", { command: "cd .agents/skills && cat ra/SKILL.md rb/SKILL.md" }, { output });
    expect(rows().map((r) => r.name).sort()).toEqual(["ra", "rb"]);
  });

  it("调用和返回分开到，中间隔了别的工具也认；没有调用的返回（守护进程重启过）不认、不报错", () => {
    const path = skill("later", "晚到的");
    now += 10;
    event(firstSession, { type: "agent.tool", at: now, uuid: "u-a", toolUseId: "a", name: "Bash", input: { command: "cat x" } });
    tool(firstSession, "Edit", { file_path: "y" });
    event(firstSession, { type: "agent.tool_result", at: now, toolUseIds: ["a"], outputs: { a: readFileSync(path, "utf8") } });
    event(firstSession, { type: "agent.tool_result", at: now, toolUseIds: ["ghost"], outputs: { ghost: readFileSync(path, "utf8") } });
    expect(rows()).toMatchObject([{ name: "later" }]);
  });

  it("找不到的不记：名字对不上的技能、内置命令、不存在的文件、没带返回原文的", () => {
    tool(firstSession, "Skill", { skill: "slack:block-kit" });
    userTurn(firstSession, "/compact");
    read(firstSession, join(cwd, ".agents", "skills", "gone", "SKILL.md"));
    const path = skill("no-output", "驱动没给返回原文");
    tool(firstSession, "Bash", { command: `cat ${path}` });
    event(firstSession, { type: "agent.tool_result", at: now, toolUseIds: [`t${seq}`] });
    expect(rows()).toEqual([]);
  });

  it("子代理里的调用不记：那不是项目经理自己的上下文", () => {
    const path = skill("sub", "子代理读的");
    read(firstSession, path, "parent-1");
    expect(rows()).toEqual([]);
  });

  it("返回原文只用来认：不进 messages、session_steps", () => {
    const path = skill("quiet", "QUIET_SKILL_BODY_MARKER");
    read(firstSession, path);
    expect(rows()).toMatchObject([{ name: "quiet" }]);
    const leaked = db.get<{ n: number }>(
      "SELECT (SELECT count(*) FROM messages WHERE text LIKE '%QUIET_SKILL_BODY_MARKER%' OR meta LIKE '%QUIET_SKILL_BODY_MARKER%') + (SELECT count(*) FROM session_steps WHERE summary LIKE '%QUIET_SKILL_BODY_MARKER%') AS n",
    )!.n;
    expect(leaked).toBe(0);
  });

  it("软链和原文件算同一个技能（.claude/skills → .agents/skills）：只有一行，再加载只更新时间和来源", () => {
    skill("same", "同一个");
    mkdirSync(join(cwd, ".claude"));
    symlinkSync(join(cwd, ".agents", "skills"), join(cwd, ".claude", "skills"));
    read(firstSession, join(cwd, ".claude", "skills", "same", "SKILL.md"));
    const first = rows()[0]!.loaded_at;
    userTurn(firstSession, "/same");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ name: "same", source: "user" });
    expect(rows()[0]!.loaded_at).toBeGreaterThan(first);
  });

  it(`每个对话最多记 ${SKILL_CARRYOVER_RECORDS_MAX} 个，超了删最久没加载的`, () => {
    for (let i = 0; i <= SKILL_CARRYOVER_RECORDS_MAX; i++) read(firstSession, skill(`s${i}`, `第 ${i} 个`));
    const names = new Set(rows().map((r) => r.name));
    expect(names.size).toBe(SKILL_CARRYOVER_RECORDS_MAX);
    expect(names.has("s0")).toBe(false);
    expect(names.has(`s${SKILL_CARRYOVER_RECORDS_MAX}`)).toBe(true);
  });
});

describe("记：认不出、不该认的不打断这一轮", () => {
  it("FAIL 评论里让旧实现抛错的命令：这一步照样记进账本，技能按返回认", () => {
    const path = skill("after", "后面读的");
    tool(firstSession, "Bash", { command: 'H="abc def"; echo ${H%% *}; cat .agents/skills/after/SKILL.md' }, { output: `abc\n${readFileSync(path, "utf8")}` });
    tool(firstSession, "Bash", { command: "node - <<'EOF'\nconsole.log(`${Math.random()}`)\nEOF" }, { output: "0.42\n" });
    const steps = db.get<{ n: number }>("SELECT count(*) AS n FROM messages WHERE session_id = ? AND kind = 'tool'", firstSession)!.n;
    expect(steps).toBe(2);
    expect(rows()).toMatchObject([{ name: "after" }]);
  });

  it("名字、路径穿越出技能目录的不记：技能目录外面的 SKILL.md 读不到", () => {
    writeFileSync(join(cwd, "SKILL.md"), "不是技能");
    mkdirSync(join(cwd, "skills"));
    tool(firstSession, "Skill", { skill: "../../.." });
    tool(firstSession, "Skill", { skill: ".." });
    tool(firstSession, "Read", { file_path: "skills/../SKILL.md" }, { output: "1\t不是技能" });
    tool(firstSession, "Bash", { command: "cat skills/../SKILL.md" }, { output: "不是技能" });
    userTurn(firstSession, "/..");
    expect(rows()).toEqual([]);
  });
});

describe("带：换代时放进新会话的开场说明（轻量索引）", () => {
  it("只带路径与最新单行简介、不贴正文；用户调用排在模型加载前面；放在说明头后面、交接前面", () => {
    const older = skill("older", "旧的正文");
    const newer = skill("newer", "新的正文");
    read(firstSession, older);
    userTurn(firstSession, "/newer");
    writeFileSync(older, "---\nname: older\ndescription: 改过的简介\n---\n\n改过的旧正文");
    const { preamble } = renew();
    const section = sectionOf(preamble);
    expect(section).toContain("改过的简介");
    expect(section).toContain(older);
    expect(section).toContain(newer);
    expect(section).not.toContain("改过的旧正文");
    expect(section).not.toContain("新的正文");
    expect(section).not.toContain("<skill ");
    expect(section.indexOf("`newer`")).toBeLessThan(section.indexOf("`older`"));
    expect(section).toContain("用户调用");
    expect(section).toContain("模型加载");
    expect(preamble.indexOf("【系统】")).toBeLessThan(preamble.indexOf(SECTION));
    expect(preamble.indexOf(SECTION)).toBeLessThan(preamble.indexOf("## 交接"));
  });

  it("没加载过技能：开场说明里没有这一节", () => {
    userTurn(firstSession, "你好");
    expect(renew().preamble).not.toContain(SECTION);
  });

  it("单个超大正文技能只列路径与简介、整节不超过 SKILL_CARRYOVER_INDEX_MAX_BYTES", () => {
    const path = skill("big", `${"甲".repeat(30_000)}尾巴`);
    read(firstSession, path);
    const section = sectionOf(renew().preamble);
    expect(section).not.toContain("尾巴");
    expect(section).not.toContain("甲甲甲");
    expect(section).toContain(path);
    expect(Buffer.byteLength(section, "utf8")).toBeLessThanOrEqual(SKILL_CARRYOVER_INDEX_MAX_BYTES);
  });

  it("超多技能按列表和字节上限收敛并注明省略数量，用户调用技能优先保留并推进代数", () => {
    userTurn(firstSession, (() => {
      skill("pinned", "用户调用的正文");
      return "/pinned";
    })());
    for (let i = 0; i < SKILL_CARRYOVER_LIST_MAX + 5; i++) {
      read(firstSession, skill(`m-${i}`, `正文 ${i}`));
    }
    const section = sectionOf(renew().preamble);
    expect(section).toContain("`pinned`");
    expect(Buffer.byteLength(section, "utf8")).toBeLessThanOrEqual(SKILL_CARRYOVER_INDEX_MAX_BYTES);
    expect(section).toContain("已省略");
    expect(rows().find((r) => r.name === "pinned")?.generation).toBe(2);
    expect(rows().find((r) => r.name === "m-0")?.generation).toBe(1);
  });

  it("文件没了：跳过、注明，不往下传", () => {
    const path = skill("gone", "会被删");
    read(firstSession, path);
    rmSync(path);
    const section = sectionOf(renew().preamble);
    expect(section).toContain("读不到了（文件没了或不在技能目录里）");
    expect(section).toContain("gone");
    expect(rows()).toMatchObject([{ name: "gone", generation: 1 }]);
  });

  it.each([
    ["整个 .agents", () => join(cwd, ".agents"), "skills/swapped/SKILL.md"],
    ["技能目录 .agents/skills", () => join(cwd, ".agents", "skills"), "swapped/SKILL.md"],
    ["单个技能目录", () => join(cwd, ".agents", "skills", "swapped"), "SKILL.md"],
  ] as const)("第 1 代合法加载后，%s 掉包成指到外面的软链：换代不读外面的文件，和文件没了一样注明", (_what, at, rest) => {
    read(firstSession, skill("swapped", "合法的正文"));
    const outside = join(root, "outside");
    mkdirSync(join(outside, rest, ".."), { recursive: true });
    writeFileSync(join(outside, rest), "---\nname: swapped\ndescription: OUTSIDE_SECRET_DESC\n---\n\nOUTSIDE_SWAPPED_CONTENT\n");
    rmSync(at(), { recursive: true });
    symlinkSync(outside, at());
    const section = sectionOf(renew().preamble);
    expect(section).not.toContain("OUTSIDE_SWAPPED_CONTENT");
    expect(section).not.toContain("OUTSIDE_SECRET_DESC");
    expect(section).toContain("读不到了（文件没了或不在技能目录里）");
    expect(section).toContain("swapped");
  });

  it("原路径没了、按名字在新会话的技能目录里找得到：索引指向新路径", () => {
    const path = skill("moved", "原来的");
    userTurn(firstSession, "/moved");
    rmSync(path);
    const movedPath = skill("moved", "挪到用户目录的", join(userHome, ".agents", "skills"));
    const section = sectionOf(renew().preamble);
    expect(section).toContain(movedPath);
    expect(rows()).toMatchObject([{ name: "moved", generation: 2 }]);
  });
  it("同名的两个技能，新的那个没了、按名字找回旧的那个：开场里只放一份", () => {
    const globalPath = skill("dup", "全局的", join(userHome, ".agents", "skills"));
    tool(firstSession, "Skill", { skill: "dup" });
    const project = skill("dup", "项目的");
    read(firstSession, project);
    rmSync(project);
    const section = sectionOf(renew().preamble);
    expect(section.split("`dup`")).toHaveLength(2);
    expect(section).toContain(globalPath);
  });
});

describe("传下去", () => {
  it("用户调用的技能跨代保留，模型加载的技能仅跨 1 跳后衰减", () => {
    skill("keep", "一直要用的规矩");
    userTurn(firstSession, "/keep");
    read(firstSession, skill("ephemeral", "只用一次的技能"));
    const g2 = renew();
    expect(sectionOf(g2.preamble)).toContain("`keep`");
    expect(sectionOf(g2.preamble)).toContain("`ephemeral`");
    userTurn(g2.next, "接着干");
    const g3 = renew();
    expect(sectionOf(g3.preamble)).toContain("`keep`");
    expect(sectionOf(g3.preamble)).not.toContain("`ephemeral`");
    expect(rows().find((r) => r.name === "keep")).toMatchObject({ generation: 3 });
  });

  it("新一代里用户又调用一次：更新来源为 user 并推进到下一代", () => {
    read(firstSession, skill("x", "x 正文"));
    skill("y", "y 正文");
    userTurn(firstSession, "/y");
    const g2 = renew();
    userTurn(g2.next, "/x");
    const section = sectionOf(renew().preamble);
    expect(section.indexOf("`x`")).toBeLessThan(section.indexOf("`y`"));
    expect(rows().find((r) => r.name === "x")).toMatchObject({ source: "user", generation: 3 });
  });
});

describe("三条换代的路都带", () => {
  it("自动换代（到门槛）", () => {
    const fresh = createLedger(db, {
      now: () => now,
      pmHomeRoot: join(root, "pm-home"),
      userHome,
      launchDir: join(root, "launch"),
      autoRenew: { contextTokens: 1 },
    });
    ledger = fresh;
    const autoPath = skill("auto", "自动换代也带");
    read(firstSession, autoPath);
    createSessionStore(db).update(firstSession, { usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: 10 } });
    userTurn(firstSession, "你好");
    const job = ledger.claimHandover()!;
    ledger.handoverForked(job.handoverId, { kind: "native", ref: { forker: "claude", handle: { forkId: "auto" } } });
    ledger.handoverWritten(job.handoverId, { text: "交接", usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: 0 } });
    const section = sectionOf(ledger.sessionPreamble(currentSession())!);
    expect(section).toContain("`auto`");
    expect(section).toContain(autoPath);
    expect(section).not.toContain("自动换代也带");
  });

  it("切换厂商：开场说明（本代原样回放）同样带索引且同代模型技能保留代数", () => {
    const switchPath = skill("switch", "切厂商也带");
    read(firstSession, switchPath);
    userTurn(firstSession, "你好");
    ledger.editPersona(pmId, { vendor: "codex" }, { kind: "user" });
    const next = currentSession();
    expect(next).not.toBe(firstSession);
    const preamble = ledger.sessionPreamble(next)!;
    expect(sectionOf(preamble)).toContain("`switch`");
    expect(sectionOf(preamble)).toContain(switchPath);
    expect(sectionOf(preamble)).not.toContain("切厂商也带");
    expect(preamble.indexOf(SECTION)).toBeLessThan(preamble.indexOf("## 本代完整对话"));
    expect(db.get<{ skills_section: string | null }>("SELECT skills_section FROM handovers ORDER BY id DESC LIMIT 1")!.skills_section).toContain("`switch`");
    expect(rows().find((r) => r.name === "switch")?.generation).toBe(2);
  });
});

describe("和提问卡交付物、提醒卡交汇（#333、#336）", () => {
  /** 换一个带项目文件夹、能注入厂商状态的账本和项目经理（提问卡挂的文件要在项目文件夹里，提醒卡看厂商状态）。 */
  function withProject(availability: (vendor: string) => "available" | "signed_out" = () => "available"): string {
    const folder = join(root, "proj");
    mkdirSync(folder, { recursive: true });
    ledger = createLedger(db, {
      now: () => now,
      pmHomeRoot: join(root, "pm-home"),
      dataHome: join(root, "data"),
      userHome,
      launchDir: join(root, "launch"),
      shareTmpDirs: [],
      osSandboxed: () => true,
      deviceName: () => "测试机",
      models: { current: () => null, availability },
      resolveFolder: createResolveFolder({ dataHome: join(root, "data"), userHome }),
    });
    const created = ledger.createPm({ name: "林经理", mode: "manage_only", persona: "", folder });
    pmId = created.pm.id;
    conversationId = created.conversation.id;
    firstSession = created.sessionId;
    cwd = db.get<{ cwd: string }>("SELECT cwd FROM agent_sessions WHERE id = ?", firstSession)!.cwd;
    return folder;
  }

  it("上一代挂了带文件的提问卡（hub ask --file）又加载了技能：开场里技能在交接前、卡在实时提问卡一节，卡的交付物不动，用户技能算新一代的", async () => {
    const folder = withProject();
    writeFileSync(join(folder, "plan.md"), "方案");
    const askSkillPath = skill("with-ask", "提问卡旁边的技能");
    userTurn(firstSession, "/with-ask");
    const files = [{ label: "方案", path: join(folder, "plan.md") }];
    ledger.hubCall(firstSession, "ask", { text: "方案好了，请验收", options: ["通过", "打回"], files }, { sharedFiles: await ledger.shareHubFiles(firstSession, files) });
    const deliverables = db.all("SELECT * FROM router_item_deliverables");
    expect(deliverables).toHaveLength(1);

    const { next, preamble } = renew();
    expect(sectionOf(preamble)).toContain("`with-ask`");
    expect(sectionOf(preamble)).toContain(askSkillPath);
    const asks = preamble.indexOf("## 在等用户的提问卡");
    expect(preamble.indexOf(SECTION)).toBeLessThan(preamble.indexOf("## 交接"));
    expect(preamble.indexOf("## 交接")).toBeLessThan(asks);
    expect(preamble.slice(asks)).toContain("方案好了，请验收");
    expect(db.all("SELECT * FROM router_item_deliverables")).toEqual(deliverables);
    const nextGeneration = db.get<{ generation: number }>("SELECT generation FROM agent_sessions WHERE id = ?", next)!.generation;
    expect(rows().map((r) => [r.name, r.generation])).toEqual([["with-ask", nextGeneration]]);
  });

  it("上一代对话里有厂商没登录的提醒卡又加载了技能：换代后技能带上、卡还挂在这个对话、等用户的步骤进实时任务图一节", () => {
    withProject((vendor) => (vendor === "agy" ? "signed_out" : "available"));
    const blockerSkillPath = skill("with-blocker", "提醒卡旁边的技能");
    read(firstSession, blockerSkillPath);
    const graph = ledger.hubCall(firstSession, "graph.create", {
      specJson: JSON.stringify({ title: "交汇验收", steps: [{ key: "verify", title: "验收", brief: "跑一遍", vendor: "agy" }] }),
    }).data.graph;
    const cards = () => db.all("SELECT * FROM user_blocker_cards WHERE conversation_id = ?", conversationId);
    const before = cards();
    expect(before).toHaveLength(1);

    const { preamble } = renew();
    expect(sectionOf(preamble)).toContain("`with-blocker`");
    expect(sectionOf(preamble)).toContain(blockerSkillPath);
    expect(cards()).toEqual(before);
    expect(db.get<{ status: string }>("SELECT status FROM user_blockers")!.status).toBe("open");
    const graphs = preamble.indexOf(PM_AGENDA_PREAMBLE_HEADING);
    expect(graphs).toBeGreaterThan(preamble.indexOf(SECTION));
    expect(preamble.slice(graphs)).toContain(graph.title);
    expect(preamble.slice(graphs)).toContain("verify：等用户，动手");
  });
});

describe("清理", () => {
  it("彻底删除项目经理：这个对话的记录一起删", () => {
    read(firstSession, skill("del", "要删的"));
    expect(rows()).toHaveLength(1);
    ledger.archivePm(pmId);
    ledger.purgeExpiredArchivedPms(now + PM_ARCHIVE_RETENTION_MS + 1);
    expect(db.all("SELECT * FROM loaded_skills")).toEqual([]);
  });
});
