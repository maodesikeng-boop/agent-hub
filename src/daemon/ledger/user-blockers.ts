// 要用户本人动手的阻塞（docs/user-blockers-design.md）：一个原因一条（同一家厂商在这台设备上只一条在等），
// 每个被它卡住的项目经理对话里各挂一张卡；用户在任意一张上点 Done，重查能用就在 resolveIn 里一次解开：
// 卡全部标已答、步骤全部离开等用户、Worker 全部接着跑、受影响的图都推变化，在同一个事务里。
import type { RecheckUserBlockerResponse } from "../../shared/api.ts";
import type { ConversationId, MessageId, WorkerId } from "../../shared/domain.ts";
import { USER_BLOCKERS_RESOLVED_KEEP } from "../../shared/limits.ts";
import {
  userBlockerCardText,
  userBlockerCleared,
  userBlockerKindOf,
  userBlockerText,
  type UserBlocker,
  type UserBlockerCause,
  type UserBlockerId,
  type UserBlockerKind,
} from "../../shared/user-blockers.ts";
import type { AgentVendor, VendorAvailability } from "../../shared/vendors.ts";
import { fail } from "./context.ts";
import type { LedgerContext, Pending } from "./context.ts";
import type { LedgerMessages } from "./messages.ts";
import type { LedgerSessions } from "./sessions.ts";

interface UserBlockerDbRow {
  id: number;
  kind: UserBlockerKind;
  vendor: AgentVendor;
  device: string;
  status: "open" | "resolved";
  rechecked_as: VendorAvailability | null;
  created_at: number;
  updated_at: number;
}

const toUserBlocker = (row: UserBlockerDbRow): UserBlocker => ({
  id: row.id,
  kind: row.kind,
  vendor: row.vendor,
  device: row.device,
  recheckedAs: row.rechecked_as,
});

/** 告诉项目经理的那句：已经挂卡、处理完自动接着派，它不用挂卡也不用重派。 */
export const userBlockedPmNote = (cause: UserBlockerCause): string =>
  `${userBlockerText(cause)}。已挂卡等用户处理，用户点 Done 后系统自动接着派，不用你挂卡或重派`;

/** 解开时步骤和 Worker 各自怎么接着走（任务图、Worker 模块实现），都在 resolveIn 的同一个事务里调。 */
export interface UserBlockerReleases {
  /** 被这条卡住、还在等用户的步骤全部离开等用户，受影响的图推变化。 */
  releaseStepsIn(p: Pending, blockerId: UserBlockerId): void;
  /** 重查还不能用：被它卡住的步骤所在的图推一次变化（步骤上的卡跟着补那句话）。 */
  notifyStepsIn(p: Pending, blockerId: UserBlockerId): void;
  /** 起不来的 Worker 接着跑：没送进去的消息重新排队，没有可重发的就叫它接着干。 */
  resumeWorkerIn(p: Pending, workerId: WorkerId, messageIds: readonly MessageId[], blocker: UserBlocker): void;
}

export type LedgerUserBlockers = ReturnType<typeof createLedgerUserBlockers>;

export function createLedgerUserBlockers(
  ctx: LedgerContext,
  sessions: LedgerSessions,
  messages: LedgerMessages,
  releases: () => UserBlockerReleases,
) {
  const { db, now, write } = ctx;

  const rowOf = (id: UserBlockerId) => db.get<UserBlockerDbRow>("SELECT * FROM user_blockers WHERE id = ?", id);
  const cardMessageIds = (id: UserBlockerId) =>
    db.all<{ message_id: number }>("SELECT message_id FROM user_blocker_cards WHERE blocker_id = ? ORDER BY message_id", id).map((r) => r.message_id);

  const reviseCardsIn = (p: Pending, row: UserBlockerDbRow) => {
    const text = userBlockerCardText(toUserBlocker(row));
    for (const messageId of cardMessageIds(row.id)) {
      db.run("UPDATE messages SET text = ?, updated_at = ? WHERE id = ?", text, now(), messageId);
      const message = messages.getMessage(messageId);
      if (message !== null) p.changes.push({ type: "message.updated", data: { message } });
    }
  };

  /** 这个对话里还没有这条的卡就挂一张（对话没有当前会话的不挂）。 */
  const ensureCardIn = (p: Pending, row: UserBlockerDbRow, conversationId: ConversationId) => {
    if (db.get("SELECT 1 AS x FROM user_blocker_cards WHERE blocker_id = ? AND conversation_id = ?", row.id, conversationId) !== undefined) return;
    const session = sessions.currentSession(conversationId);
    if (session === null) return;
    const card = messages.insertAskMessage(p, { ...session, conversationId }, userBlockerCardText(toUserBlocker(row)), undefined, {
      blockerRef: { blockerId: row.id },
    });
    db.run("INSERT INTO user_blocker_cards (blocker_id, conversation_id, message_id) VALUES (?, ?, ?)", row.id, conversationId, card.id);
  };

  /**
   * 这家厂商在这台设备上要用户动手，卡住了 conversationId 那个项目经理的步骤或 Worker：有在等的就用它（原因变了改所有卡上的话），
   * 没有就建一条；这个对话里还没有卡就挂一张。谁被它卡住由调用方记（步骤调 blockStep，Worker 调 attachWorkerIn）。
   */
  const raiseIn = (p: Pending, kind: UserBlockerKind, vendor: AgentVendor, conversationId: ConversationId): UserBlocker => {
    const device = ctx.deviceName();
    const t = now();
    let row = db.get<UserBlockerDbRow>("SELECT * FROM user_blockers WHERE vendor = ? AND status = 'open'", vendor);
    if (row === undefined) {
      row = db.get<UserBlockerDbRow>(
        "INSERT INTO user_blockers (kind, vendor, device, status, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?) RETURNING *",
        kind,
        vendor,
        device,
        t,
        t,
      )!;
    } else if (row.kind !== kind || row.device !== device) {
      db.run("UPDATE user_blockers SET kind = ?, device = ?, rechecked_as = NULL, updated_at = ? WHERE id = ?", kind, device, t, row.id);
      row = rowOf(row.id)!;
      reviseCardsIn(p, row);
    }
    ensureCardIn(p, row, conversationId);
    return toUserBlocker(row);
  };

  /** 这个 Worker 起不来、被这条卡住：记下没送进去的消息，同一个 Worker 再失败就并进去。 */
  const attachWorkerIn = (blockerId: UserBlockerId, workerId: WorkerId, messageIds: readonly MessageId[]) => {
    const existing = db.get<{ message_ids_json: string }>(
      "SELECT message_ids_json FROM user_blocker_workers WHERE blocker_id = ? AND worker_id = ?",
      blockerId,
      workerId,
    );
    const merged = [...new Set([...(existing === undefined ? [] : (JSON.parse(existing.message_ids_json) as MessageId[])), ...messageIds])];
    db.run(
      `INSERT INTO user_blocker_workers (blocker_id, worker_id, message_ids_json) VALUES (?, ?, ?)
       ON CONFLICT (blocker_id, worker_id) DO UPDATE SET message_ids_json = excluded.message_ids_json`,
      blockerId,
      workerId,
      JSON.stringify(merged),
    );
  };

  /** 这一步被这条卡住（调用方在同一个事务里把步骤改成等用户）。 */
  const blockStep = (stepId: number, blockerId: UserBlockerId) => {
    db.run("INSERT OR REPLACE INTO user_blocker_steps (step_id, blocker_id) VALUES (?, ?)", stepId, blockerId);
  };

  /** 一批步骤各自被哪条还在等的阻塞卡着（任务图读出来时一起带上）：步骤编号 → 阻塞。 */
  const ofSteps = (stepIds: readonly number[]): Map<number, UserBlocker> => {
    const map = new Map<number, UserBlocker>();
    if (stepIds.length === 0) return map;
    const rows = db.all<UserBlockerDbRow & { step_id: number }>(
      `SELECT s.step_id, b.* FROM user_blocker_steps s JOIN user_blockers b ON b.id = s.blocker_id
        WHERE b.status = 'open' AND s.step_id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(stepIds),
    );
    for (const row of rows) map.set(row.step_id, toUserBlocker(row));
    return map;
  };

  /** 用户处理完、重查能用：这条标解开，所有卡标已答，被它卡住的步骤和 Worker 一起接着走。 */
  const resolveIn = (p: Pending, row: UserBlockerDbRow) => {
    db.run("UPDATE user_blockers SET status = 'resolved', rechecked_as = NULL, updated_at = ? WHERE id = ?", now(), row.id);
    const resolved = rowOf(row.id)!;
    if (row.rechecked_as !== null) reviseCardsIn(p, resolved);
    for (const messageId of cardMessageIds(row.id)) messages.settleAskIn(p, messageId, { by: "answer" });
    const { releaseStepsIn, resumeWorkerIn } = releases();
    releaseStepsIn(p, row.id);
    const workers = db.all<{ worker_id: number; message_ids_json: string }>(
      "SELECT worker_id, message_ids_json FROM user_blocker_workers WHERE blocker_id = ? ORDER BY worker_id",
      row.id,
    );
    for (const w of workers) resumeWorkerIn(p, w.worker_id, JSON.parse(w.message_ids_json) as MessageId[], toUserBlocker(resolved));
    db.run("DELETE FROM user_blocker_workers WHERE blocker_id = ?", row.id);
    db.run("DELETE FROM user_blocker_steps WHERE blocker_id = ?", row.id);
    db.run(
      `DELETE FROM user_blockers WHERE status = 'resolved' AND id NOT IN (
         SELECT id FROM user_blockers WHERE status = 'resolved' ORDER BY id DESC LIMIT ?)`,
      USER_BLOCKERS_RESOLVED_KEEP,
    );
    return toUserBlocker(resolved);
  };

  /**
   * 用户点了 Done，界面服务已经让 ModelCatalogs 重问过这家：按 ctx.vendorAvailability 的现状，还不能用就留卡并补一句，
   * 能用就 resolveIn。已经解开的原样回，不重复派。
   */
  const recheck = (id: UserBlockerId): RecheckUserBlockerResponse =>
    write((p) => {
      const row = rowOf(id);
      if (row === undefined) throw fail("not_found", "这张卡不在了");
      if (row.status === "resolved") return { blocker: toUserBlocker(row), resolved: true };
      const availability = ctx.vendorAvailability(row.vendor);
      if (userBlockerCleared(availability)) return { blocker: resolveIn(p, row), resolved: true };
      const kind = userBlockerKindOf(availability) ?? row.kind;
      db.run("UPDATE user_blockers SET kind = ?, rechecked_as = ?, updated_at = ? WHERE id = ?", kind, availability, now(), id);
      const updated = rowOf(id)!;
      reviseCardsIn(p, updated);
      releases().notifyStepsIn(p, id);
      return { blocker: toUserBlocker(updated), resolved: false };
    });

  const vendorOf = (id: UserBlockerId): AgentVendor | null => {
    const row = rowOf(id);
    return row === undefined || row.status !== "open" ? null : row.vendor;
  };

  return { raiseIn, attachWorkerIn, blockStep, ofSteps, recheck, vendorOf };
}
