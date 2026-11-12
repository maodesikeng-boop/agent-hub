// 从一次试跑的账本（只读打开）、gh 替身记录、只记录替身的记录里取事实（设计 4.1）。检查只看这里出来的 Facts。
// 图的形状经这一个函数读：以后第 4 步改表结构，只改这里。
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import type { Facts, FactGraph, FactMessage, FactWorker, GhCall, RecordedCall, TrialMetrics } from "./types.ts";

const parse = <T>(text: string | null | undefined, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return [];
      }
    });
}

export interface FactsInput {
  dbFile: string;
  pmConversationId: number;
  ghCallsFile: string;
  recordFile: string;
  injected: Facts["injected"];
  startedAt: number;
  endedAt: number;
}

type Row = Record<string, unknown>;

/** 这次试跑自己的账本（临时数据目录里的，不是用户的）：守护进程开着时也要能读（WAL），所以不用只读模式打开；只跑 SELECT。 */
function openTrialDb(file: string): DatabaseSync {
  return new DatabaseSync(file);
}
const num = (v: unknown) => Number(v);
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

export function readFacts(input: FactsInput): Facts {
  const db = openTrialDb(input.dbFile);
  try {
    const all = (sql: string, ...params: Array<string | number>) => db.prepare(sql).all(...params) as Row[];
    const pmSessionIds = all("SELECT id FROM agent_sessions WHERE role = 'pm' AND conversation_id = ? ORDER BY id", input.pmConversationId).map((r) => num(r.id));
    const inList = pmSessionIds.length > 0 ? pmSessionIds.join(",") : "-1";
    const hubCalls = all(`SELECT id, command, args, ok, created_at FROM hub_calls WHERE session_id IN (${inList}) ORDER BY id`).map((r) => ({
      id: num(r.id),
      command: str(r.command),
      args: parse<Record<string, unknown>>(str(r.args), {}),
      ok: num(r.ok) === 1,
      at: num(r.created_at),
    }));
    const workers: FactWorker[] = all(
      `SELECT w.*, (SELECT vendor FROM agent_sessions s WHERE s.worker_id = w.id ORDER BY s.id DESC LIMIT 1) AS vendor,
              (SELECT model FROM agent_sessions s WHERE s.worker_id = w.id ORDER BY s.id DESC LIMIT 1) AS session_model
       FROM workers w WHERE w.pm_conversation_id = ? ORDER BY w.id`,
      input.pmConversationId,
    ).map((r) => ({
      id: num(r.id),
      title: str(r.title),
      task: str(r.task),
      vendor: str(r.vendor),
      model: (r.model ?? r.session_model ?? null) as string | null,
      readonly: num(r.readonly) === 1,
      branch: (r.branch ?? null) as string | null,
      worktreePath: (r.worktree_path ?? null) as string | null,
      status: str(r.status),
      createdAt: num(r.created_at),
    }));
    const graphs: FactGraph[] = all("SELECT id, title, created_at FROM task_graphs WHERE conversation_id = ? ORDER BY id", input.pmConversationId).map((g) => ({
      id: num(g.id),
      title: str(g.title),
      createdAt: num(g.created_at),
      nodes: all("SELECT node_key, title, kind, status, worker_ids_json, created_at FROM task_graph_steps WHERE graph_id = ? ORDER BY sort_order, id", num(g.id)).map((n) => ({
        key: str(n.node_key),
        title: str(n.title),
        kind: str(n.kind),
        status: str(n.status),
        workerIds: parse<number[]>(str(n.worker_ids_json), []),
        createdAt: num(n.created_at),
      })),
      edges: all("SELECT from_key, to_key FROM task_graph_edges WHERE graph_id = ?", num(g.id)).map((e) => ({ from: str(e.from_key), to: str(e.to_key) })),
    }));
    const messages: FactMessage[] = all("SELECT id, sender, kind, text, meta, status, failure_reason, created_at FROM messages WHERE conversation_id = ? ORDER BY id", input.pmConversationId).map((m) => ({
      id: num(m.id),
      at: num(m.created_at),
      sender: str(m.sender),
      kind: str(m.kind),
      text: str(m.text),
      meta: parse<Record<string, unknown> | null>(str(m.meta), null),
      status: (m.status ?? null) as string | null,
      failureReason: (m.failure_reason ?? null) as string | null,
    }));
    const tools = messages
      .filter((m) => m.kind === "tool" && m.sender === "agent" && m.meta !== null)
      .map((m) => ({ messageId: m.id, at: m.at, name: str(m.meta!.name), input: (m.meta!.input ?? {}) as Record<string, unknown> }));
    const pmId = num(all("SELECT pm_id FROM conversations WHERE id = ?", input.pmConversationId)[0]?.pm_id ?? -1);
    const personaChanges = all("SELECT id, actor, created_at, text_after FROM persona_changes WHERE pm_id = ? ORDER BY id", pmId).map((r) => ({
      id: num(r.id),
      actor: str(r.actor),
      at: num(r.created_at),
      textAfter: str(r.text_after),
    }));
    const personaSeen = all(`SELECT session_id, revision FROM session_persona_seen WHERE session_id IN (${inList})`).map((r) => ({ sessionId: num(r.session_id), revision: num(r.revision) }));
    return {
      pmConversationId: input.pmConversationId,
      pmSessionIds,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      hubCalls,
      workers,
      graphs,
      tools,
      messages,
      gh: readJsonl<GhCall>(input.ghCallsFile),
      recorded: readJsonl<RecordedCall>(input.recordFile),
      personaChanges,
      personaSeen,
      injected: input.injected,
    };
  } finally {
    db.close();
  }
}

/** 每次试跑都记、不设过不过的数（设计 4.2 末尾）：出场轮数、工具调用、hub 命令、提问、用量、用时。 */
export function readMetrics(dbFile: string, facts: Facts): TrialMetrics {
  const db = openTrialDb(dbFile);
  try {
    const inList = facts.pmSessionIds.length > 0 ? facts.pmSessionIds.join(",") : "-1";
    const turns = db.prepare(`SELECT count(*) AS n FROM session_steps WHERE kind = 'turn_started' AND session_id IN (${inList})`).get() as { n: number };
    const usages = db.prepare(`SELECT token_usage FROM agent_sessions WHERE id IN (${inList})`).all() as Array<{ token_usage: string | null }>;
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const { token_usage } of usages) {
      const u = parse<Partial<typeof tokens>>(token_usage, {});
      tokens.input += u.input ?? 0;
      tokens.output += u.output ?? 0;
      tokens.cacheRead += u.cacheRead ?? 0;
      tokens.cacheWrite += u.cacheWrite ?? 0;
    }
    return {
      pmTurns: Number(turns.n),
      toolCalls: facts.tools.length,
      hubCalls: facts.hubCalls.length,
      asks: facts.messages.filter((m) => m.sender === "agent" && m.meta?.needsUser === true).length,
      unscriptedAnswers: facts.injected.filter((e) => e.kind === "answer" && e.detail.startsWith("（剧本外）")).length,
      durationMs: facts.endedAt - facts.startedAt,
      tokens,
    };
  } finally {
    db.close();
  }
}

/** PM 的轮数（事件循环里查上限用）。 */
export function countPmTurns(dbFile: string, pmConversationId: number): number {
  const db = openTrialDb(dbFile);
  try {
    const row = db
      .prepare("SELECT count(*) AS n FROM session_steps WHERE kind = 'turn_started' AND session_id IN (SELECT id FROM agent_sessions WHERE role = 'pm' AND conversation_id = ?)")
      .get(pmConversationId) as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

/** 正在开工的 Worker（事件循环里找注入时机用）。 */
export function listWorkers(dbFile: string, pmConversationId: number): Array<{ id: number; title: string; task: string }> {
  const db = openTrialDb(dbFile);
  try {
    return db.prepare("SELECT id, title, task FROM workers WHERE pm_conversation_id = ? ORDER BY id").all(pmConversationId) as Array<{ id: number; title: string; task: string }>;
  } finally {
    db.close();
  }
}
