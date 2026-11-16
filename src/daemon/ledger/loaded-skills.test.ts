// 换代时带上加载过的技能（loaded-skills.ts，docs/skill-carryover-design.md）：加载那一刻记进 loaded_skills；换代（普通、手动、切换厂商）
// 时从磁盘读正文放进新会话的开场说明，按最近加载排，单个截断、合计放不下的只列名字；带过去的算新一代加载过，一代代往下传；
// 文件没了跳过并注明；删项目经理时清掉。技能文件放在临时目录里，按会话的工作目录、用户目录去找（daemon/skill-files.ts）。
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationId, MessageId, PmId, SessionId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import { PM_ARCHIVE_RETENTION_MS, SKILL_CARRYOVER_RECORDS_MAX, SKILL_CARRYOVER_SKILL_MAX_CHARS, SKILL_CARRYOVER_TOTAL_MAX_CHARS } from "../../shared/limits.ts";
import { createSessionStore } from "../store/index.ts";
import type { Db } from "../store/index.ts";
import { openTestDb } from "../store/test-helpers.ts";
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
  writeFileSync(path, `---\nname: ${name}\ndescription: 测试技能 ${name}\n---\n\n${body}`);
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

/** 模型调一次工具（parent 给了是子代理里的）。 */
function tool(sessionId: SessionId, name: string, input: unknown, parent?: string) {
  now += 10;
  seq++;
  event(sessionId, { type: "agent.tool", at: now, uuid: `u${seq}`, toolUseId: `t${seq}`, name, input, ...(parent === undefined ? {} : { parentToolUseId: parent }) });
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
    const read = skill("carry-model", "模型读的正文");
    skill("carry-tool", "技能工具的正文");
    skill("carry-user", "用户调用的正文");
    tool(firstSession, "Read", { file_path: read });
    tool(firstSession, "Skill", { skill: "carry-tool" });
    userTurn(firstSession, "/carry-user 记住它");
    expect(rows().map((r) => [r.name, r.source, r.generation])).toEqual([
      ["carry-user", "user", 1],
      ["carry-tool", "model", 1],
      ["carry-model", "model", 1],
    ]);
  });

  it("相对路径按工作目录解析；shell 里 cat 也算", () => {
    skill("rel", "相对路径");
    tool(firstSession, "Bash", { command: "cat .agents/skills/rel/SKILL.md" });
    expect(rows()).toMatchObject([{ name: "rel", source: "model" }]);
  });

  it("找不到 SKILL.md 的不记：名字对不上的技能、内置命令、不存在的文件", () => {
    tool(firstSession, "Skill", { skill: "slack:block-kit" });
    userTurn(firstSession, "/compact");
    tool(firstSession, "Read", { file_path: join(cwd, ".agents", "skills", "gone", "SKILL.md") });
    expect(rows()).toEqual([]);
  });

  it("子代理里的调用不记：那不是项目经理自己的上下文", () => {
    const path = skill("sub", "子代理读的");
    tool(firstSession, "Read", { file_path: path }, "parent-1");
    expect(rows()).toEqual([]);
  });

  it("软链和原文件算同一个技能（.claude/skills → .agents/skills）：只有一行，再加载只更新时间和来源", () => {
    skill("same", "同一个");
    mkdirSync(join(cwd, ".claude"));
    symlinkSync(join(cwd, ".agents", "skills"), join(cwd, ".claude", "skills"));
    tool(firstSession, "Read", { file_path: join(cwd, ".agents", "skills", "same", "SKILL.md") });
    const first = rows()[0]!.loaded_at;
    userTurn(firstSession, "/same");
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ name: "same", source: "user" });
    expect(rows()[0]!.loaded_at).toBeGreaterThan(first);
  });

  it(`每个对话最多记 ${SKILL_CARRYOVER_RECORDS_MAX} 个，超了删最久没加载的`, () => {
    const dir = join(root, "many", "skills");
    for (let i = 0; i <= SKILL_CARRYOVER_RECORDS_MAX; i++) tool(firstSession, "Read", { file_path: skill(`s${i}`, `第 ${i} 个`, dir) });
    const names = new Set(rows().map((r) => r.name));
    expect(names.size).toBe(SKILL_CARRYOVER_RECORDS_MAX);
    expect(names.has("s0")).toBe(false);
    expect(names.has(`s${SKILL_CARRYOVER_RECORDS_MAX}`)).toBe(true);
  });
});

describe("带：换代时放进新会话的开场说明", () => {
  it("正文从磁盘读最新的、去掉 frontmatter，按最近加载排；放在说明头后面、交接前面", () => {
    const older = skill("older", "旧的正文");
    skill("newer", "新的正文");
    tool(firstSession, "Read", { file_path: older });
    userTurn(firstSession, "/newer");
    writeFileSync(older, "---\nname: older\n---\n\n改过的旧正文");
    const { preamble } = renew();
    const section = sectionOf(preamble);
    expect(section).toContain("改过的旧正文");
    expect(section).not.toContain("旧的正文");
    expect(section).not.toContain("description: 测试技能");
    expect(section.indexOf('name="newer"')).toBeLessThan(section.indexOf('name="older"'));
    expect(section).toContain('loaded-by="user"');
    expect(section).toContain('loaded-by="model"');
    expect(preamble.indexOf("【系统】")).toBeLessThan(preamble.indexOf(SECTION));
    expect(preamble.indexOf(SECTION)).toBeLessThan(preamble.indexOf("## 交接"));
  });

  it("没加载过技能：开场说明里没有这一节", () => {
    userTurn(firstSession, "你好");
    expect(renew().preamble).not.toContain(SECTION);
  });

  it("单个超过上限从前往后截，末尾写全文路径", () => {
    const path = skill("big", `${"甲".repeat(SKILL_CARRYOVER_SKILL_MAX_CHARS)}尾巴`);
    tool(firstSession, "Read", { file_path: path });
    const section = sectionOf(renew().preamble);
    expect(section).not.toContain("尾巴");
    expect(section).toContain("后面省略");
    expect(section).toContain(path);
  });

  it("合计放不下的那个和之后的只列名字、留在旧一代；带上的改成新一代", () => {
    const each = Math.floor(SKILL_CARRYOVER_TOTAL_MAX_CHARS / 3) + 1;
    for (const name of ["d", "c", "b", "a"]) tool(firstSession, "Read", { file_path: skill(name, `${name.repeat(name === "d" ? 10 : each)}`) });
    // 最近的是 a：a、b 放得下，c 放不下，d 虽小也排在 c 后面，只列名字
    const section = sectionOf(renew().preamble);
    expect(section).toContain('name="a"');
    expect(section).toContain('name="b"');
    expect(section).not.toContain('name="c"');
    expect(section).not.toContain('name="d"');
    expect(section).toMatch(/没带正文[^\n]*c（[^\n]*d（/);
    expect(Object.fromEntries(rows().map((r) => [r.name, r.generation]))).toEqual({ a: 2, b: 2, c: 1, d: 1 });
  });

  it("文件没了：跳过、注明，不往下传", () => {
    const path = skill("gone", "会被删");
    tool(firstSession, "Read", { file_path: path });
    rmSync(path);
    const section = sectionOf(renew().preamble);
    expect(section).toContain("文件已经没有了");
    expect(section).toContain("gone");
    expect(rows()).toMatchObject([{ name: "gone", generation: 1 }]);
  });

  it("原路径没了、按名字在新会话的技能目录里找得到：读找到的那个", () => {
    const path = skill("moved", "原来的", join(root, "elsewhere", "skills"));
    tool(firstSession, "Read", { file_path: path });
    rmSync(path);
    skill("moved", "挪到用户目录的", join(userHome, ".agents", "skills"));
    const section = sectionOf(renew().preamble);
    expect(section).toContain("挪到用户目录的");
    expect(rows()).toMatchObject([{ name: "moved", generation: 2 }]);
  });
});

describe("传下去", () => {
  it("第 1 代加载、第 2 代没再加载，第 3 代开场里还在", () => {
    tool(firstSession, "Read", { file_path: skill("keep", "一直要用的规矩") });
    const g2 = renew();
    expect(sectionOf(g2.preamble)).toContain("一直要用的规矩");
    userTurn(g2.next, "接着干");
    const g3 = renew();
    expect(sectionOf(g3.preamble)).toContain("一直要用的规矩");
    expect(rows()).toMatchObject([{ name: "keep", generation: 3 }]);
  });

  it("新一代里又加载一次：只更新时间和来源，排到最前", () => {
    tool(firstSession, "Read", { file_path: skill("x", "x 正文") });
    tool(firstSession, "Read", { file_path: skill("y", "y 正文") });
    const g2 = renew();
    userTurn(g2.next, "/x");
    const section = sectionOf(renew().preamble);
    expect(section.indexOf('name="x"')).toBeLessThan(section.indexOf('name="y"'));
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
    tool(firstSession, "Read", { file_path: skill("auto", "自动换代也带") });
    createSessionStore(db).update(firstSession, { usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: 10 } });
    userTurn(firstSession, "你好");
    const job = ledger.claimHandover()!;
    ledger.handoverForked(job.handoverId, { kind: "native", ref: { forker: "claude", handle: { forkId: "auto" } } });
    ledger.handoverWritten(job.handoverId, { text: "交接", usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: 0 } });
    expect(sectionOf(ledger.sessionPreamble(currentSession())!)).toContain("自动换代也带");
  });

  it("切换厂商：开场说明（本代原样回放）同样带，放在说明头后面、本代对话前面", () => {
    tool(firstSession, "Read", { file_path: skill("switch", "切厂商也带") });
    userTurn(firstSession, "你好");
    ledger.editPersona(pmId, { vendor: "codex" }, { kind: "user" });
    const next = currentSession();
    expect(next).not.toBe(firstSession);
    const preamble = ledger.sessionPreamble(next)!;
    expect(sectionOf(preamble)).toContain("切厂商也带");
    expect(preamble.indexOf(SECTION)).toBeLessThan(preamble.indexOf("## 本代完整对话"));
    expect(db.get<{ skills_section: string | null }>("SELECT skills_section FROM handovers ORDER BY id DESC LIMIT 1")!.skills_section).toContain("切厂商也带");
  });
});

describe("清理", () => {
  it("彻底删除项目经理：这个对话的记录一起删", () => {
    tool(firstSession, "Read", { file_path: skill("del", "要删的") });
    expect(rows()).toHaveLength(1);
    ledger.archivePm(pmId);
    ledger.purgeExpiredArchivedPms(now + PM_ARCHIVE_RETENTION_MS + 1);
    expect(db.all("SELECT * FROM loaded_skills")).toEqual([]);
  });
});
