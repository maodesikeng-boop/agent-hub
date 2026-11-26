import type { RouterCommandId } from "../../shared/domain.ts";
import { ROUTER_MAX_DISPATCH_TARGETS } from "../../shared/limits.ts";
import type { RouterCommandDispatchedTarget } from "../../shared/router.ts";
import { fail, type LedgerContext, type Pending } from "./context.ts";
import {
  emptyRouterPlan,
  parseDispatched,
  parseStoredRouterPlan,
  type RouterCommandDbRow,
  type RouterDelivery,
} from "./router-command-retries.ts";

export interface RouterCommandRun {
  commandId: RouterCommandId;
  retryId?: string;
}

type DeliveryChange =
  | { kind: "prepare"; delivery: RouterDelivery; track: "A" | "B" }
  | { kind: "checkpoint"; id: string; receipt: RouterCommandDispatchedTarget }
  | { kind: "publish"; id: string }
  | { kind: "discard"; id: string };

export function createRouterCommandDeliveries(
  { db, write, now }: LedgerContext,
  publishReceiptIn: (p: Pending, row: RouterCommandDbRow, receipt: RouterCommandDispatchedTarget) => void,
) {
  function list(commandId: RouterCommandId): RouterDelivery[] {
    const row = db.get<Pick<RouterCommandDbRow, "plan_json">>("SELECT plan_json FROM router_commands WHERE id = ?", commandId);
    return parseStoredRouterPlan(row?.plan_json ?? null)?.deliveries ?? [];
  }

  function change(run: RouterCommandRun, change: DeliveryChange): void {
    write((p) => {
      const row = db.get<RouterCommandDbRow>("SELECT * FROM router_commands WHERE id = ?", run.commandId);
      if (row === undefined) throw fail("not_found", `没有编号 ${run.commandId} 的总助指令`);
      const plan = parseStoredRouterPlan(row.plan_json) ?? { ...emptyRouterPlan };
      if (row.status !== "planning" || plan.retryId !== run.retryId) {
        throw fail("conflict", "总助投递已不属于当前这轮指令");
      }
      const deliveries = [...(plan.deliveries ?? [])];
      const dispatched = parseDispatched(row.dispatched_json) ?? [];
      if (change.kind === "prepare") {
        if (deliveries.length + dispatched.length >= ROUTER_MAX_DISPATCH_TARGETS) {
          throw fail("conflict", `单条指令最多分派 ${ROUTER_MAX_DISPATCH_TARGETS} 个目标`);
        }
        deliveries.push(change.delivery);
      } else {
        const index = deliveries.findIndex(({ id }) => id === change.id);
        const delivery = deliveries[index];
        if (delivery === undefined) throw fail("conflict", "找不到待完成的总助投递操作");
        if (change.kind === "publish") {
          if (delivery.receipt === undefined) throw fail("conflict", "总助投递尚未收到目标回执");
          dispatched.push(delivery.receipt);
          deliveries.splice(index, 1);
        } else if (change.kind === "discard") {
          deliveries.splice(index, 1);
        } else {
          deliveries[index] = { ...delivery, receipt: change.receipt };
        }
      }

      const planJson = JSON.stringify({
        ...plan,
        ...(change.kind === "prepare" ? { intent: "dispatch", track: change.track } : {}),
        deliveries: deliveries.length > 0 ? deliveries : undefined,
      });
      const receipt = change.kind === "publish" ? dispatched.at(-1) : undefined;
      if (receipt === undefined) {
        db.run("UPDATE router_commands SET plan_json = ?, updated_at = ? WHERE id = ?", planJson, now(), run.commandId);
        return;
      }
      const updated = db.get<RouterCommandDbRow>(
        "UPDATE router_commands SET plan_json = ?, dispatched_json = ?, updated_at = ? WHERE id = ? RETURNING *",
        planJson, JSON.stringify(dispatched), now(), run.commandId,
      )!;
      publishReceiptIn(p, updated, receipt);
    });
  }

  return { list, change };
}
