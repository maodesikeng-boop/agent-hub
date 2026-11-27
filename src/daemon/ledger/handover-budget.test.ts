import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationId, MessageId, PmId, SessionId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import {
  AGY_HANDOVER_MAX_SINGLE_MESSAGE_BYTES,
  DEFAULT_HANDOVER_MAX_SINGLE_MESSAGE_BYTES,
  HANDOVER_MIN_PREAMBLE_BYTES,
  MAX_MESSAGE_BYTES,
  SKILL_CARRYOVER_DESCRIPTION_MAX_CHARS,
  SKILL_CARRYOVER_INDEX_MAX_BYTES,
  SKILL_CARRYOVER_LIST_MAX,
} from "../../shared/limits.ts";
import { AGENT_VENDORS, handoverMaxSingleMessageBytesOf } from "../../shared/vendors.ts";
import { checkAcpUserBlocks } from "../../vendors/_common/acp/protocol.ts";
import { openTestDb } from "../store/test-helpers.ts";
import type { Db } from "../store/index.ts";
import { createLedger } from "./index.ts";
import type { SqliteLedger } from "./index.ts";
import {
  assembleBudgetedPreamble,
  computePreambleByteBudget,
  extractSkillDescription,
  fitLegacyPreambleToBudget,
  measureTurnReservedBytes,
  renderLoadedSkillsIndex,
  sliceUtf8HeadSafe,
  sliceUtf8TailSafe,
  type HandoverPreambleSections,
} from "./handover-budget.ts";

function hasNoLoneSurrogates(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

describe("handover-budget unit contracts (new behavior — expected to fail before implementation)", () => {
  it("S10: resolves per-vendor single-message byte cap across all registered vendors", () => {
    for (const vendor of AGENT_VENDORS) {
      const cap = handoverMaxSingleMessageBytesOf(vendor);
      if (vendor === "agy") expect(cap).toBe(AGY_HANDOVER_MAX_SINGLE_MESSAGE_BYTES);
      else expect(cap).toBe(DEFAULT_HANDOVER_MAX_SINGLE_MESSAGE_BYTES);
    }
    expect(handoverMaxSingleMessageBytesOf("unknown-vendor")).toBe(DEFAULT_HANDOVER_MAX_SINGLE_MESSAGE_BYTES);
  });

  it("S9: slices UTF-8 heads and tails within byte limits without lone UTF-16 surrogates", () => {
    const sample = "甲😀乙🚀丙丁";
    for (let limit = 0; limit <= utf8Bytes(sample) + 2; limit++) {
      const head = sliceUtf8HeadSafe(sample, limit);
      const tail = sliceUtf8TailSafe(sample, limit);
      expect(utf8Bytes(head)).toBeLessThanOrEqual(limit);
      expect(utf8Bytes(tail)).toBeLessThanOrEqual(limit);
      expect(hasNoLoneSurrogates(head)).toBe(true);
      expect(hasNoLoneSurrogates(tail)).toBe(true);
    }
    expect(sliceUtf8HeadSafe(sample, -5)).toBe("");
    expect(sliceUtf8TailSafe(sample, 0)).toBe("");
  });

  it("S9 & S11: extracts normalized single-line frontmatter descriptions across LF, CRLF, BOM, and malformed files", () => {
    const crlf = "\uFEFF---\r\nname: demo\r\ndescription: \"Line one\\n  line two\"\r\n---\r\n\r\n# Body\r\n";
    expect(extractSkillDescription(crlf)).toBe("Line one line two");

    const longDesc = `---\nname: big\ndescription: ${"说".repeat(SKILL_CARRYOVER_DESCRIPTION_MAX_CHARS + 50)}\n---\nbody`;
    const extracted = extractSkillDescription(longDesc);
    expect(extracted).not.toBeNull();
    expect([...extracted!].length).toBeLessThanOrEqual(SKILL_CARRYOVER_DESCRIPTION_MAX_CHARS);

    expect(extractSkillDescription("---\nname: broken\ndescription: unclosed")).toBeNull();
    expect(extractSkillDescription("# No frontmatter here")).toBeNull();
  });

  it("S1 & S11: renders compact loaded-skills index capped at SKILL_CARRYOVER_INDEX_MAX_BYTES with Windows and POSIX paths", () => {
    const available = Array.from({ length: SKILL_CARRYOVER_LIST_MAX + 10 }, (_, i) => ({
      name: `skill-${i}`,
      path: i % 2 === 0 ? `/Users/dev/.agents/skills/skill-${i}/SKILL.md` : `C:\\Users\\dev\\.agents\\skills\\skill-${i}\\SKILL.md`,
      source: i === 0 ? ("user" as const) : ("model" as const),
      description: `用途说明 ${i} ${"描".repeat(30)}`,
    }));
    const rendered = renderLoadedSkillsIndex({ available, missing: [{ name: "gone", path: "/gone/SKILL.md" }] });
    expect(rendered).not.toBeNull();
    expect(utf8Bytes(rendered!)).toBeLessThanOrEqual(SKILL_CARRYOVER_INDEX_MAX_BYTES);
    expect(rendered!).toContain("skill-0");
    expect(rendered!).toContain("C:\\Users\\dev\\.agents\\skills\\skill-1\\SKILL.md");
    expect(rendered!).toContain("gone");
    expect(rendered!).not.toContain("<skill ");

    expect(renderLoadedSkillsIndex({ available: [], missing: [] })).toBeNull();
    expect(renderLoadedSkillsIndex({ available, missing: [] }, 4)).toBeNull();
  });

  it("S2 & S9: computes byte budget with reservedBytes clamping and measures turn reserved overhead", () => {
    const reserved = measureTurnReservedBytes({
      text: "最".repeat(10_000),
      prefixes: ["【系统提示】"],
      systemPrompt: "<system_instructions>rules</system_instructions>",
      deliverySuffix: "[任务图状态]",
    });
    expect(reserved).toBeGreaterThanOrEqual(utf8Bytes("最".repeat(10_000)));
    expect(computePreambleByteBudget("agy", reserved)).toBe(AGY_HANDOVER_MAX_SINGLE_MESSAGE_BYTES - reserved);
    expect(computePreambleByteBudget("agy", -100)).toBe(AGY_HANDOVER_MAX_SINGLE_MESSAGE_BYTES);
    expect(computePreambleByteBudget("agy", Number.NaN)).toBe(AGY_HANDOVER_MAX_SINGLE_MESSAGE_BYTES);
    expect(computePreambleByteBudget("agy", AGY_HANDOVER_MAX_SINGLE_MESSAGE_BYTES + 5_000)).toBe(0);
  });

  it("S2, S9 & S10: assembleBudgetedPreamble enforces priority tiers, trims oldest history first, and returns null when budget < HANDOVER_MIN_PREAMBLE_BYTES", () => {
    const sections: HandoverPreambleSections = {
      header: "【系统】这是新会话，直接回应末尾最新消息。",
      skillsIndex: "## 上一个会话加载过的技能（索引）\n\n- `poteto-mode`（用户调用，路径：`/skills/poteto-mode/SKILL.md`）",
      summaryHeading: "## 交接",
      summaryBody: `核心目标与定案：${"摘".repeat(2_000)}`,
      historyHeading: "## 最近的原话",
      historyEntriesNewestFirst: [
        "用户：NEWEST_HISTORY_MARKER_KEEP",
        ...Array.from({ length: 80 }, (_, i) => `用户：历史消息 #${i} ${"旧".repeat(800)}`),
      ],
      historyEmptyText: "（没有）",
      historyTruncatedHint: "（更早历史已按预算省略）",
      reportsHeading: "## 交接之后到的 Worker 汇报",
      reports: ["- #101「修复预算」做完了，全文 `hub worker show 101 --report`"],
      pendingAsksSection: "## 在等用户的提问卡（账本实时状态）\n\n- 提问 #1：LIVE_ASK_MARKER",
      agendaSection: "## 当前活跃任务与待办\n\n- 图 #168：LIVE_AGENDA_MARKER",
    };

    const userMsgBytes = 50 * 1024;
    const result = assembleBudgetedPreamble(sections, { vendor: "agy", reservedBytes: userMsgBytes });
    expect(result.text).not.toBeNull();
    expect(result.totalBytes).toBe(utf8Bytes(result.text!));
    expect(result.totalBytes + userMsgBytes).toBeLessThanOrEqual(AGY_HANDOVER_MAX_SINGLE_MESSAGE_BYTES);
    expect(hasNoLoneSurrogates(result.text!)).toBe(true);
    expect(result.historyTruncated).toBe(true);
    expect(result.text!).toContain("LIVE_ASK_MARKER");
    expect(result.text!).toContain("LIVE_AGENDA_MARKER");
    expect(result.text!).toContain("NEWEST_HISTORY_MARKER_KEEP");
    expect(result.text!).not.toContain("历史消息 #79");

    const zeroRoom = assembleBudgetedPreamble(sections, {
      vendor: "agy",
      reservedBytes: AGY_HANDOVER_MAX_SINGLE_MESSAGE_BYTES - HANDOVER_MIN_PREAMBLE_BYTES + 1,
    });
    expect(zeroRoom.text).toBeNull();
    expect(zeroRoom.totalBytes).toBe(0);
  });

  it("S4 & S9: fitLegacyPreambleToBudget bounds pre-upgrade oversized preamble blobs while keeping live sections", () => {
    const legacyBlob = `【旧版开场】\n\n${"旧".repeat(100_000)}`;
    const live = ["## 在等用户的提问卡（账本实时状态）\n\n- LEGACY_LIVE_ASK"];
    const fitted = fitLegacyPreambleToBudget(legacyBlob, live, { vendor: "agy", reservedBytes: 40 * 1024 });
    expect(fitted.text).not.toBeNull();
    expect(fitted.totalBytes + 40 * 1024).toBeLessThanOrEqual(AGY_HANDOVER_MAX_SINGLE_MESSAGE_BYTES);
    expect(fitted.text!).toContain("LEGACY_LIVE_ASK");
    expect(hasNoLoneSurrogates(fitted.text!)).toBe(true);
  });
});

describe("end-to-end ledger handover & skill carryover acceptance scenarios", () => {
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

  beforeEach(() => {
    db = openTestDb();
    root = mkdtempSync(join(tmpdir(), "agent-hub-handover-budget-"));
    userHome = join(root, "user");
    mkdirSync(userHome);
    now = 10_000;
    ledger = createLedger(db, {
      now: () => now,
      pmHomeRoot: join(root, "pm-home"),
      userHome,
      launchDir: join(root, "launch"),
    });
    const created = ledger.createPm({ name: "统筹", mode: "manage_only", persona: "", defaultModel: "opus" });
    pmId = created.pm.id;
    conversationId = created.conversation.id;
    firstSession = created.sessionId;
    cwd = db.get<{ cwd: string }>("SELECT cwd FROM agent_sessions WHERE id = ?", firstSession)!.cwd;
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function writeSkill(name: string, body: string, description = `技能 ${name} 说明`): string {
    const dir = join(cwd, ".agents", "skills", name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
    return path;
  }

  function currentSession(): SessionId {
    return db.get<{ id: number }>("SELECT id FROM agent_sessions WHERE conversation_id = ? ORDER BY generation DESC LIMIT 1", conversationId)!.id;
  }

  function emit(sessionId: SessionId, event: DriverEvent): void {
    ledger.applyDriverEvent(sessionId, event);
  }

  function modelReadSkill(sessionId: SessionId, path: string): void {
    now += 10;
    seq += 1;
    const toolUseId = `tool-${seq}`;
    const output = readFileSync(path, "utf8").split("\n").map((line, i) => `${i + 1}\t${line}`).join("\n");
    emit(sessionId, { type: "agent.tool", at: now, uuid: `u-${seq}`, toolUseId, name: "Read", input: { file_path: path } });
    emit(sessionId, { type: "agent.tool_result", at: now, toolUseIds: [toolUseId], outputs: { [toolUseId]: output } });
  }

  function completeUserTurn(sessionId: SessionId, text: string, reply = "收到"): MessageId {
    now += 10;
    const id = ledger.postUserMessage({ conversationId, clientId: `c-${++seq}`, text }).messageId;
    const hadPreamble = ledger.sessionPreamble(sessionId) !== null;
    emit(sessionId, { type: "message.delivered", at: now, messageIds: [id] });
    emit(sessionId, { type: "message.processing", at: now, messageIds: [id], ...(hadPreamble ? { preamble: true as const } : {}) });
    emit(sessionId, { type: "agent.text", at: now, uuid: `reply-${++seq}`, text: reply });
    emit(sessionId, { type: "turn.ended", at: now, ok: true, interrupted: false, messageIds: [id], durationMs: 1 });
    return id;
  }

  function manualRenew(summary = "阶段性交接摘要"): SessionId {
    now += 10;
    emit(currentSession(), { type: "turn.ended", at: now, ok: true, interrupted: false, messageIds: [], durationMs: 1 });
    const { handoverId } = ledger.renewSession(pmId);
    ledger.claimHandover();
    ledger.handoverForked(handoverId, { kind: "native", ref: { forker: "claude", handle: { forkId: `f-${handoverId}` } } });
    ledger.handoverWritten(handoverId, { text: summary, usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: 0 } });
    return currentSession();
  }

  describe("new & changed behavior (expected to fail before implementation)", () => {
    it("S1: carries lightweight skill index instead of full SKILL.md bodies, persists user skills, and decays model skills across generations", () => {
      const userSkillPath = writeSkill("poteto-mode", `UNIQUE_USER_SKILL_BODY_${"甲".repeat(12_000)}`, "项目经理主控流程");
      const modelSkillPaths = Array.from({ length: 15 }, (_, i) =>
        writeSkill(`hist-${i}`, `UNIQUE_MODEL_BODY_${i}_${"乙".repeat(8_000)}`, `历史技能 ${i}`),
      );
      completeUserTurn(firstSession, "/poteto-mode 开始");
      for (const path of modelSkillPaths) modelReadSkill(firstSession, path);

      const g2 = manualRenew();
      const preambleG2 = ledger.sessionPreamble(g2)!;
      expect(preambleG2).toContain("poteto-mode");
      expect(preambleG2).toContain(userSkillPath);
      expect(preambleG2).not.toContain("UNIQUE_USER_SKILL_BODY_");
      expect(preambleG2).not.toContain("UNIQUE_MODEL_BODY_0_");
      expect(preambleG2).not.toContain("<skill ");
      expect(utf8Bytes(preambleG2)).toBeLessThanOrEqual(DEFAULT_HANDOVER_MAX_SINGLE_MESSAGE_BYTES);

      // Process Turn 1 on g2 without re-reading model skills, then renew to g3:
      // user-invoked poteto-mode stays indexed; unreferenced model-loaded skills decay out.
      completeUserTurn(g2, "继续下一步");
      const g3 = manualRenew();
      const preambleG3 = ledger.sessionPreamble(g3)!;
      expect(preambleG3).toContain("poteto-mode");
      expect(preambleG3).not.toContain("hist-0");
    });

    it("S2 & S5: switching to agy with >200 KiB history and a 50 KiB latest user message bounds preamble strictly under AGY_HANDOVER_MAX_SINGLE_MESSAGE_BYTES", () => {
      for (let i = 0; i < 40; i++) {
        completeUserTurn(firstSession, `第 ${i} 轮讨论 ${"谈".repeat(2_000)}`, `第 ${i} 轮回复 ${"答".repeat(2_000)}`);
      }
      const latestUserMessage = `最末关键指令 ${"终".repeat(16_000)} TAIL_USER_MARKER_MUST_SURVIVE`;
      const reservedBytes = utf8Bytes(latestUserMessage);

      ledger.editPersona(pmId, { vendor: "agy" }, { kind: "user" });
      const agySession = currentSession();
      const preamble = ledger.sessionPreamble(agySession, { reservedBytes })!;

      expect(preamble).not.toBeNull();
      expect(utf8Bytes(preamble) + reservedBytes).toBeLessThanOrEqual(AGY_HANDOVER_MAX_SINGLE_MESSAGE_BYTES);
      expect(hasNoLoneSurrogates(preamble)).toBe(true);
      expect(preamble).toContain("第 39 轮");
      expect(preamble).not.toContain("第 0 轮");
    });

    it("S4: daemon restart before Turn 1 still enforces agy byte budget on a pre-upgrade oversized handovers.preamble blob", () => {
      const g2 = manualRenew("旧摘要");
      db.run("UPDATE agent_sessions SET vendor = 'agy' WHERE id = ?", g2);
      db.run("UPDATE handovers SET preamble = ? WHERE to_session_id = ?", `【旧版超长开场】\n${"膨".repeat(80_000)}`, g2);

      // Re-open ledger on the same DB to simulate daemon restart before Turn 1.
      const restarted = createLedger(db, {
        now: () => now,
        pmHomeRoot: join(root, "pm-home"),
        userHome,
        launchDir: join(root, "launch"),
      });
      const reservedBytes = 32 * 1024;
      const preamble = restarted.sessionPreamble(g2, { reservedBytes })!;
      expect(utf8Bytes(preamble) + reservedBytes).toBeLessThanOrEqual(AGY_HANDOVER_MAX_SINGLE_MESSAGE_BYTES);
    });

    it("S1: preserves both user and model skills across same-generation vendor switches", () => {
      writeSkill("poteto-mode", `USER_BODY_${"甲".repeat(5_000)}`, "用户主控技能");
      writeSkill("tdd", `MODEL_BODY_${"乙".repeat(5_000)}`, "测试驱动开发");
      completeUserTurn(firstSession, "/poteto-mode 开始");
      modelReadSkill(firstSession, join(cwd, ".agents", "skills", "tdd", "SKILL.md"));
      emit(firstSession, { type: "turn.ended", at: ++now, ok: true, interrupted: false, messageIds: [], durationMs: 1 });

      ledger.editPersona(pmId, { vendor: "codex" }, { kind: "user" });
      const codexSession = currentSession();
      expect(codexSession).not.toBe(firstSession);
      const preambleCodex = ledger.sessionPreamble(codexSession)!;
      expect(preambleCodex).toContain("poteto-mode");
      expect(preambleCodex).toContain("tdd");
      expect(preambleCodex).not.toContain("USER_BODY_");
      expect(preambleCodex).not.toContain("MODEL_BODY_");

      completeUserTurn(codexSession, "再切一家");
      ledger.editPersona(pmId, { vendor: "agy" }, { kind: "user" });
      const agySession = currentSession();
      expect(agySession).not.toBe(codexSession);
      const preambleAgy = ledger.sessionPreamble(agySession)!;
      expect(preambleAgy).toContain("poteto-mode");
      expect(preambleAgy).toContain("tdd");
      expect(preambleAgy).not.toContain("MODEL_BODY_");
    });

    it("S6 & S10: ACP writeBatch allows a valid 70 KiB user message plus budgeted preamble within the vendor ceiling", () => {
      const userBlock = { type: "text" as const, text: "a".repeat(70 * 1024) };
      const preambleBlock = { type: "text" as const, text: "b".repeat(50 * 1024) };
      const cap = handoverMaxSingleMessageBytesOf("deepseek");
      expect(checkAcpUserBlocks([preambleBlock, userBlock])).not.toBeNull();
      expect(checkAcpUserBlocks([preambleBlock, userBlock], cap)).toBeNull();
      expect(utf8Bytes(userBlock.text) + utf8Bytes(preambleBlock.text)).toBeLessThanOrEqual(cap);
    });

    it("S8: one-month volume (300 finished Workers, 30,000 messages, 50,000 step logs, 200 skills) stays within agy byte ceiling", () => {
      db.transaction(() => {
        for (let i = 0; i < 30_000; i++) {
          const sender = i % 2 === 0 ? "user" : "agent";
          db.run(
            "INSERT INTO messages (conversation_id, session_id, sender, kind, text, dedupe_key, status, created_at, updated_at) VALUES (?, ?, ?, 'text', ?, ?, ?, ?, ?)",
            conversationId,
            firstSession,
            sender,
            `历史消息 ${i} ${"文".repeat(20)}`,
            `seed:${i}`,
            sender === "user" ? "replied" : null,
            now + i,
            now + i,
          );
        }
        for (let i = 0; i < 200; i++) {
          db.run(
            "INSERT INTO loaded_skills (conversation_id, skill_key, name, path, source, generation, loaded_at) VALUES (?, ?, ?, ?, 'model', 1, ?)",
            conversationId,
            `/fake/skill-${i}/SKILL.md`,
            `s-${i}`,
            `/fake/skill-${i}/SKILL.md`,
            now + i,
          );
        }
      });

      ledger.editPersona(pmId, { vendor: "agy" }, { kind: "user" });
      const agySession = currentSession();
      const reservedBytes = 60 * 1024;
      const preamble = ledger.sessionPreamble(agySession, { reservedBytes })!;
      expect(utf8Bytes(preamble) + reservedBytes).toBeLessThanOrEqual(AGY_HANDOVER_MAX_SINGLE_MESSAGE_BYTES);
    });
  });

  describe("unchanged-rule regressions (expected to pass before and after implementation)", () => {
    it("S3: Turn 2 after message.processing { preamble: true } receives null sessionPreamble so prompt cache prefix stays immutable", () => {
      completeUserTurn(firstSession, "第一代消息");
      const g2 = manualRenew();
      expect(ledger.sessionPreamble(g2)).not.toBeNull();
      completeUserTurn(g2, "新一代第一句");
      expect(ledger.sessionPreamble(g2)).toBeNull();
    });

    it("S6: swapped symlink pointing outside trusted skill roots never leaks external content", () => {
      modelReadSkill(firstSession, writeSkill("escaped", "合法正文"));
      const outside = join(root, "outside");
      mkdirSync(join(outside, "escaped"), { recursive: true });
      writeFileSync(join(outside, "escaped", "SKILL.md"), "---\nname: escaped\ndescription: OUTSIDE_SECRET_DESC\n---\n\nOUTSIDE_SECRET_BODY\n");
      rmSync(join(cwd, ".agents", "skills"), { recursive: true });
      symlinkSync(outside, join(cwd, ".agents", "skills"));

      const g2 = manualRenew();
      const preamble = ledger.sessionPreamble(g2)!;
      expect(preamble).not.toContain("OUTSIDE_SECRET_BODY");
      expect(preamble).not.toContain("OUTSIDE_SECRET_DESC");
      expect(preamble).toContain("读不到了（文件没了或不在技能目录里）");
    });

    it("S6: ACP checkAcpUserBlocks still rejects a raw single user message exceeding MAX_MESSAGE_BYTES", () => {
      const oversizedRaw = [{ type: "text" as const, text: "x".repeat(MAX_MESSAGE_BYTES + 1) }];
      expect(checkAcpUserBlocks(oversizedRaw)).toMatch(/exceeds/u);
    });
  });
});
