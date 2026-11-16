// 项目经理加载过的技能（loaded_skills，迁移 0031；docs/skill-carryover-design.md）：
// - 记：applyDriverEvent 的同一个事务里，agent.tool（原生技能工具）、agent.tool_result（读文件、跑命令的返回）和
//   message.processing（用户手打技能命令）按 shared/skill-loads.ts 和已知技能名单（daemon/skill-files.ts）认出来，一个技能一行，再加载只更新；
// - 带：换代（handover.ts 的 switchIn，普通换代、开新会话、切换厂商都走它）时取旧一代的行，从磁盘读正文拼成开场说明里的一节；
//   带上正文的行改成新一代，所以新一代换代时又会带上，一代代往下传。正文不缓存，每次换代现读。
// 只记项目经理：Worker 不自动换代，总助跑完一轮就结束。
import { LRUCache } from "lru-cache";
import type { AgentSessionRow, ConversationId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import {
  SKILL_CARRYOVER_RECORDS_MAX,
  SKILL_CARRYOVER_SKILL_MAX_CHARS,
  SKILL_CARRYOVER_SKIPPED_LIST_MAX,
  SKILL_CARRYOVER_TOTAL_MAX_CHARS,
  SKILL_LOAD_PENDING_TOOLS_MAX,
} from "../../shared/limits.ts";
import {
  awaitsToolResult,
  skillNameOfToolCall,
  skillsOfToolResult,
  userSkillCommandOf,
  type KnownSkill,
  type ToolCall,
} from "../../shared/skill-loads.ts";
import type { SkillFiles } from "../skill-files.ts";
import type { LedgerContext } from "./context.ts";

type SkillSource = "user" | "model";

interface LoadedSkillRow {
  skill_key: string;
  name: string;
  path: string;
  source: SkillSource;
  loaded_at: number;
}

/** 开场说明里这一节的标题（handover.ts、vendor-switch-context.ts 放在说明头后面）。 */
export const LOADED_SKILLS_HEADING = "## 上一个会话加载过的技能";

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u;

/** 去掉 YAML frontmatter：名字和说明新会话的技能清单里本来就有，正文才是要带的。 */
const bodyOf = (text: string): string => text.replace(/^﻿/u, "").replace(FRONTMATTER_RE, "").trim();

/** 单个超过上限从前往后截（不切断代理对），末尾写全文在哪。 */
function clip(body: string, path: string): string {
  if (body.length <= SKILL_CARRYOVER_SKILL_MAX_CHARS) return body;
  let cut = SKILL_CARRYOVER_SKILL_MAX_CHARS;
  const last = body.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut--;
  return `${body.slice(0, cut)}\n\n（后面省略 ${body.length - cut} 字，全文在 ${path}）`;
}

const attr = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

const listed = (rows: readonly LoadedSkillRow[]): string => {
  const shown = rows.slice(0, SKILL_CARRYOVER_SKIPPED_LIST_MAX).map((r) => `${r.name}（${r.path}）`);
  const more = rows.length - shown.length;
  return `${shown.join("、")}${more > 0 ? `，另有 ${more} 个` : ""}`;
};

/**
 * 开场说明里的一节。用 `<skill>` 标签包正文，不用代码块：技能正文里常有 ``` 代码块，套代码块会提前闭合。
 * 什么都没有（旧一代没加载过技能）是 null。
 */
function renderSection(carried: readonly { row: LoadedSkillRow; body: string }[], skipped: readonly LoadedSkillRow[], missing: readonly LoadedSkillRow[]): string | null {
  if (carried.length === 0 && skipped.length === 0 && missing.length === 0) return null;
  const parts = [LOADED_SKILLS_HEADING];
  if (carried.length > 0) {
    parts.push(
      "下面是上一个会话里加载过的技能正文，按最近加载排在前面，是换会话时从磁盘读的最新版本。它们算你已经加载过，照上一个会话里一样用，不用再读一遍。",
      ...carried.map(({ row, body }) => `<skill name="${attr(row.name)}" path="${attr(row.path)}" loaded-by="${row.source}">\n${body}\n</skill>`),
    );
  }
  const notes: string[] = [];
  if (skipped.length > 0) notes.push(`没带正文（篇幅超了，要用时自己加载）：${listed(skipped)}`);
  if (missing.length > 0) notes.push(`文件已经没有了：${listed(missing)}`);
  if (notes.length > 0) parts.push(notes.join("\n"));
  return parts.join("\n\n");
}

export type LedgerLoadedSkills = ReturnType<typeof createLedgerLoadedSkills>;

export function createLedgerLoadedSkills(ctx: LedgerContext, skillFiles: SkillFiles) {
  const { db, now } = ctx;

  /** 调用发出、返回还没到的读文件和命令（会话 id + toolUseId）：返回到了一起认，取走就删。 */
  const pending = new LRUCache<string, ToolCall>({ max: SKILL_LOAD_PENDING_TOOLS_MAX });
  const pendingKey = (session: AgentSessionRow, toolUseId: string) => `${session.id}\0${toolUseId}`;

  const record = (session: AgentSessionRow, skill: KnownSkill | null, source: SkillSource) => {
    if (skill === null) return;
    db.run(
      `INSERT INTO loaded_skills (conversation_id, skill_key, name, path, source, generation, loaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (conversation_id, skill_key) DO UPDATE SET
         name = excluded.name, path = excluded.path, source = excluded.source, generation = excluded.generation, loaded_at = excluded.loaded_at`,
      session.conversationId,
      skill.key,
      skill.name,
      skill.path,
      source,
      session.generation,
      now(),
    );
    db.run(
      `DELETE FROM loaded_skills WHERE conversation_id = ? AND skill_key NOT IN
         (SELECT skill_key FROM loaded_skills WHERE conversation_id = ? ORDER BY loaded_at DESC LIMIT ?)`,
      session.conversationId,
      session.conversationId,
      SKILL_CARRYOVER_RECORDS_MAX,
    );
  };

  /** 在 applyDriverEvent 的事务里调。子代理里的工具调用不记（那不是项目经理自己的上下文）。 */
  const afterDriverEvent = (session: AgentSessionRow, event: DriverEvent) => {
    if (session.role !== "pm" || session.conversationId === null) return;
    switch (event.type) {
      case "agent.tool": {
        if (event.parentToolUseId !== undefined) return;
        const call = { name: event.name, input: event.input };
        if (awaitsToolResult(session.vendor, event.name)) {
          pending.set(pendingKey(session, event.toolUseId), call);
          return;
        }
        const name = skillNameOfToolCall(session.vendor, call);
        if (name !== null) record(session, skillFiles.catalog(session).named(name), "model");
        return;
      }
      case "agent.tool_result": {
        if (event.parentToolUseId !== undefined) return;
        for (const toolUseId of event.toolUseIds) {
          const key = pendingKey(session, toolUseId);
          const call = pending.get(key);
          if (call === undefined) continue;
          pending.delete(key);
          const output = event.outputs?.[toolUseId];
          if (output === undefined) continue;
          for (const skill of skillsOfToolResult(session.vendor, call, output, skillFiles.catalog(session))) record(session, skill, "model");
        }
        return;
      }
      case "message.processing": {
        if (event.messageIds.length === 0) return;
        const texts = db.all<{ text: string }>(
          `SELECT text FROM messages WHERE id IN (${event.messageIds.map(() => "?").join(", ")}) AND sender = 'user' AND kind = 'text' ORDER BY id`,
          ...event.messageIds,
        );
        for (const { text } of texts) {
          const name = userSkillCommandOf(session.vendor, text);
          if (name !== null) record(session, skillFiles.catalog(session).named(name), "user");
        }
        return;
      }
      default:
        return;
    }
  };

  /**
   * 换代（handover.ts 的 switchIn，同一个事务）：旧一代加载过的技能按最近加载排，从磁盘读正文，拼成开场说明里的一节。
   * 只读新会话现枚举的名单里的文件：先按真实路径找，找不到按名字找（任务图手册换了启动目录）；合计放不下的那个和之后的只列名字。带上正文的改成新一代（loaded_at 不变），
   * 没带上的留在旧一代、不再往下传。旧一代没加载过技能是 null。
   */
  const carryIn = (conversationId: ConversationId, fromGeneration: number, next: AgentSessionRow): string | null => {
    const rows = db.all<LoadedSkillRow>(
      "SELECT skill_key, name, path, source, loaded_at FROM loaded_skills WHERE conversation_id = ? AND generation = ? ORDER BY loaded_at DESC",
      conversationId,
      fromGeneration,
    );
    const carried: { row: LoadedSkillRow; body: string }[] = [];
    const skipped: LoadedSkillRow[] = [];
    const missing: LoadedSkillRow[] = [];
    /** 带上的真实路径：原来那个没了按名字找回来的，可能就是后面另一行记的那个文件，同一个文件只带一份。 */
    const carriedKeys = new Set<string>();
    const catalog = rows.length === 0 ? null : skillFiles.catalog(next, { fresh: true });
    let total = 0;
    for (const row of rows) {
      if (skipped.length > 0) {
        skipped.push(row);
        continue;
      }
      const skill = catalog?.byKey(row.skill_key) ?? catalog?.named(row.name) ?? null;
      const text = skill === null ? null : skillFiles.read(skill);
      if (skill === null || text === null) {
        missing.push(row);
        continue;
      }
      if (carriedKeys.has(skill.key)) continue;
      const body = clip(bodyOf(text), skill.path);
      if (total + body.length > SKILL_CARRYOVER_TOTAL_MAX_CHARS) {
        skipped.push(row);
        continue;
      }
      total += body.length;
      carriedKeys.add(skill.key);
      carried.push({ row: { ...row, path: skill.path }, body });
      db.run(
        "UPDATE OR REPLACE loaded_skills SET skill_key = ?, path = ?, generation = ? WHERE conversation_id = ? AND skill_key = ?",
        skill.key,
        skill.path,
        next.generation,
        conversationId,
        row.skill_key,
      );
    }
    return renderSection(carried, skipped, missing);
  };

  return { afterDriverEvent, carryIn };
}
