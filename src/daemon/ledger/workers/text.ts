import { sandboxApprovalPending } from "../sandbox-approvals.ts";
import { randomUUID } from "node:crypto";
import { utf8Bytes, type ConversationId, type MessageId, type WorkerId } from "../../../shared/domain.ts";
import { turnFailureReason, type DriverEvent } from "../../../shared/driver.ts";
import { DEFAULT_WORKER_MAX_TIME_MS, GIT_REASON_MAX_CHARS, MAX_TASK_BYTES, WORKER_BACKGROUND_HOLD_MAX_MS } from "../../../shared/limits.ts";
import { HUB_COMMAND } from "../../../shared/names.ts";
import { parseReviewTarget, type ReviewTarget } from "../../../shared/review.ts";
import { checkWorkerMaxTimeMs } from "../../../shared/schedule.ts";
import type { Db } from "../../store/index.ts";
import { fail } from "../context.ts";
import { exitFailureReason } from "../messages.ts";
import type { WorkerDbRow } from "../rows.ts";
import type { StepWorkspacePlan } from "../task-graphs.ts";
import type { ReportMessage, ReportMessageRow } from "./types.ts";

export const WORKTREE_DIRTY_NOTE = "注意：主文件夹里有没提交的改动，Worker 是从最后一次提交开始的，看不到这些改动。";
export const TURN_STOPPED = "被停止了";
const TURN_FAILED = "这一轮出错了";
export const NO_REPLY_TEXT = "（这一轮没有文字回复）";

export function backgroundKilledNote(reason: "idle" | "shutdown" | "restart"): string {
  const resend = `要它重跑或接着做用 ${HUB_COMMAND} worker send。`;
  if (reason === "restart") {
    return `【系统】这个 Worker 在等放到后台的命令时守护进程重启了，命令随旧进程中断（跑没跑完、结果它都没看到）；下面是它中断前最后一轮的回复。${resend}`;
  }
  const why = reason === "idle" ? `超过 ${WORKER_BACKGROUND_HOLD_MAX_MS / 60_000} 分钟还没结束（可能卡住了）` : "还没结束，守护进程就关了";
  return `【系统】这个 Worker 放到后台的命令${why}，已经连同它的进程一起停掉；下面是它停之前最后一轮的回复。${resend}`;
}

export const taskDedupeKey = (workerId: WorkerId) => `pm:worker:${workerId}:task`;
export const sendDedupeKey = (workerId: WorkerId) => `pm:worker:${workerId}:${randomUUID()}`;

export type TurnOutcome =
  | { event: "report"; turnMessageId: MessageId | null }
  | { event: "turn_failed"; turnMessageId: MessageId | null; messageIds: MessageId[]; reason: string };

export function turnOutcome(event: DriverEvent): TurnOutcome | null {
  if (event.type === "driver.error") {
    const ids = event.messageIds ?? [];
    return ids.length === 0 ? null : { event: "turn_failed", turnMessageId: Math.max(...ids), messageIds: ids, reason: event.message };
  }
  if (event.type !== "turn.ended" && event.type !== "session.exited") return null;
  const { messageIds } = event;
  const selfStarted = event.type === "turn.ended" && messageIds.length === 0;
  if (messageIds.length === 0 && !selfStarted) return null;
  const turnMessageId = selfStarted ? null : Math.max(...messageIds);
  if (event.type === "turn.ended") {
    if (event.shutdown === true) return null;
    if (event.interrupted) return { event: "turn_failed", turnMessageId, messageIds, reason: TURN_STOPPED };
    if (!event.ok) {
      const reason = event.error === undefined ? TURN_FAILED : turnFailureReason(event.error);
      return { event: "turn_failed", turnMessageId, messageIds, reason };
    }
    return { event: "report", turnMessageId };
  }
  if (event.hadResult) return null;
  if (event.reason === "interrupt") return { event: "turn_failed", turnMessageId, messageIds, reason: TURN_STOPPED };
  if (event.reason === "crash" || event.reason === "startup_failed") {
    return { event: "turn_failed", turnMessageId, messageIds, reason: exitFailureReason(event) };
  }
  return null;
}

export const notStarted = (worker: Pick<WorkerDbRow, "workspace" | "base_commit">) => worker.workspace === "worktree" && worker.base_commit === null;

export function assertWorkerOpenForUser(db: Db, conversationId: ConversationId): void {
  const worker = db.get<Pick<WorkerDbRow, "id" | "status" | "workspace" | "base_commit">>(
    "SELECT id, status, workspace, base_commit FROM workers WHERE worker_conversation_id = ?",
    conversationId,
  );
  if (worker === undefined) return;
  if (worker.status === "ended") throw fail("conflict", `Worker #${worker.id} 已经收工了，不能再给它发消息`);
  if (sandboxApprovalPending(db, worker.id)) throw fail("conflict", "Worker 还在等用户确认沙箱，不能发消息");
  if (notStarted(worker)) throw fail("conflict", `Worker 还在准备，等它开工后再发（Worker #${worker.id} 在建 worktree 或跑项目的准备命令）`);
}

function gitReasonLine(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const reason = lines.find((l) => /^(fatal|error):/.test(l)) ?? lines.at(-1) ?? "没有给出原因";
  return [...reason.replace(/。$/, "")].slice(0, GIT_REASON_MAX_CHARS).join("");
}

/** When git fails the start is refused instead of silently running in the main folder. */
export const gitFailed = (output: string) =>
  fail("git_failed", `git 没跑成：${gitReasonLine(output)}。可以重试；或者加 --no-worktree，明确让 Worker 在主文件夹里干。`);

export function worktreeLabel(worker: WorkerDbRow): string {
  const review = parseReviewTarget(worker.review_json);
  return review !== null
    ? `审查目录 ${worker.worktree_path}（detached 在被审分支 ${review.branch} 上）`
    : `worktree ${worker.worktree_path}（分支 ${worker.branch}）`;
}

export function describeWorkspace(worker: WorkerDbRow, mainFolder: string): string {
  return worker.workspace === "worktree" ? `在${worktreeLabel(worker)}里干活` : `直接在项目的主文件夹 ${mainFolder} 里干活`;
}

export const newReviewJson = (plan: StepWorkspacePlan): string | null =>
  plan.kind === "review" ? JSON.stringify({ branch: plan.branch, snapshot: null } satisfies ReviewTarget) : null;

export const toReportMessage = (row: ReportMessageRow | undefined): ReportMessage | null =>
  row === undefined ? null : { id: row.id, text: row.text, meta: row.meta === null ? null : (JSON.parse(row.meta) as Record<string, unknown>) };

export function validTask(raw: unknown, what: string): string {
  if (typeof raw !== "string" || raw.trim() === "") throw fail("invalid", `${what}不能是空的`);
  if (utf8Bytes(raw) > MAX_TASK_BYTES) throw fail("invalid", `${what}不能超过 ${MAX_TASK_BYTES} 字节`);
  return raw;
}

export function validMaxTimeMs(raw: unknown): number {
  if (raw === undefined) return DEFAULT_WORKER_MAX_TIME_MS;
  const bad = checkWorkerMaxTimeMs(raw);
  if (bad !== null) throw fail("invalid", bad);
  return raw as number;
}
