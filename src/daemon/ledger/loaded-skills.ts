import { LRUCache } from "lru-cache";
import type { AgentSessionRow, ConversationId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import {
  SKILL_CARRYOVER_LIST_MAX,
  SKILL_CARRYOVER_RECORDS_MAX,
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
import { TASK_GRAPH_SKILL_NAME } from "../../shared/task-graph-skill.ts";
import type { SkillFiles } from "../skill-files.ts";
import type { LedgerContext } from "./context.ts";
import {
  renderLoadedSkillsIndex,
  type MissingSkillEntry,
  type SkillIndexEntry,
} from "./handover-budget.ts";

type SkillSource = "user" | "model";

interface LoadedSkillRow {
  skill_key: string;
  name: string;
  path: string;
  source: SkillSource;
  loaded_at: number;
}

export type LedgerLoadedSkills = ReturnType<typeof createLedgerLoadedSkills>;

export function createLedgerLoadedSkills(ctx: LedgerContext, skillFiles: SkillFiles) {
  const { db, now } = ctx;

  const pending = new LRUCache<string, ToolCall>({ max: SKILL_LOAD_PENDING_TOOLS_MAX });
  const pendingKey = (session: AgentSessionRow, toolUseId: string) => `${session.id}\0${toolUseId}`;

  const record = (session: AgentSessionRow, skill: KnownSkill | null, source: SkillSource) => {
    if (skill === null) return;
    // Keep 'user' sticky within a conversation so subsequent model reads of SKILL.md never downgrade user-invoked skills.
    db.run(
      `INSERT INTO loaded_skills (conversation_id, skill_key, name, path, source, generation, loaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (conversation_id, skill_key) DO UPDATE SET
         name = excluded.name,
         path = excluded.path,
         source = CASE WHEN loaded_skills.source = 'user' THEN 'user' ELSE excluded.source END,
         generation = excluded.generation,
         loaded_at = excluded.loaded_at`,
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
          `SELECT text FROM messages WHERE id IN (${event.messageIds.map(() => "?").join(", ")}) AND session_id = ? AND sender = 'user' AND kind = 'text' ORDER BY id`,
          ...event.messageIds,
          session.id,
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

  const carryIn = (
    conversationId: ConversationId,
    fromGeneration: number,
    next: AgentSessionRow,
    options?: { vendorSwitch?: boolean },
  ): string | null => {
    const vendorSwitch = options?.vendorSwitch === true;
    // Order user-invoked skills first so explicit user instructions are never crowded out by model reads.
    const rows = db.all<LoadedSkillRow>(
      `SELECT skill_key, name, path, source, loaded_at FROM loaded_skills
        WHERE conversation_id = ? AND generation = ?
        ORDER BY CASE WHEN source = 'user' THEN 0 ELSE 1 END, loaded_at DESC`,
      conversationId,
      fromGeneration,
    );
    const available: SkillIndexEntry[] = [];
    const missing: MissingSkillEntry[] = [];
    const carriedKeys = new Set<string>();
    const catalog = rows.length === 0 ? null : skillFiles.catalog(next, { fresh: true });

    for (const row of rows) {
      // Built-in fusa-task-graph is written asynchronously on next's session.start and already linked in prompt.ts.
      if (row.name === TASK_GRAPH_SKILL_NAME) continue;
      const skill = catalog?.byKey(row.skill_key) ?? catalog?.named(row.name) ?? null;
      if (skill === null) {
        missing.push({ name: row.name, path: row.path });
        continue;
      }
      if (carriedKeys.has(skill.key)) continue;
      carriedKeys.add(skill.key);
      available.push({
        name: row.name,
        path: skill.path,
        source: row.source,
        description: skill.description ?? null,
      });
      if ((row.source === "user" || vendorSwitch) && available.length <= SKILL_CARRYOVER_LIST_MAX) {
        db.run(
          "UPDATE OR REPLACE loaded_skills SET skill_key = ?, path = ?, generation = ? WHERE conversation_id = ? AND skill_key = ?",
          skill.key,
          skill.path,
          next.generation,
          conversationId,
          row.skill_key,
        );
      }
    }
    return renderLoadedSkillsIndex({ available, missing });
  };

  return { afterDriverEvent, carryIn };
}
