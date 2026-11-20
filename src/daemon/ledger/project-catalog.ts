import type { DriverEvent } from "../../shared/driver.ts";
import { truncateChars, type AgentSessionRow, type MessageId, type ProjectId, type TokenUsage } from "../../shared/domain.ts";
import {
  PROJECT_CATALOG_DIALOG_MAX_CHARS,
  PROJECT_CATALOG_GIVE_UP_MS,
  PROJECT_CATALOG_GRAPHS_MAX,
  PROJECT_CATALOG_HANDOVER_MAX_CHARS,
  PROJECT_CATALOG_INPUT_ITEM_MAX_CHARS,
  PROJECT_CATALOG_MAX_ATTEMPTS,
  PROJECT_CATALOG_REFRESH_DELTA,
  PROJECT_CATALOG_RETRY_BACKOFF_MS,
  PROJECT_CATALOG_ROW_MAX_BYTES,
  PROJECT_CATALOG_WORKER_REPORTS_MAX,
} from "../../shared/limits.ts";
import {
  catalogCardOf,
  catalogDue,
  changeScore,
  projectCatalogSchema,
  type CatalogDueState,
  type CatalogFailure,
  type CatalogJob,
  type CatalogRefreshInput,
  type LedgerProjectCatalogWork,
  type ProjectCatalog,
  type ProjectCatalogCard,
  type ProjectCatalogDetail,
} from "../../shared/project-catalog.ts";
import type { LedgerContext, Pending } from "./context.ts";
import type { LedgerProjects } from "./projects.ts";
import type { ProjectDbRow } from "./rows.ts";

type CatalogForceReason = "project_created" | "graph_finished" | "handover_switched";

export interface LedgerProjectCatalog extends LedgerProjectCatalogWork {
  scanAtStartup(nowMs: number): number;
  afterDriverEvent(p: Pending, session: AgentSessionRow, event: DriverEvent): void;
  markForcedIn(p: Pending, projectId: ProjectId, reason: CatalogForceReason): void;
  cardOf(projectId: ProjectId): ProjectCatalogCard | null;
  detailOf(projectId: ProjectId): ProjectCatalogDetail | null;
  hasQueued(): boolean;
}

export interface ProjectCatalogLedgerOptions {
  /** Called after commit to wake the background runner. */
  onCatalogClaimable?: () => void;
}

interface CatalogDbRow {
  project_id: number;
  catalog_json: string | null;
  cut_message_id: number;
  refreshed_at: number | null;
  forced: number;
  attempts: number;
  next_attempt_at: number | null;
}

const ACTIVE_PROJECT = `SELECT p.* FROM projects p LEFT JOIN pm_archives a ON a.pm_id = p.pm_id WHERE p.status = 'active' AND a.pm_id IS NULL`;

function parseCatalog(raw: string | null): ProjectCatalog | null {
  if (raw === null) return null;
  try {
    const parsed = projectCatalogSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createLedgerProjectCatalog(
  ctx: LedgerContext,
  projects: LedgerProjects,
  options: ProjectCatalogLedgerOptions,
): LedgerProjectCatalog {
  const { db, now, write } = ctx;
  const onClaimable = options.onCatalogClaimable ?? (() => {});
  const queue = new Set<ProjectId>();
  const running = new Set<ProjectId>();

  const activeProject = (projectId: ProjectId): ProjectDbRow | undefined => db.get<ProjectDbRow>(`${ACTIVE_PROJECT} AND p.id = ?`, projectId);
  const rowOf = (projectId: ProjectId): CatalogDbRow | undefined => db.get<CatalogDbRow>("SELECT * FROM project_catalogs WHERE project_id = ?", projectId);

  const scoreOf = (conversationId: number, cut: MessageId): number => {
    const rows = db.all<{ sender: string; n: number }>(
      `SELECT sender, sum(length(text)) AS n FROM messages
        WHERE conversation_id = ? AND id > ? AND kind = 'text' AND sender IN ('user', 'agent')
        GROUP BY sender`,
      conversationId,
      cut,
    );
    const count = (sender: string) => rows.find((r) => r.sender === sender)?.n ?? 0;
    return changeScore({ userChars: count("user"), agentChars: count("agent") });
  };

  const stateOf = (project: ProjectDbRow, row: CatalogDbRow | undefined, needScore: boolean): CatalogDueState => {
    const neverWritten = row?.refreshed_at == null;
    const forced = row?.forced === 1;
    return {
      neverWritten,
      refreshedAt: row?.refreshed_at ?? null,
      forced,
      nextAttemptAt: row?.next_attempt_at ?? null,
      score: needScore && !neverWritten && !forced ? scoreOf(project.conversation_id, row?.cut_message_id ?? 0) : 0,
    };
  };

  const wanted = (state: CatalogDueState) => state.neverWritten || state.forced || state.score >= PROJECT_CATALOG_REFRESH_DELTA;

  const enqueueAfterCommit = (p: Pending, projectId: ProjectId) => {
    p.after.push(() => {
      queue.add(projectId);
      onClaimable();
    });
  };

  const scanAtStartup = (nowMs: number): number => {
    let queued = 0;
    for (const project of db.all<ProjectDbRow>(`${ACTIVE_PROJECT} ORDER BY p.id`)) {
      const state = stateOf(project, rowOf(project.id), true);
      if (!wanted(state)) continue;
      queue.add(project.id);
      if (catalogDue(state, nowMs)) queued++;
    }
    if (queue.size > 0) onClaimable();
    return queued;
  };

  const afterDriverEvent = (p: Pending, session: AgentSessionRow, event: DriverEvent): void => {
    if (session.role !== "pm" || event.type !== "turn.ended" || session.conversationId === null) return;
    const project = db.get<ProjectDbRow>(`${ACTIVE_PROJECT} AND p.conversation_id = ?`, session.conversationId);
    if (project === undefined || queue.has(project.id)) return;
    if (catalogDue(stateOf(project, rowOf(project.id), true), now())) enqueueAfterCommit(p, project.id);
  };

  const markForcedIn = (p: Pending, projectId: ProjectId, _reason: CatalogForceReason): void => {
    if (activeProject(projectId) === undefined) return;
    db.run(
      `INSERT INTO project_catalogs (project_id, forced, updated_at) VALUES (?, 1, ?)
       ON CONFLICT (project_id) DO UPDATE SET forced = 1, updated_at = excluded.updated_at`,
      projectId,
      now(),
    );
    enqueueAfterCommit(p, projectId);
  };

  const dialogOf = (conversationId: number, cut: MessageId, upTo: MessageId): { dialog: string; truncated: boolean } => {
    const picked: string[] = [];
    let used = 0;
    let truncated = false;
    let before = upTo + 1;
    outer: for (;;) {
      const rows = db.all<{ id: number; sender: string; text: string }>(
        `SELECT id, sender, text FROM messages
          WHERE conversation_id = ? AND id > ? AND id < ? AND kind = 'text' AND sender IN ('user', 'agent')
          ORDER BY id DESC LIMIT 200`,
        conversationId,
        cut,
        before,
      );
      for (const row of rows) {
        const who = row.sender === "user" ? "用户" : "项目经理";
        const left = PROJECT_CATALOG_DIALOG_MAX_CHARS - used;
        if (row.text.length > left) {
          if (left > 0) picked.push(`${who}：（前面略）${row.text.slice(row.text.length - left)}`);
          truncated = true;
          break outer;
        }
        picked.push(`${who}：${row.text}`);
        used += row.text.length;
      }
      if (rows.length < 200) break;
      before = rows.at(-1)!.id;
    }
    return { dialog: picked.reverse().join("\n\n"), truncated };
  };

  const inputOf = (project: ProjectDbRow, row: CatalogDbRow | undefined, cutMessageId: MessageId): CatalogRefreshInput => {
    const cut = row?.cut_message_id ?? 0;
    const since = row?.refreshed_at ?? 0;
    const card = projects.projectCard(project);
    const handover = db.get<{ text: string }>(
      `SELECT text FROM handovers
        WHERE conversation_id = ? AND status = 'switched' AND text IS NOT NULL AND cut_message_id > ?
        ORDER BY id DESC LIMIT 1`,
      project.conversation_id,
      cut,
    );
    const { dialog, truncated } = dialogOf(project.conversation_id, cut, cutMessageId);
    const item = (s: string) => truncateChars(s.replace(/\s+/g, " ").trim(), PROJECT_CATALOG_INPUT_ITEM_MAX_CHARS);
    const graphs = db
      .all<{ title: string; goal: string | null }>(
        `SELECT title, goal FROM task_graphs
          WHERE project_id = ? AND status != 'active' AND COALESCE(completed_at, updated_at) > ?
          ORDER BY id DESC LIMIT ?`,
        project.id,
        since,
        PROJECT_CATALOG_GRAPHS_MAX,
      )
      .map((g) => ({ title: item(g.title), goal: g.goal === null || g.goal.trim() === "" ? null : item(g.goal) }));
    const workerReports = db
      .all<{ worker_id: number | null; summary: string | null }>(
        `SELECT worker_id, CASE WHEN json_valid(meta) THEN json_extract(meta, '$.summary') END AS summary FROM messages
          WHERE conversation_id = ? AND id > ? AND id <= ? AND kind = 'worker'
          ORDER BY id DESC LIMIT ?`,
        project.conversation_id,
        cut,
        cutMessageId,
        PROJECT_CATALOG_WORKER_REPORTS_MAX,
      )
      .flatMap((r) => (r.summary === null || r.summary.trim() === "" ? [] : [item(`Worker #${r.worker_id ?? "?"}：${r.summary}`)]));
    return {
      project: { id: project.id, name: card.name, description: project.description, mainFolder: card.mainFolder, otherFolders: card.otherFolders },
      previous: parseCatalog(row?.catalog_json ?? null),
      handover: handover === undefined ? null : truncateChars(handover.text, PROJECT_CATALOG_HANDOVER_MAX_CHARS),
      dialog,
      dialogTruncated: truncated,
      graphs,
      workerReports,
      files: [],
    };
  };

  const claimCatalog = (nowMs: number): CatalogJob | null => {
    if (queue.size === 0) return null;
    for (const projectId of queue) {
      if (running.has(projectId)) continue;
      const project = activeProject(projectId);
      if (project === undefined) {
        queue.delete(projectId);
        continue;
      }
      const row = rowOf(projectId);
      const state = stateOf(project, row, true);
      if (!wanted(state)) {
        queue.delete(projectId);
        continue;
      }
      if (!catalogDue(state, nowMs)) continue;
      const max = db.get<{ id: number | null }>("SELECT max(id) AS id FROM messages WHERE conversation_id = ?", project.conversation_id)!.id ?? 0;
      running.add(projectId);
      return { projectId, cutMessageId: max, input: inputOf(project, row, max) };
    }
    return null;
  };

  const settle = (projectId: ProjectId) => {
    running.delete(projectId);
    const project = activeProject(projectId);
    if (project === undefined || !wanted(stateOf(project, rowOf(projectId), true))) queue.delete(projectId);
  };

  const failIn = (job: CatalogJob, failure: CatalogFailure) => {
    const row = rowOf(job.projectId);
    const counted = failure.reason !== "shutdown";
    const attempts = (row?.attempts ?? 0) + (counted ? 1 : 0);
    const delay = attempts >= PROJECT_CATALOG_MAX_ATTEMPTS ? PROJECT_CATALOG_GIVE_UP_MS : PROJECT_CATALOG_RETRY_BACKOFF_MS * 2 ** (attempts - 1);
    const t = now();
    const error = failure.detail === undefined ? failure.reason : `${failure.reason}: ${failure.detail}`;
    db.run(
      `INSERT INTO project_catalogs (project_id, attempts, next_attempt_at, last_error, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_id) DO UPDATE SET attempts = excluded.attempts, next_attempt_at = excluded.next_attempt_at,
         last_error = excluded.last_error, updated_at = excluded.updated_at`,
      job.projectId,
      attempts,
      counted ? t + delay : (row?.next_attempt_at ?? null),
      truncateChars(error, PROJECT_CATALOG_INPUT_ITEM_MAX_CHARS),
      t,
    );
  };

  const catalogWritten = (job: CatalogJob, catalog: ProjectCatalog, usage: TokenUsage | null): void => {
    try {
      write(() => {
        if (activeProject(job.projectId) === undefined) return;
        const json = JSON.stringify(catalog);
        if (Buffer.byteLength(json) > PROJECT_CATALOG_ROW_MAX_BYTES) {
          failIn(job, { reason: "invalid_reply", detail: `档案 ${Buffer.byteLength(json)} 字节，超过 ${PROJECT_CATALOG_ROW_MAX_BYTES}` });
          return;
        }
        const t = now();
        db.run(
          `INSERT INTO project_catalogs (project_id, catalog_json, cut_message_id, refreshed_at, forced, attempts, next_attempt_at, last_error, usage, updated_at)
           VALUES (?, ?, ?, ?, 0, 0, NULL, NULL, ?, ?)
           ON CONFLICT (project_id) DO UPDATE SET catalog_json = excluded.catalog_json, cut_message_id = excluded.cut_message_id,
             refreshed_at = excluded.refreshed_at, forced = 0, attempts = 0, next_attempt_at = NULL, last_error = NULL,
             usage = excluded.usage, updated_at = excluded.updated_at`,
          job.projectId,
          json,
          job.cutMessageId,
          t,
          usage === null ? null : JSON.stringify(usage),
          t,
        );
      });
    } finally {
      settle(job.projectId);
    }
  };

  const catalogFailed = (job: CatalogJob, failure: CatalogFailure): void => {
    try {
      write(() => {
        if (activeProject(job.projectId) !== undefined) failIn(job, failure);
      });
    } finally {
      settle(job.projectId);
    }
  };

  const cardOf = (projectId: ProjectId): ProjectCatalogCard | null => {
    const row = db.get<{ catalog_json: string | null; refreshed_at: number | null }>(
      "SELECT catalog_json, refreshed_at FROM project_catalogs WHERE project_id = ?",
      projectId,
    );
    const catalog = parseCatalog(row?.catalog_json ?? null);
    return catalog === null || row?.refreshed_at == null ? null : catalogCardOf(catalog, row.refreshed_at);
  };

  const detailOf = (projectId: ProjectId): ProjectCatalogDetail | null => {
    const project = activeProject(projectId);
    if (project === undefined) return null;
    const row = rowOf(projectId);
    const catalog = parseCatalog(row?.catalog_json ?? null);
    if (catalog === null || row?.refreshed_at == null) return null;
    return { projectId, projectName: project.name, description: project.description, catalog, refreshedAt: row.refreshed_at };
  };

  return {
    scanAtStartup,
    afterDriverEvent,
    markForcedIn,
    claimCatalog,
    catalogWritten,
    catalogFailed,
    cardOf,
    detailOf,
    hasQueued: () => queue.size > 0,
  };
}
