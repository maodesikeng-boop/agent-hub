import type { RetryRouterCommandRequest } from "../../shared/api.ts";
import type { RouterCommandId } from "../../shared/domain.ts";
import { ROUTER_COMMAND_MAX_RETRIES, ROUTER_COMMAND_RETRY_ID_MAX_CHARS } from "../../shared/limits.ts";
import type { RouterAgentPlan, RouterCommandDispatchedTarget } from "../../shared/router.ts";
import type { Db } from "../store/index.ts";
import { fail } from "./context.ts";

export interface RouterCommandDbRow {
  id: number;
  client_id: string;
  input_text: string;
  vendor: string;
  model: string | null;
  effort: string | null;
  status: string;
  plan_json: string | null;
  dispatched_json: string | null;
  error: string | null;
  duration_ms: number | null;
  created_at: number;
  updated_at: number;
}

export type RouterDelivery = {
  id: string;
  deviceId: string;
  op: unknown;
  verbatim?: boolean;
  receipt?: RouterCommandDispatchedTarget;
};

type StoredRouterAgentPlan = RouterAgentPlan & {
  usedRetryIds?: string[];
  deliveries?: RouterDelivery[];
};

export const emptyRouterPlan: RouterAgentPlan = { intent: "dispatch", reply: "", actions: [] };

function parseJsonObject<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

export function parseDispatched(raw: string | null): RouterCommandDispatchedTarget[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RouterCommandDispatchedTarget[]) : null;
  } catch {
    return null;
  }
}

export function parseStoredRouterPlan(raw: string | null): StoredRouterAgentPlan | null {
  return parseJsonObject<StoredRouterAgentPlan>(raw);
}

/** Strips internal retry-claim history before returning or broadcasting a Router command. */
export function toPublicRouterPlan(raw: StoredRouterAgentPlan | null): RouterAgentPlan | null {
  if (raw === null) return null;
  const { usedRetryIds: _usedRetryIds, deliveries, ...rest } = raw;
  if (deliveries?.length) rest.retryOps = deliveries.map(({ deviceId, op }) => ({ deviceId, op }));
  return rest;
}

function usedRetryIdsOf(plan: StoredRouterAgentPlan | null): string[] {
  if (plan === null) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string" || value.trim() === "" || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };
  if (Array.isArray(plan.usedRetryIds)) {
    for (const id of plan.usedRetryIds) add(id);
  }
  // Include legacy plan.retryId so rows written before usedRetryIds existed still block reuse after upgrade.
  add(plan.retryId);
  return out;
}

export function serializeNewRouterPlan(plan: RouterAgentPlan | null | undefined): string | null {
  return plan == null ? null : JSON.stringify(plan);
}

/** Preserves every claimed retryId across run updates so later writes never reopen earlier ids. */
export function mergeRouterPlanPreservingRetries(existingJson: string | null, nextPlan: RouterAgentPlan | null): string | null {
  const existing = parseStoredRouterPlan(existingJson);
  const merged = usedRetryIdsOf(existing);
  const deliveries = existing?.deliveries;
  if (nextPlan === null && merged.length === 0 && !deliveries?.length) return null;
  const clean = nextPlan ?? emptyRouterPlan;
  if (typeof clean.retryId === "string" && clean.retryId.trim() !== "" && !merged.includes(clean.retryId)) {
    merged.push(clean.retryId);
  }
  const stored: StoredRouterAgentPlan = {
    ...clean,
    ...(merged.length > 0 ? { usedRetryIds: merged } : {}),
    ...(deliveries?.length ? { deliveries } : {}),
  };
  return JSON.stringify(stored);
}

/**
 * Precondition: called inside an open SQLite write transaction.
 * Postcondition: atomically verifies command status, matching fromRetryId, unused retryId, safe retryability, and ROUTER_COMMAND_MAX_RETRIES, records retryId in plan_json.usedRetryIds, transitions the row to planning, and returns the updated row.
 */
export function claimRouterCommandRetryRow(
  db: Db,
  nowMs: number,
  id: RouterCommandId,
  retry: RetryRouterCommandRequest,
): RouterCommandDbRow {
  if (retry.retryId.trim() === "" || retry.retryId.length > ROUTER_COMMAND_RETRY_ID_MAX_CHARS) {
    throw fail("invalid", "重试编号格式不正确");
  }
  if (
    retry.fromRetryId !== null &&
    (retry.fromRetryId.trim() === "" || retry.fromRetryId.length > ROUTER_COMMAND_RETRY_ID_MAX_CHARS)
  ) {
    throw fail("invalid", "上一轮重试编号格式不正确");
  }

  const existing = db.get<RouterCommandDbRow>("SELECT * FROM router_commands WHERE id = ?", id);
  if (existing === undefined) throw fail("not_found", `没有编号 ${id} 的总助指令`);
  if (existing.status !== "failed") {
    throw fail("conflict", "只有失败状态的总助指令才能重试");
  }

  const storedPlan = parseStoredRouterPlan(existing.plan_json);
  const runRetryId = storedPlan?.retryId ?? null;
  const usedRetryIds = usedRetryIdsOf(storedPlan);
  if (runRetryId !== retry.fromRetryId || usedRetryIds.includes(retry.retryId)) {
    throw fail("conflict", "这一轮已经重试过了，等最新结果出来再重试");
  }

  const { retryOps, ...basePlan } = storedPlan ?? emptyRouterPlan;
  const deliveries = storedPlan?.deliveries ?? retryOps?.map((item, i) => ({
    ...item,
    id: `legacy-${i}`,
    ...(storedPlan?.track === "A" ? { verbatim: true } : {}),
  }));
  const dispatched = parseDispatched(existing.dispatched_json);
  if (!deliveries?.length && (dispatched ?? []).some((d) => d.ok)) {
    throw fail(
      "conflict",
      "这条指令已有目标投递成功，整条重跑会重复投递；还有没交代到的请重新发一条",
    );
  }

  if (usedRetryIds.length >= ROUTER_COMMAND_MAX_RETRIES) {
    throw fail("conflict", `这条指令已达到重试上限（${ROUTER_COMMAND_MAX_RETRIES} 次），请重新发一条指令`);
  }

  const nextPlan: StoredRouterAgentPlan = {
    ...basePlan,
    ...(deliveries?.length ? { deliveries } : {}),
    retryId: retry.retryId,
    usedRetryIds: [...usedRetryIds, retry.retryId],
  };

  return db.get<RouterCommandDbRow>(
    `UPDATE router_commands SET
       status = 'planning',
       error = NULL,
       plan_json = ?,
       updated_at = ?
     WHERE id = ? RETURNING *`,
    JSON.stringify(nextPlan),
    nowMs,
    id,
  )!;
}
