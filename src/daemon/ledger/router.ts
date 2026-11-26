import { systemWakeupKey } from "./system-wakeups.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ArchiveAllReportsResponse,
  ResolveRouterItemRequest,
  ResolveRouterItemResponse,
  RetryRouterCommandRequest,
  RouterCommandsPage,
  RouterItemsKind,
  RouterItemsPage,
  UpdateRouterSettingsRequest,
} from "../../shared/api.ts";
import { deliverablesOf, type Deliverable } from "../../shared/deliverables.ts";
import { askOf, extractAskCard } from "../../shared/domain.ts";
import type {
  AgentSessionRow,
  ConversationId,
  Message,
  MessageId,
  PmId,
  PmMode,
  ProjectId,
  RouterCommandId,
  RouterItemId,
  SessionId,
  WorkerId,
} from "../../shared/domain.ts";
import { getAgentSession } from "../store/index.ts";
import type { HubArgs, HubResult } from "../../shared/hub.ts";
import {
  MAX_DECISION_NOTE_CHARS,
  ROUTER_ACTIVE_ITEMS_SNAPSHOT_MAX,
  ROUTER_AUDIT_LOG_MAX_ROWS,
  ROUTER_STREAM_PAGE_SIZE,
  ROUTER_BRIEFINGS_SNAPSHOT_MAX_BYTES,
  ROUTER_COMMANDS_SNAPSHOT_MAX_BYTES,
  ROUTER_CONTEXT_MAX_CHARS,
  ROUTER_PENDING_DECISIONS_PER_PM_MAX,
  ROUTER_PM_ACTIVE_WORKERS_MAX,
  ROUTER_PM_BRIEF_MAX_CHARS,
  ROUTER_QUESTION_MAX_CHARS,
  ROUTER_RECENT_COMMANDS_SNAPSHOT_MAX,
  ROUTER_REPORT_LINKS_MAX,
  ROUTER_REPORT_LINK_LABEL_MAX_CHARS,
  ROUTER_REPORT_LINK_TARGET_MAX_CHARS,
  ROUTER_STREAM_BRIEFINGS_SNAPSHOT_MAX,
  ROUTER_STREAM_PAGE_MAX_BYTES,
  ROUTER_WORKER_LIST_MAX,
} from "../../shared/limits.ts";
import { defaultRouterSettings } from "../../shared/router.ts";
import { purgeRouterExpiredIn } from "./db-table-retention.ts";
import {
  claimRouterCommandRetryRow,
  mergeRouterPlanPreservingRetries,
  parseStoredRouterPlan,
  serializeNewRouterPlan,
  toPublicRouterPlan,
  type RouterCommandDbRow,
} from "./router-command-retries.ts";
import { fitRouterDigest } from "./router-digest-fit.ts";
import { parseLocalHref } from "../../shared/sent-files.ts";
import type { ProjectCatalogCard } from "../../shared/project-catalog.ts";
import type {
  DeviceRouterDigest,
  PmDigestActiveWorker,
  PmDigestEntry,
  RouterAgentPlan,
  RouterCommandDispatchedTarget,
  RouterCommandRecord,
  RouterCommandStatus,
  RouterDecisionStatus,
  RouterItem,
  RouterReportLink,
  RouterReportStatus,
  RouterResolution,
  RouterSettings,
  RouterSlice,
} from "../../shared/router.ts";
import { AGENT_VENDORS, DEFAULT_AGENT_VENDOR, checkEffort, checkModel, isAgentVendor, normalizeEffortInput } from "../../shared/vendors.ts";
import type { AgentVendor } from "../../shared/vendors.ts";
import type { Db } from "../store/index.ts";
import { fail } from "./context.ts";
import type { LedgerContext, Pending } from "./context.ts";
import type { LedgerMessages } from "./messages.ts";
import type { LedgerPersona } from "./persona.ts";
import type { LedgerProjects } from "./projects.ts";
import type { PmDbRow } from "./rows.ts";
import type { LedgerSessions } from "./sessions.ts";
import { pendingStepAskCounts } from "./task-graphs/store.ts";

interface RouterItemDbRow {
  id: number;
  pm_id: number;
  project_id: number | null;
  conversation_id: number;
  session_id: number | null;
  kind: "decision" | "report";
  status: string;
  question: string | null;
  context: string | null;
  options_json: string | null;
  summary: string | null;
  deliverables_json?: string | null;
  links_json: string | null;
  resolution_json: string | null;
  ask_message_id: number | null;
  created_at: number;
  updated_at: number;
}

interface RouterSettingsDbRow {
  id: number;
  vendor: string | null;
  model: string | null;
  effort: string | null;
  updated_at: number;
}

const charLen = (s: string): number => [...s].length;
const sliceChars = (s: string, max: number): string => {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
};

const PAGE_ENVELOPE_BYTES = 128;

/** Always keep at least one row; each row's fields have their own caps. */
function takeWithinBytes<T>(items: readonly T[], maxBytes: number): T[] {
  let used = 2;
  for (let i = 0; i < items.length; i++) {
    const bytes = Buffer.byteLength(JSON.stringify(items[i])) + (i > 0 ? 1 : 0);
    if (i > 0 && used + bytes > maxBytes) return items.slice(0, i);
    used += bytes;
  }
  return items.slice();
}

function sliceWindow<R, T>(
  rows: readonly R[],
  take: number,
  maxBytes: number,
  map: (row: R) => T,
): { kept: T[]; hasMore: boolean } {
  const page = rows.slice(0, take).map(map);
  const kept = takeWithinBytes(page, maxBytes);
  return { kept, hasMore: rows.length > take || kept.length < page.length };
}

function pageOf<R, T extends { createdAt: number; id: number }>(
  rows: readonly R[],
  take: number,
  map: (row: R) => T,
): { kept: T[]; nextCursor: string | null; hasMore: boolean } {
  const { kept, hasMore } = sliceWindow(rows, take, ROUTER_STREAM_PAGE_MAX_BYTES - PAGE_ENVELOPE_BYTES, map);
  const last = kept[kept.length - 1];
  return { kept, nextCursor: hasMore && last !== undefined ? `${last.createdAt}:${last.id}` : null, hasMore };
}

const routerReportSchema = z.object({
  summary: z.string(),
  links: z
    .array(
      z.object({
        label: z.string(),
        target: z.string(),
      }),
    )
    .optional(),
});

const ITEM_SELECT = `SELECT router_items.*, router_item_deliverables.deliverables_json FROM router_items
  LEFT JOIN router_item_deliverables ON router_item_deliverables.item_id = router_items.id`;

function routerItemRow(db: Db, id: RouterItemId): RouterItemDbRow | undefined {
  return db.get<RouterItemDbRow>(`${ITEM_SELECT} WHERE router_items.id = ?`, id);
}

export function readRouterItem(db: Db, id: RouterItemId): RouterItem | null {
  const row = routerItemRow(db, id);
  return row === undefined ? null : toRouterItem(row);
}

function deliverablesField(row: RouterItemDbRow): { deliverables?: Deliverable[] } {
  const list = deliverablesOf(parseJsonOr<unknown>(row.deliverables_json ?? null, null));
  return list.length > 0 ? { deliverables: list } : {};
}

function parseJsonOr<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toRouterItem(row: RouterItemDbRow): RouterItem {
  if (row.kind === "decision") {
    return {
      id: row.id,
      kind: "decision",
      status: row.status as RouterDecisionStatus,
      pmId: row.pm_id,
      projectId: row.project_id,
      conversationId: row.conversation_id,
      question: row.question ?? "",
      context: row.context ?? "",
      options: parseJsonOr<string[]>(row.options_json, []),
      askMessageId: row.ask_message_id,
      resolution: parseJsonOr<RouterResolution | null>(row.resolution_json, null),
      ...deliverablesField(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  return {
    id: row.id,
    kind: "report",
    status: row.status as RouterReportStatus,
    pmId: row.pm_id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    summary: row.summary ?? "",
    links: parseJsonOr<RouterReportLink[]>(row.links_json, []),
    ...deliverablesField(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRouterCommand(row: RouterCommandDbRow): RouterCommandRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    inputText: row.input_text,
    vendor: row.vendor as AgentVendor,
    model: row.model,
    effort: row.effort,
    status: row.status as RouterCommandStatus,
    plan: toPublicRouterPlan(parseStoredRouterPlan(row.plan_json)),
    dispatched: parseJsonOr<RouterCommandDispatchedTarget[] | null>(row.dispatched_json, null),
    error: row.error,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type LedgerRouter = ReturnType<typeof createLedgerRouter>;

export function createLedgerRouter(
  ctx: LedgerContext,
  sessions: LedgerSessions,
  messages: LedgerMessages,
  persona: LedgerPersona,
  projects: LedgerProjects,
  catalogCardOf: (projectId: ProjectId) => ProjectCatalogCard | null,
) {
  const { db, now, write } = ctx;
  const { assertPmNotArchived, privateConversation } = persona;
  const { activeProjectOf, projectCard } = projects;

  let digestCache: { generation: number; digest: DeviceRouterDigest } | null = null;

  const appendAuditIn = (
    actor: "pm" | "user" | "router_agent" | "system",
    action: string,
    pmId: PmId | null,
    refId: number | null,
    detail?: Record<string, unknown>,
  ) => {
    db.run(
      `INSERT INTO router_audit_log (actor, action, pm_id, ref_id, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      actor,
      action,
      pmId,
      refId,
      detail === undefined ? null : JSON.stringify(detail),
      now(),
    );
    db.run(
      `DELETE FROM router_audit_log
        WHERE id <= COALESCE(
          (SELECT id FROM router_audit_log ORDER BY id DESC LIMIT 1 OFFSET ?),
          0
        )`,
      ROUTER_AUDIT_LOG_MAX_ROWS,
    );
  };

  const getItemRow = (id: RouterItemId) => routerItemRow(db, id);

  const withDeliverablesIn = (itemId: RouterItemId, list: readonly Deliverable[]): RouterItem => {
    if (list.length > 0) {
      db.run(
        "INSERT OR REPLACE INTO router_item_deliverables (item_id, deliverables_json) VALUES (?, ?)",
        itemId,
        JSON.stringify(list),
      );
    }
    return toRouterItem(getItemRow(itemId)!);
  };

  const pendingDecisionCountOf = (pmId: PmId): number =>
    db.get<{ n: number }>(
      "SELECT count(*) AS n FROM router_items WHERE pm_id = ? AND kind = 'decision' AND status = 'pending'",
      pmId,
    )!.n;

  const resolveWakeupRef = (itemId: RouterItemId, clientId: string): string =>
    `router-resolve:${itemId}:${clientId}`;

  const prepareIndependentAskIn = (
    p: Pending,
    pmId: PmId,
    replaceItemId?: RouterItemId,
  ): void => {
    if (replaceItemId !== undefined) {
      const target = getItemRow(replaceItemId);
      if (target === undefined || target.pm_id !== pmId || target.kind !== "decision") {
        throw fail("not_found", `没有可替换的拍板卡 #${replaceItemId}`);
      }
      if (target.status === "pending") {
        const t = now();
        db.run(
          "UPDATE router_items SET status = 'superseded', updated_at = ? WHERE id = ?",
          t,
          target.id,
        );
        if (target.ask_message_id !== null) {
          messages.settleAskIn(p, target.ask_message_id, { by: "close" });
        }
        p.changes.push({ type: "router.item.updated", data: { item: toRouterItem(getItemRow(target.id)!) } });
      }
    }
    const currentPending = pendingDecisionCountOf(pmId);
    if (currentPending >= ROUTER_PENDING_DECISIONS_PER_PM_MAX) {
      throw fail(
        "conflict",
        `你当前已有 ${ROUTER_PENDING_DECISIONS_PER_PM_MAX} 张未决拍板卡，请等用户拍板，或用 --replace <旧卡编号> 替换旧卡`,
      );
    }
  };

  const bridgeAskIn = (
    p: Pending,
    session: AgentSessionRow,
    message: Message,
    askOptions?: string[],
    extra?: { replaceItemId?: RouterItemId },
  ): RouterItem | null => {
    if (session.role !== "pm" || session.pmId === null || session.conversationId === null) return null;
    if (pendingDecisionCountOf(session.pmId) >= ROUTER_PENDING_DECISIONS_PER_PM_MAX) return null;
    const raw = message.text.trim();
    if (raw === "") return null;
    const effectiveOptions = askOptions ?? extractAskCard(message)?.options;
    const splitMatch = /^([^\r\n]+?)(?:\r?\n\s*\r?\n|\r?\n)([\s\S]+)$/u.exec(raw);
    let question: string;
    let context: string;
    if (splitMatch !== null) {
      const firstLine = splitMatch[1]!.trim();
      question =
        charLen(firstLine) <= ROUTER_QUESTION_MAX_CHARS ? firstLine : sliceChars(firstLine, ROUTER_QUESTION_MAX_CHARS);
      context = sliceChars(splitMatch[2]!.trim(), ROUTER_CONTEXT_MAX_CHARS);
    } else {
      const rawChars = [...raw];
      question = rawChars.length <= ROUTER_QUESTION_MAX_CHARS ? raw : sliceChars(raw, ROUTER_QUESTION_MAX_CHARS);
      context =
        rawChars.length <= ROUTER_QUESTION_MAX_CHARS
          ? ""
          : sliceChars(rawChars.slice(ROUTER_QUESTION_MAX_CHARS - 1).join("").trim(), ROUTER_CONTEXT_MAX_CHARS);
    }
    const project = activeProjectOf(session.pmId);
    const t = now();
    const row = db.get<RouterItemDbRow>(
      `INSERT INTO router_items (
         pm_id, project_id, conversation_id, session_id, kind, status,
         question, context, options_json, ask_message_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'decision', 'pending', ?, ?, ?, ?, ?, ?) RETURNING *`,
      session.pmId,
      project?.id ?? null,
      session.conversationId,
      session.id,
      question,
      context,
      JSON.stringify(effectiveOptions ?? []),
      message.id,
      t,
      t,
    )!;
    const item = withDeliverablesIn(row.id, askOf(message)?.deliverables ?? []);
    p.changes.push({ type: "router.item.created", data: { item } });
    appendAuditIn("pm", "ask", session.pmId, row.id, {
      question,
      replaceItemId: extra?.replaceItemId ?? null,
    });
    return item;
  };

  const answerAsk = (askMessageId: MessageId, input: ResolveRouterItemRequest, onDecisionWritten?: () => void): ResolveRouterItemResponse => {
    const row = db.get<{ id: number }>(
      "SELECT id FROM router_items WHERE ask_message_id = ? AND kind = 'decision' ORDER BY id DESC LIMIT 1",
      askMessageId,
    );
    if (row === undefined) throw fail("not_found", "这张卡不在了");
    return resolveItem(row.id, input, onDecisionWritten);
  };

  const closeAskIn = (p: Pending, caller: AgentSessionRow & { pmId: PmId }, args: Extract<HubArgs<"ask.close">, { itemId: RouterItemId }>): HubResult<"ask.close"> => {
    const row = getItemRow(args.itemId);
    if (row === undefined || row.kind !== "decision") throw fail("not_found", `没有编号 ${args.itemId} 的卡`);
    if (row.pm_id !== caller.pmId) throw fail("forbidden", `卡 #${row.id} 不是你的卡`);
    if (row.status !== "pending") throw fail("conflict", `卡 #${row.id} 已经不在等了（${row.status === "resolved" ? "用户已回答" : "已关掉或被替换"}）`);
    db.run("UPDATE router_items SET status = 'superseded', updated_at = ? WHERE id = ?", now(), row.id);
    if (row.ask_message_id !== null) messages.settleAskIn(p, row.ask_message_id, { by: "close" });
    const item = toRouterItem(getItemRow(row.id)!);
    p.changes.push({ type: "router.item.updated", data: { item } });
    appendAuditIn("pm", "ask.close", caller.pmId, row.id);
    return { text: `已关掉卡 #${row.id}。`, data: { item } };
  };

  const reportIn = (
    p: Pending,
    caller: AgentSessionRow & { pmId: PmId },
    rawArgs: Omit<HubArgs<"router.report">, "files">,
    deliverables: readonly Deliverable[] = [],
  ): HubResult<"router.report"> => {
    assertPmNotArchived(caller.pmId);
    const parsed = routerReportSchema.safeParse(rawArgs);
    if (!parsed.success) throw fail("invalid", "hub router report 参数格式不正确");

    const summary = parsed.data.summary.trim();
    if (summary === "") throw fail("invalid", "汇报摘要不能是空的");
    if (charLen(summary) > ROUTER_CONTEXT_MAX_CHARS) {
      throw fail("invalid", `汇报摘要最多 ${ROUTER_CONTEXT_MAX_CHARS} 字（当前 ${charLen(summary)} 字）`);
    }

    const rawLinks = parsed.data.links ?? [];
    if (rawLinks.length > ROUTER_REPORT_LINKS_MAX) {
      throw fail("invalid", `汇报最多附带 ${ROUTER_REPORT_LINKS_MAX} 个链接`);
    }
    const links: RouterReportLink[] = rawLinks.map((lnk) => {
      const label = lnk.label.trim();
      const target = lnk.target.trim();
      if (label === "" || target === "") throw fail("invalid", "链接的标题和地址都不能是空的");
      if (charLen(label) > ROUTER_REPORT_LINK_LABEL_MAX_CHARS) {
        throw fail("invalid", `链接标题最多 ${ROUTER_REPORT_LINK_LABEL_MAX_CHARS} 字`);
      }
      if (charLen(target) > ROUTER_REPORT_LINK_TARGET_MAX_CHARS) {
        throw fail("invalid", `链接地址最多 ${ROUTER_REPORT_LINK_TARGET_MAX_CHARS} 字`);
      }
      if (parseLocalHref(target) !== null) {
        throw fail("invalid", `--link ${label}=${target} 是本机文件，总助里点不开：改用 --file ${label}=${target}`);
      }
      return { label, target };
    });

    const conversationId = caller.conversationId ?? privateConversation(caller.pmId)?.id ?? null;
    if (conversationId === null) throw fail("invalid", "项目经理缺少绑定对话");
    const project = activeProjectOf(caller.pmId);
    const t = now();

    const row = db.get<RouterItemDbRow>(
      `INSERT INTO router_items (
         pm_id, project_id, conversation_id, session_id, kind, status,
         summary, links_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'report', 'unread', ?, ?, ?, ?) RETURNING *`,
      caller.pmId,
      project?.id ?? null,
      conversationId,
      caller.id,
      summary,
      JSON.stringify(links),
      t,
      t,
    )!;
    const item = withDeliverablesIn(row.id, deliverables);
    p.changes.push({ type: "router.item.created", data: { item } });
    appendAuditIn("pm", "router.report", caller.pmId, row.id);

    return {
      text: `已向总助投递里程碑汇报 #${row.id}。`,
      data: { item },
    };
  };

  const resolveItem = (itemId: RouterItemId, input: ResolveRouterItemRequest, onDecisionWritten?: () => void): ResolveRouterItemResponse =>
    write((p) => {
      const row = getItemRow(itemId);
      if (row === undefined) throw fail("not_found", `没有编号 ${itemId} 的总助事项`);

      if ("action" in input) {
        if (input.action !== "archive") throw fail("invalid", "不支持的操作");
        if (row.kind !== "report") throw fail("invalid", "只有里程碑汇报可以归档");
        if (row.status === "archived") return { item: toRouterItem(row) };
        const t = now();
        db.run("UPDATE router_items SET status = 'archived', updated_at = ? WHERE id = ?", t, row.id);
        const updated = toRouterItem(getItemRow(row.id)!);
        p.changes.push({ type: "router.item.updated", data: { item: updated } });
        appendAuditIn("user", "router.report.archive", row.pm_id, row.id);
        return { item: updated };
      }

      if (row.kind !== "decision") throw fail("invalid", "只有待决拍板卡可以拍板");
      const clientId = input.clientId.trim();
      if (clientId === "") throw fail("invalid", "缺少 clientId");

      if (row.status === "resolved") {
        const existingRes = parseJsonOr<RouterResolution | null>(row.resolution_json, null);
        if (existingRes?.clientId === clientId) {
          const dedupeKey = systemWakeupKey(row.conversation_id, "router", resolveWakeupRef(row.id, clientId));
          const existingMsg = db.get<{ id: number }>("SELECT id FROM messages WHERE dedupe_key = ?", dedupeKey);
          return {
            item: toRouterItem(row),
            ...(existingMsg !== undefined ? { messageId: existingMsg.id } : {}),
          };
        }
        throw fail("conflict", "这张拍板卡已经被处理过了");
      }
      if (row.status === "superseded") {
        throw fail("conflict", "这张卡已被项目经理关掉或替换");
      }

      assertPmNotArchived(row.pm_id);
      const options = parseJsonOr<string[]>(row.options_json, []);
      let chosenIndex: number | null = null;
      let chosenOption: string | null = null;
      if (input.optionIndex !== null && input.optionIndex !== undefined) {
        if (!Number.isInteger(input.optionIndex) || input.optionIndex < 0 || input.optionIndex >= options.length) {
          throw fail("invalid", "选中的选项序号不在有效范围内");
        }
        chosenIndex = input.optionIndex;
        chosenOption = options[chosenIndex]!;
      } else if (typeof input.choice === "string" && input.choice.trim() !== "") {
        const trimmedChoice = input.choice.trim();
        const idx = options.findIndex((o) => o === trimmedChoice);
        if (idx < 0) {
          throw fail("invalid", "选中的选项不在候选列表中");
        }
        chosenIndex = idx;
        chosenOption = options[idx]!;
      }

      const note = (input.note ?? "").trim();
      if (charLen(note) > MAX_DECISION_NOTE_CHARS) {
        throw fail("invalid", `补充说明最多 ${MAX_DECISION_NOTE_CHARS} 字`);
      }
      if (chosenOption === null && note === "") {
        throw fail("invalid", "请至少选择一个选项或填写补充说明");
      }

      const t = now();
      const resolution: RouterResolution = {
        chosenIndex,
        chosenOption,
        note,
        actor: "router",
        resolvedAt: t,
        clientId,
      };
      db.run(
        "UPDATE router_items SET status = 'resolved', resolution_json = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(resolution),
        t,
        row.id,
      );

      if (row.ask_message_id !== null) {
        messages.settleAskIn(p, row.ask_message_id, { by: "answer", ...(chosenOption !== null ? { chosenOption } : {}), note });
      }

      const wakeLines = [`【Router 拍板】关于「${row.question ?? ""}」`];
      if (chosenOption !== null) wakeLines.push(`定案：${chosenOption}`);
      if (note !== "") wakeLines.push(`补充说明：${note}`);
      const wakeMsg = messages.enqueueWakeupIn(p, {
        conversationId: row.conversation_id,
        source: "router",
        ref: resolveWakeupRef(row.id, clientId),
        text: wakeLines.join("\n"),
      });

      const updated = toRouterItem(getItemRow(row.id)!);
      p.changes.push({ type: "router.item.updated", data: { item: updated } });
      appendAuditIn("user", "router.decision.resolve", row.pm_id, row.id, { chosenIndex, clientId });
      onDecisionWritten?.();
      return { item: updated, messageId: wakeMsg.id };
    });

  const archiveAllReports = (): ArchiveAllReportsResponse =>
    write((p) => {
      const ids = db
        .all<{ id: number }>("SELECT id FROM router_items WHERE kind = 'report' AND status = 'unread' ORDER BY id")
        .map((r) => r.id);
      const t = now();
      if (ids.length > 0) {
        db.run("UPDATE router_items SET status = 'archived', updated_at = ? WHERE kind = 'report' AND status = 'unread'", t);
        p.changes.push({ type: "router.reports.archived_all", data: { archivedIds: ids, updatedAt: t } });
        appendAuditIn("user", "router.reports.archive_all", null, null, { count: ids.length });
      }
      return { archivedIds: ids, updatedAt: t };
    });

  const updateSettings = (input: UpdateRouterSettingsRequest): RouterSettings =>
    write((p) => {
      let vendor: AgentVendor | null = null;
      if (input.vendor !== null && input.vendor !== undefined) {
        if (!isAgentVendor(input.vendor)) {
          throw fail("invalid", `厂商只能是 ${AGENT_VENDORS.join("、")}`);
        }
        vendor = input.vendor;
      }
      const catalog = vendor === null ? null : ctx.modelCatalog(vendor);
      const model = vendor === null ? null : typeof input.model === "string" ? input.model.trim() || null : null;
      const effort =
        vendor === null ? null : normalizeEffortInput(vendor, typeof input.effort === "string" ? input.effort.trim() || null : null, catalog);
      if (vendor !== null) {
        const bad = checkModel(vendor, model) ?? checkEffort(vendor, effort, catalog);
        if (bad !== null) throw fail("invalid", bad);
      }
      const t = now();
      db.run(
        `INSERT INTO router_settings (id, vendor, model, effort, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           vendor = excluded.vendor,
           model = excluded.model,
           effort = excluded.effort,
           updated_at = excluded.updated_at`,
        vendor,
        model,
        effort,
        t,
      );
      const settings: RouterSettings = { vendor, model, effort, updatedAt: t };
      p.changes.push({ type: "router.settings.updated", data: { settings } });
      appendAuditIn("user", "router.settings.update", null, null, { vendor, model, effort });
      return settings;
    });

  const listItems = (beforeCursor?: string, limit?: number, kind?: RouterItemsKind): RouterItemsPage => {
    if (kind !== undefined && kind !== "report") throw fail("invalid", "kind 只能是 report");
    // Fixed SQL fragments only; no external input is concatenated.
    const scope = kind === "report" ? "kind = 'report'" : "status IN ('resolved', 'superseded', 'archived')";
    const take = Math.max(1, Math.min(limit ?? ROUTER_STREAM_PAGE_SIZE, 100));
    let rows: RouterItemDbRow[];
    const trimmed = beforeCursor?.trim() ?? "";
    if (trimmed === "") {
      rows = db.all<RouterItemDbRow>(
        `${ITEM_SELECT}
          WHERE ${scope}
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
        take + 1,
      );
    } else if (/^\d+$/.test(trimmed)) {
      const cursorId = Number(trimmed);
      if (!Number.isSafeInteger(cursorId) || cursorId <= 0) {
        throw fail("invalid", "分页游标格式不正确");
      }
      const pivot = db.get<{ created_at: number }>("SELECT created_at FROM router_items WHERE id = ?", cursorId);
      rows =
        pivot !== undefined
          ? db.all<RouterItemDbRow>(
              `${ITEM_SELECT}
                WHERE ${scope}
                  AND (created_at < ? OR (created_at = ? AND id < ?))
                ORDER BY created_at DESC, id DESC
                LIMIT ?`,
              pivot.created_at,
              pivot.created_at,
              cursorId,
              take + 1,
            )
          : db.all<RouterItemDbRow>(
              `${ITEM_SELECT}
                WHERE ${scope} AND id < ?
                ORDER BY created_at DESC, id DESC
                LIMIT ?`,
              cursorId,
              take + 1,
            );
    } else {
      const match = /^(\d+):(\d+)$/.exec(trimmed);
      if (match === null) throw fail("invalid", "分页游标格式不正确（期望 <createdAt>:<id>）");
      const cursorCreatedAt = Number(match[1]);
      const cursorId = Number(match[2]);
      rows = db.all<RouterItemDbRow>(
        `${ITEM_SELECT}
          WHERE ${scope}
            AND (created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
        cursorCreatedAt,
        cursorCreatedAt,
        cursorId,
        take + 1,
      );
    }
    const { kept, nextCursor, hasMore } = pageOf(rows, take, toRouterItem);
    return { items: kept, nextCursor, hasMore };
  };

  const getSettings = (): RouterSettings => {
    const row = db.get<RouterSettingsDbRow>("SELECT * FROM router_settings WHERE id = 1");
    if (row === undefined) return defaultRouterSettings();
    return {
      vendor: row.vendor !== null && isAgentVendor(row.vendor) ? row.vendor : null,
      model: row.model,
      effort: row.effort,
      updatedAt: row.updated_at,
    };
  };

  const snapshotSlice = (): RouterSlice => {
    const settings = getSettings();
    const pendingRows = db.all<RouterItemDbRow>(
      `${ITEM_SELECT}
        WHERE status IN ('pending', 'unread') AND status = 'pending'
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
      ROUTER_ACTIVE_ITEMS_SNAPSHOT_MAX,
    );
    const briefingRows = db.all<RouterItemDbRow>(
      `${ITEM_SELECT}
        WHERE kind = 'report'
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
      ROUTER_STREAM_BRIEFINGS_SNAPSHOT_MAX + 1,
    );
    const { kept: briefings, hasMore: briefingsHasMore } = sliceWindow(
      briefingRows,
      ROUTER_STREAM_BRIEFINGS_SNAPSHOT_MAX,
      ROUTER_BRIEFINGS_SNAPSHOT_MAX_BYTES,
      toRouterItem,
    );
    const items = [...pendingRows.map(toRouterItem), ...briefings].sort(
      (a, b) => b.createdAt - a.createdAt || b.id - a.id,
    );
    const commandRows = db.all<RouterCommandDbRow>(
      `SELECT * FROM router_commands
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
      ROUTER_RECENT_COMMANDS_SNAPSHOT_MAX + 1,
    );
    const { kept: commands, hasMore: commandsHasMore } = sliceWindow(
      commandRows,
      ROUTER_RECENT_COMMANDS_SNAPSHOT_MAX,
      ROUTER_COMMANDS_SNAPSHOT_MAX_BYTES,
      toRouterCommand,
    );
    return {
      settings,
      items,
      briefingsHasMore,
      commands,
      commandsHasMore,
    };
  };

  const digestActiveWorkers = (
    conversationId: number | null,
    openWorkers: ReadonlyArray<{ id: number; title: string; readonly: number; worker_conversation_id: number }>,
  ): PmDigestActiveWorker[] =>
    openWorkers.slice(0, ROUTER_PM_ACTIVE_WORKERS_MAX).map((w) => {
      const ws = sessions.currentSession(w.worker_conversation_id);
      const wAct = ws === null ? "idle" : sessions.liveOf(ws.id).activity;
      const lastLine =
        conversationId === null
          ? undefined
          : db.get<{ summary: string | null }>(
              `SELECT CASE WHEN json_valid(meta) THEN json_extract(meta, '$.summary') END AS summary
                 FROM messages
                WHERE conversation_id = ? AND kind = 'worker' AND worker_id = ?
                ORDER BY id DESC LIMIT 1`,
              conversationId,
              w.id,
            );
      return {
        id: w.id,
        title: w.title,
        activity: wAct,
        readonly: w.readonly === 1,
        lastSummary: lastLine?.summary ? sliceChars(lastLine.summary, ROUTER_PM_BRIEF_MAX_CHARS) : null,
      };
    });

  const digestEntryOf = (pm: PmDbRow, pendingDecisionCount: number): PmDigestEntry => {
    const projRow = activeProjectOf(pm.id);
    const card = projRow === null ? null : projectCard(projRow);
    const conv = privateConversation(pm.id);
    const pmSess = conv === null ? null : sessions.currentSession(conv.id);
    const activity = pmSess === null ? "idle" : sessions.liveOf(pmSess.id).activity;

    const openWorkers = db.all<{
      id: number;
      title: string;
      readonly: number;
      worker_conversation_id: number;
    }>("SELECT id, title, readonly, worker_conversation_id FROM workers WHERE pm_id = ? AND status = 'open' ORDER BY id DESC", pm.id);
    const activeWorkers = digestActiveWorkers(conv === null ? null : conv.id, openWorkers);

    const latestReport = db.get<{ summary: string; created_at: number }>(
      `SELECT summary, created_at FROM router_items
        WHERE pm_id = ? AND kind = 'report'
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      pm.id,
    );
    const latestMsg =
      conv === null
        ? undefined
        : db.get<{ text: string; created_at: number }>(
            `SELECT text, created_at FROM messages
              WHERE conversation_id = ? AND sender = 'agent' AND kind = 'text'
              ORDER BY id DESC LIMIT 1`,
            conv.id,
          );

    const briefSource = latestReport?.summary ?? latestMsg?.text ?? null;
    const recentBrief =
      briefSource !== null && briefSource.trim() !== "" ? sliceChars(briefSource.replace(/\s+/g, " ").trim(), ROUTER_PM_BRIEF_MAX_CHARS) : null;

    const timestamps = [pmSess?.lastEventAt ?? 0, latestMsg?.created_at ?? 0, latestReport?.created_at ?? 0].filter((x) => x > 0);
    const lastActiveAt = timestamps.length > 0 ? Math.max(...timestamps) : null;

    return {
      pmId: pm.id,
      name: pm.name,
      mode: pm.mode as PmMode,
      vendor: pm.vendor as AgentVendor,
      model: pm.default_model,
      ...(conv !== null ? { conversationId: conv.id } : {}),
      activity,
      project:
        projRow === null || card === null
          ? null
          : {
              id: projRow.id,
              name: card.name,
              description: projRow.description,
              mainFolder: card.mainFolder,
              otherFolders: card.otherFolders,
              catalog: catalogCardOf(projRow.id),
            },
      activeWorkers,
      activeWorkerTotal: openWorkers.length,
      pendingDecisionCount,
      recentBrief,
      lastActiveAt,
    };
  };

  const countByPm = (sql: string): Map<number, number> => new Map(db.all<{ pm_id: number; n: number }>(sql).map((r) => [r.pm_id, r.n]));

  const getDigest = (): DeviceRouterDigest => {
    const gen = ctx.writeGeneration();
    if (digestCache !== null && digestCache.generation === gen) {
      return digestCache.digest;
    }

    const activePms = db.all<PmDbRow>(
      `SELECT p.* FROM pms p
        LEFT JOIN pm_archives a ON a.pm_id = p.id
        WHERE a.pm_id IS NULL
        ORDER BY p.id`,
    );
    const pendingItemsByPm = countByPm("SELECT pm_id, count(*) AS n FROM router_items WHERE kind = 'decision' AND status = 'pending' GROUP BY pm_id");
    const waitingGatesByPm = pendingStepAskCounts(db);

    const entries = activePms.map((pm) => digestEntryOf(pm, (pendingItemsByPm.get(pm.id) ?? 0) + (waitingGatesByPm.get(pm.id) ?? 0)));
    const digest = fitRouterDigest({ generatedAt: now(), pms: entries });
    digestCache = { generation: gen, digest };
    return digest;
  };

  const purgeExpiredBatch = (nowMs: number, maxRows: number): number =>
    maxRows <= 0 ? 0 : write(() => purgeRouterExpiredIn(db, nowMs, maxRows));

  const createCommand = (input: {
    clientId: string;
    inputText: string;
    vendor: AgentVendor;
    model?: string | null;
    effort?: string | null;
    status: RouterCommandStatus;
    plan?: RouterAgentPlan | null;
    dispatched?: RouterCommandDispatchedTarget[] | null;
    error?: string | null;
    durationMs?: number | null;
    auditAction?: string;
    auditActor?: "pm" | "user" | "router_agent" | "system";
    auditDetail?: Record<string, unknown>;
  }): { command: RouterCommandRecord; deduplicated: boolean } =>
    write((p) => {
      const clientId = input.clientId.trim();
      if (clientId === "") throw fail("invalid", "缺少 clientId");
      const existing = db.get<RouterCommandDbRow>("SELECT * FROM router_commands WHERE client_id = ?", clientId);
      if (existing !== undefined) {
        return { command: toRouterCommand(existing), deduplicated: true };
      }
      const t = now();
      const row = db.get<RouterCommandDbRow>(
        `INSERT INTO router_commands (
           client_id, input_text, vendor, model, effort, status,
           plan_json, dispatched_json, error, duration_ms, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        clientId,
        input.inputText,
        input.vendor,
        input.model ?? null,
        input.effort ?? null,
        input.status,
        serializeNewRouterPlan(input.plan),
        input.dispatched == null ? null : JSON.stringify(input.dispatched),
        input.error ?? null,
        input.durationMs ?? null,
        t,
        t,
      )!;
      const command = toRouterCommand(row);
      p.changes.push({ type: "router.command.created", data: { command } });
      if (input.auditAction !== undefined) {
        appendAuditIn(input.auditActor ?? "user", input.auditAction, null, row.id, input.auditDetail);
      }
      return { command, deduplicated: false };
    });

  const updateCommand = (
    id: RouterCommandId,
    patch: {
      vendor?: AgentVendor;
      model?: string | null;
      effort?: string | null;
      status?: RouterCommandStatus;
      plan?: RouterAgentPlan | null;
      dispatched?: RouterCommandDispatchedTarget[] | null;
      error?: string | null;
      durationMs?: number | null;
      auditAction?: string;
      auditActor?: "pm" | "user" | "router_agent" | "system";
      auditDetail?: Record<string, unknown>;
    },
  ): RouterCommandRecord =>
    write((p) => {
      const existing = db.get<RouterCommandDbRow>("SELECT * FROM router_commands WHERE id = ?", id);
      if (existing === undefined) throw fail("not_found", `没有编号 ${id} 的总助指令`);
      const t = now();
      const row = db.get<RouterCommandDbRow>(
        `UPDATE router_commands SET
           vendor = ?,
           model = ?,
           effort = ?,
           status = ?,
           plan_json = ?,
           dispatched_json = ?,
           error = ?,
           duration_ms = ?,
           updated_at = ?
         WHERE id = ? RETURNING *`,
        patch.vendor ?? existing.vendor,
        patch.model !== undefined ? patch.model : existing.model,
        patch.effort !== undefined ? patch.effort : existing.effort,
        patch.status ?? existing.status,
        patch.plan !== undefined ? mergeRouterPlanPreservingRetries(existing.plan_json, patch.plan) : existing.plan_json,
        patch.dispatched !== undefined
          ? patch.dispatched === null
            ? null
            : JSON.stringify(patch.dispatched)
          : existing.dispatched_json,
        patch.error !== undefined ? patch.error : existing.error,
        patch.durationMs !== undefined ? patch.durationMs : existing.duration_ms,
        t,
        id,
      )!;
      const command = toRouterCommand(row);
      p.changes.push({ type: "router.command.updated", data: { command } });
      if (patch.auditAction !== undefined) {
        appendAuditIn(patch.auditActor ?? "router_agent", patch.auditAction, null, row.id, patch.auditDetail);
      }
      return command;
    });

  const claimCommandRetry = (id: RouterCommandId, retry: RetryRouterCommandRequest): RouterCommandRecord =>
    write((p) => {
      const command = toRouterCommand(claimRouterCommandRetryRow(db, now(), id, retry));
      p.changes.push({ type: "router.command.updated", data: { command } });
      return command;
    });

  const getCommand = (id: RouterCommandId): RouterCommandRecord | null => {
    const row = db.get<RouterCommandDbRow>("SELECT * FROM router_commands WHERE id = ?", id);
    return row === undefined ? null : toRouterCommand(row);
  };

  const listCommands = (beforeCursor?: string, limit?: number): RouterCommandsPage => {
    const take = Math.max(1, Math.min(limit ?? ROUTER_STREAM_PAGE_SIZE, 100));
    let rows: RouterCommandDbRow[];
    const trimmed = beforeCursor?.trim() ?? "";
    if (trimmed === "") {
      rows = db.all<RouterCommandDbRow>(
        `SELECT * FROM router_commands
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
        take + 1,
      );
    } else if (/^\d+$/.test(trimmed)) {
      const cursorId = Number(trimmed);
      if (!Number.isSafeInteger(cursorId) || cursorId <= 0) {
        throw fail("invalid", "分页游标格式不正确");
      }
      const pivot = db.get<{ created_at: number }>("SELECT created_at FROM router_commands WHERE id = ?", cursorId);
      rows =
        pivot !== undefined
          ? db.all<RouterCommandDbRow>(
              `SELECT * FROM router_commands
                WHERE created_at < ? OR (created_at = ? AND id < ?)
                ORDER BY created_at DESC, id DESC
                LIMIT ?`,
              pivot.created_at,
              pivot.created_at,
              cursorId,
              take + 1,
            )
          : db.all<RouterCommandDbRow>(
              `SELECT * FROM router_commands
                WHERE id < ?
                ORDER BY created_at DESC, id DESC
                LIMIT ?`,
              cursorId,
              take + 1,
            );
    } else {
      const match = /^(\d+):(\d+)$/.exec(trimmed);
      if (match === null) throw fail("invalid", "分页游标格式不正确（期望 <createdAt>:<id>）");
      const cursorCreatedAt = Number(match[1]);
      const cursorId = Number(match[2]);
      rows = db.all<RouterCommandDbRow>(
        `SELECT * FROM router_commands
          WHERE created_at < ? OR (created_at = ? AND id < ?)
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
        cursorCreatedAt,
        cursorCreatedAt,
        cursorId,
        take + 1,
      );
    }
    const { kept, nextCursor, hasMore } = pageOf(rows, take, toRouterCommand);
    return { commands: kept, nextCursor, hasMore };
  };

  const createAssistantSession = (input: {
    vendor: AgentVendor;
    model: string | null;
    effort: string | null;
    cwd: string;
  }): AgentSessionRow =>
    write(() => {
      const t = now();
      const id = db.run(
        `INSERT INTO agent_sessions (
           role, conversation_id, pm_id, worker_id, vendor, vendor_session_id,
           cwd, add_dirs, generation, model, effort, created_at, updated_at
         ) VALUES ('assistant', NULL, NULL, NULL, ?, ?, ?, '[]', 1, ?, ?, ?, ?)`,
        input.vendor,
        randomUUID(),
        input.cwd,
        input.model,
        input.effort,
        t,
        t,
      ).lastInsertRowid;
      return getAgentSession(db, id)!;
    });

  /** agent_sessions.id has no AUTOINCREMENT, so deleting the max row would let the next insert reuse an id that the driver and token table still mark as ended. */
  const pruneEndedAssistantSessions = (): void => {
    const prunable =
      "SELECT id FROM agent_sessions WHERE role = 'assistant' AND status = 'ended' AND id < (SELECT MAX(id) FROM agent_sessions)";
    db.run(`DELETE FROM session_persona_seen WHERE session_id IN (${prunable})`);
    db.run(`DELETE FROM agent_sessions WHERE id IN (${prunable})`);
  };

  const endAssistantSession = (sessionId: SessionId): void => {
    write(() => {
      db.run(
        "UPDATE agent_sessions SET status = 'ended', updated_at = ? WHERE id = ? AND role = 'assistant'",
        now(),
        sessionId,
      );
      pruneEndedAssistantSessions();
    });
    sessions.forgetSession(sessionId);
  };

  const recordWorkerOrigin = (input: {
    workerId: WorkerId;
    sourceKind: "router_command" | "router_resolve";
    sourceId: number;
    pmMessageId?: MessageId;
  }): MessageId | null =>
    write(() => {
      const msgId =
        input.pmMessageId ??
        db.get<{ id: number }>("SELECT id FROM messages WHERE worker_id = ? ORDER BY id ASC LIMIT 1", input.workerId)?.id ??
        null;
      if (msgId === null) return null;
      db.run(
        `INSERT OR IGNORE INTO router_worker_origins (
           worker_id, source_kind, source_id, pm_message_id, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
        input.workerId,
        input.sourceKind,
        input.sourceId,
        msgId,
        now(),
      );
      return msgId;
    });

  const resolveLocalPmOrProject = (query: { pmId?: PmId; projectId?: ProjectId }): {
    pmId: PmId;
    pmName: string;
    vendor: AgentVendor;
    conversationId: ConversationId;
    sessionId: SessionId;
    projectId: ProjectId | null;
    projectName: string | null;
    mainFolder: string | null;
  } => {
    let pmId: PmId | undefined = query.pmId;
    if (pmId === undefined && query.projectId !== undefined) {
      const proj = db.get<{ id: number; pm_id: number; status: string }>(
        "SELECT id, pm_id, status FROM projects WHERE id = ?",
        query.projectId,
      );
      if (proj === undefined || proj.status !== "active") {
        throw fail("not_found", `没有进行中的项目 #${query.projectId}`);
      }
      pmId = proj.pm_id;
    }
    if (pmId === undefined) throw fail("invalid", "请指定目标项目经理或项目");
    const pm = db.get<PmDbRow>("SELECT * FROM pms WHERE id = ?", pmId);
    if (pm === undefined) throw fail("not_found", `没有编号 ${pmId} 的项目经理`);
    assertPmNotArchived(pm.id);
    const conv = privateConversation(pm.id);
    if (conv === null) throw fail("invalid", `项目经理「${pm.name}」缺少对话`);
    const sess = sessions.currentSession(conv.id);
    if (sess === null) throw fail("invalid", `项目经理「${pm.name}」缺少会话`);
    const projRow = activeProjectOf(pm.id);
    if (query.projectId !== undefined && projRow?.id !== query.projectId) {
      throw fail("not_found", `项目 #${query.projectId} 不属于项目经理「${pm.name}」`);
    }
    const card = projRow === null ? null : projectCard(projRow);
    return {
      pmId: pm.id,
      pmName: pm.name,
      vendor: pm.vendor as AgentVendor,
      conversationId: conv.id,
      sessionId: sess.id,
      projectId: projRow?.id ?? null,
      projectName: card?.name ?? null,
      mainFolder: card?.mainFolder ?? null,
    };
  };

  const resolveLocalWorker = (workerId: WorkerId): {
    workerId: WorkerId;
    pmId: PmId;
    pmSessionId: SessionId;
    projectId: ProjectId;
    workerConversationId: ConversationId;
    title: string;
    status: string;
    readonly: boolean;
  } => {
    const w = db.get<{
      id: number;
      pm_id: number;
      project_id: number;
      worker_conversation_id: number;
      title: string;
      status: string;
      readonly: number;
    }>(
      "SELECT id, pm_id, project_id, worker_conversation_id, title, status, readonly FROM workers WHERE id = ?",
      workerId,
    );
    if (w === undefined) throw fail("not_found", `没有编号 ${workerId} 的 Piece（Worker）`);
    assertPmNotArchived(w.pm_id);
    const conv = privateConversation(w.pm_id);
    const sess = conv === null ? null : sessions.currentSession(conv.id);
    if (sess === null) throw fail("invalid", `Worker #${workerId} 所属项目经理缺少会话`);
    return {
      workerId: w.id,
      pmId: w.pm_id,
      pmSessionId: sess.id,
      projectId: w.project_id,
      workerConversationId: w.worker_conversation_id,
      title: w.title,
      status: w.status,
      readonly: w.readonly === 1,
    };
  };

  const listLocalWorkers = (projectId?: ProjectId) => {
    const rows =
      projectId !== undefined
        ? db.all<{
            id: number;
            project_id: number;
            title: string;
            status: string;
            readonly: number;
            worker_conversation_id: number;
          }>(
            `SELECT id, project_id, title, status, readonly, worker_conversation_id
               FROM workers WHERE project_id = ?
               ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, id DESC LIMIT ?`,
            projectId,
            ROUTER_WORKER_LIST_MAX,
          )
        : db.all<{
            id: number;
            project_id: number;
            title: string;
            status: string;
            readonly: number;
            worker_conversation_id: number;
          }>(
            `SELECT w.id, w.project_id, w.title, w.status, w.readonly, w.worker_conversation_id
               FROM workers w
               LEFT JOIN pm_archives a ON a.pm_id = w.pm_id
              WHERE a.pm_id IS NULL
              ORDER BY CASE WHEN w.status = 'open' THEN 0 ELSE 1 END, w.id DESC LIMIT ?`,
            ROUTER_WORKER_LIST_MAX,
          );
    return rows.map((w) => {
      const ws = sessions.currentSession(w.worker_conversation_id);
      return {
        id: w.id,
        projectId: w.project_id,
        title: w.title,
        status: w.status,
        activity: ws === null ? "idle" : sessions.liveOf(ws.id).activity,
        readonly: w.readonly === 1,
        vendor: ws?.vendor ?? DEFAULT_AGENT_VENDOR,
        model: ws?.model ?? null,
      };
    });
  };

  /** Same pruning rule as above: never delete the max row so ids never go backwards. */
  const recoverAfterRestart = (): void => {
    write((p) => {
      db.run(
        "UPDATE agent_sessions SET status = 'ended', updated_at = ? WHERE role = 'assistant' AND status != 'ended'",
        now(),
      );
      pruneEndedAssistantSessions();
      const stuck = db.all<RouterCommandDbRow>("SELECT * FROM router_commands WHERE status = 'planning'");
      if (stuck.length > 0) {
        const t = now();
        db.run(
          "UPDATE router_commands SET status = 'failed', error = ?, updated_at = ? WHERE status = 'planning'",
          "守护进程重启，规划中断，可点击重试",
          t,
        );
        for (const old of stuck) {
          const updated = db.get<RouterCommandDbRow>("SELECT * FROM router_commands WHERE id = ?", old.id);
          if (updated !== undefined) {
            p.changes.push({ type: "router.command.updated", data: { command: toRouterCommand(updated) } });
          }
        }
      }
    });
  };

  return {
    prepareIndependentAskIn,
    bridgeAskIn,
    answerAsk,
    closeAskIn,
    reportIn,
    resolveItem,
    getItem: (id: RouterItemId) => readRouterItem(db, id),
    archiveAllReports,
    updateSettings,
    getSettings,
    listItems,
    createCommand,
    updateCommand,
    claimCommandRetry,
    getCommand,
    listCommands,
    createAssistantSession,
    endAssistantSession,
    recordWorkerOrigin,
    resolveLocalPmOrProject,
    resolveLocalWorker,
    listLocalWorkers,
    recoverAfterRestart,
    snapshotSlice,
    getDigest,
    purgeExpiredBatch,
  };
}
