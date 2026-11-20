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

export const LOADED_SKILLS_HEADING = "## 上一个会话加载过的技能";

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/u;

const bodyOf = (text: string): string => text.replace(/^﻿/u, "").replace(FRONTMATTER_RE, "").trim();

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
  if (missing.length > 0) notes.push(`读不到了（文件没了或不在技能目录里）：${listed(missing)}`);
  if (notes.length > 0) parts.push(notes.join("\n"));
  return parts.join("\n\n");
}

export type LedgerLoadedSkills = ReturnType<typeof createLedgerLoadedSkills>;

export function createLedgerLoadedSkills(ctx: LedgerContext, skillFiles: SkillFiles) {
  const { db, now } = ctx;

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

  const carryIn = (conversationId: ConversationId, fromGeneration: number, next: AgentSessionRow): string | null => {
    const rows = db.all<LoadedSkillRow>(
      "SELECT skill_key, name, path, source, loaded_at FROM loaded_skills WHERE conversation_id = ? AND generation = ? ORDER BY loaded_at DESC",
      conversationId,
      fromGeneration,
    );
    const carried: { row: LoadedSkillRow; body: string }[] = [];
    const skipped: LoadedSkillRow[] = [];
    const missing: LoadedSkillRow[] = [];
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
