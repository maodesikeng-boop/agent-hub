// 要用户本人动手的阻塞（docs/user-blockers-design.md）：挂卡（同一家厂商在这台设备上只一张）、点 Done 后按重查结果解开并接着派。
// 被卡住的步骤由 task-graphs.ts 记在步骤上、解开时重算整张图；起不来的 Worker 记在 user_blocker_workers，解开时由 workers.ts 把消息重新排队。
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
  conversation_id: number;
  ask_message_id: number | null;
  rechecked_as: VendorAvailability | null;
  created_at: number;
  updated_at: number;
}

const toUserBlocker = (row: UserBlockerDbRow): UserBlocker => ({
  id: row.id,
  kind: row.kind,
  vendor: row.vendor,
  device: row.device,
  askMessageId: row.ask_message_id,
  recheckedAs: row.rechecked_as,
});

/** 告诉项目经理的那句：已经挂卡、处理完自动接着派，它不用挂卡也不用重派。 */
export const userBlockedPmNote = (cause: UserBlockerCause): string =>
  `${userBlockerText(cause)}。已挂卡等用户处理，用户点 Done 后系统自动接着派，不用你挂卡或重派`;

export interface UserBlockerReleases {
  /** 解开时：被这条卡住、还在等用户的步骤接着派（没派出去的重算整张图，挂着 Worker 的回到在干）。 */
  releaseStepsIn(p: Pending, blockerId: UserBlockerId, vendorStatus: { vendor: AgentVendor; availability: VendorAvailability }): void;
  /** 重查还不能用：被它卡住的步骤所在的图推一次变化（步骤上的卡跟着补那句话）。 */
  notifyStepsIn(p: Pending, blockerId: UserBlockerId): void;
  /** 解开时：起不来的 Worker 把没送进去的消息重新排队。 */
  resumeWorkerIn(p: Pending, workerId: WorkerId, messageIds: readonly MessageId[]): void;
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

  const reviseCardIn = (p: Pending, row: UserBlockerDbRow) => {
    if (row.ask_message_id === null) return;
    db.run("UPDATE messages SET text = ?, updated_at = ? WHERE id = ?", userBlockerCardText(toUserBlocker(row)), now(), row.ask_message_id);
    const message = messages.getMessage(row.ask_message_id);
    if (message !== null) p.changes.push({ type: "message.updated", data: { message } });
  };

  /**
   * 这家厂商在这台设备上要用户动手：有在等的就用它（原因变了改卡上的话），没有就建一条并在 conversationId 那个对话里挂卡。
   * 谁被它卡住由调用方记（步骤调 blockStep，Worker 调 attachWorkerIn）。
   */
  const raiseIn = (p: Pending, kind: UserBlockerKind, vendor: AgentVendor, conversationId: ConversationId): UserBlocker => {
    const cause: UserBlockerCause = { kind, vendor, device: ctx.deviceName() };
    const t = now();
    const open = db.get<UserBlockerDbRow>("SELECT * FROM user_blockers WHERE vendor = ? AND status = 'open'", vendor);
    if (open !== undefined) {
      if (open.kind === cause.kind && open.device === cause.device) return toUserBlocker(open);
      db.run("UPDATE user_blockers SET kind = ?, device = ?, rechecked_as = NULL, updated_at = ? WHERE id = ?", cause.kind, cause.device, t, open.id);
      const updated = rowOf(open.id)!;
      reviseCardIn(p, updated);
      return toUserBlocker(updated);
    }
    const row = db.get<UserBlockerDbRow>(
      `INSERT INTO user_blockers (kind, vendor, device, status, conversation_id, created_at, updated_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?) RETURNING *`,
      cause.kind,
      cause.vendor,
      cause.device,
      conversationId,
      t,
      t,
    )!;
    const session = sessions.currentSession(conversationId);
    if (session === null) return toUserBlocker(row);
    const card = messages.insertAskMessage(p, { ...session, conversationId }, userBlockerCardText({ ...cause, recheckedAs: null }), undefined, {
      blockerRef: { blockerId: row.id },
    });
    db.run("UPDATE user_blockers SET ask_message_id = ? WHERE id = ?", card.id, row.id);
    return toUserBlocker(rowOf(row.id)!);
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

  /**
   * 用户点了 Done，界面服务重查完这家厂商（availability）：还不能用，卡留着并补一句；能用就解开，卡标已答，卡住的步骤和 Worker 接着派。
   * 已经解开的原样回，不重复派。
   */
  const recheck = (id: UserBlockerId, availability: VendorAvailability): RecheckUserBlockerResponse =>
    write((p) => {
      const row = rowOf(id);
      if (row === undefined) throw fail("not_found", "这张卡不在了");
      if (row.status === "resolved") return { blocker: toUserBlocker(row), resolved: true };
      const t = now();
      if (!userBlockerCleared(availability)) {
        const kind = userBlockerKindOf(availability) ?? row.kind;
        db.run("UPDATE user_blockers SET kind = ?, rechecked_as = ?, updated_at = ? WHERE id = ?", kind, availability, t, id);
        const updated = rowOf(id)!;
        reviseCardIn(p, updated);
        releases().notifyStepsIn(p, id);
        return { blocker: toUserBlocker(updated), resolved: false };
      }
      db.run("UPDATE user_blockers SET status = 'resolved', rechecked_as = NULL, updated_at = ? WHERE id = ?", t, id);
      if (row.rechecked_as !== null) reviseCardIn(p, rowOf(id)!);
      if (row.ask_message_id !== null) messages.settleAskIn(p, row.ask_message_id, { by: "answer" });
      const { releaseStepsIn, resumeWorkerIn } = releases();
      releaseStepsIn(p, id, { vendor: row.vendor, availability });
      const workers = db.all<{ worker_id: number; message_ids_json: string }>(
        "SELECT worker_id, message_ids_json FROM user_blocker_workers WHERE blocker_id = ? ORDER BY worker_id",
        id,
      );
      db.run("DELETE FROM user_blocker_workers WHERE blocker_id = ?", id);
      for (const w of workers) resumeWorkerIn(p, w.worker_id, JSON.parse(w.message_ids_json) as MessageId[]);
      db.run("DELETE FROM user_blocker_steps WHERE blocker_id = ?", id);
      db.run(
        `DELETE FROM user_blockers WHERE status = 'resolved' AND id NOT IN (
           SELECT id FROM user_blockers WHERE status = 'resolved' ORDER BY id DESC LIMIT ?)`,
        USER_BLOCKERS_RESOLVED_KEEP,
      );
      return { blocker: toUserBlocker(rowOf(id) ?? row), resolved: true };
    });

  const vendorOf = (id: UserBlockerId): AgentVendor | null => {
    const row = rowOf(id);
    return row === undefined || row.status !== "open" ? null : row.vendor;
  };

  return { raiseIn, attachWorkerIn, blockStep, ofSteps, recheck, vendorOf };
}
