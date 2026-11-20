import type { MeshApprovalView } from "../../shared/mesh.ts";
import { postCardEntity, unlessRejected, updateCard } from "./api.ts";
import { renderMeshApprovalCard } from "./cards.ts";
import { isCenter, isReady, owner, type FeishuContext } from "./context.ts";
import { enqueue, requestControl } from "./lanes.ts";
import { centerRouterChat } from "./projection.ts";
import type { FeishuChatBinding } from "./store.ts";

async function upsertPendingCard(ctx: FeishuContext, chat: FeishuChatBinding, approval: MeshApprovalView) {
  const tracked = ctx.approvalCards.get(approval.requestId);
  if (tracked === undefined || tracked.settled) {
    const posted = await postCardEntity(
      ctx,
      chat.chatId,
      renderMeshApprovalCard({ kind: "pending", approval }),
      `fusa-ma-${approval.requestId}-${approval.requestedAt}`,
    );
    ctx.approvalCards.set(approval.requestId, { ...posted, sequence: 0, sas: approval.sas, deviceName: approval.device.name, settled: false });
  } else if (tracked.sas !== approval.sas) {
    const seq = tracked.sequence + 1;
    await unlessRejected(ctx, () => updateCard(ctx, tracked.cardId, seq, renderMeshApprovalCard({ kind: "pending", approval })));
    ctx.approvalCards.set(approval.requestId, { ...tracked, sequence: seq, sas: approval.sas });
  }
}

async function syncApprovalCards(ctx: FeishuContext) {
  const mesh = ctx.options.mesh;
  if (!isCenter(ctx) || !isReady(ctx) || mesh === undefined) return;
  const chat = centerRouterChat(ctx);
  if (chat === null) return;
  const snap = mesh.approvals();
  if (snap === null) return;
  for (const approval of snap.approvals) {
    if (!isCenter(ctx) || !isReady(ctx)) return;
    await upsertPendingCard(ctx, chat, approval);
  }
  for (const [reqId, tracked] of ctx.approvalCards.entries()) {
    if (tracked.settled || snap.approvals.some((a) => a.requestId === reqId)) continue;
    const approved = snap.joinedIds.has(reqId);
    const seq = tracked.sequence + 1;
    await unlessRejected(ctx, () =>
      updateCard(ctx, tracked.cardId, seq, renderMeshApprovalCard({ kind: approved ? "approved" : "closed", deviceName: tracked.deviceName })),
    );
    ctx.approvalCards.set(reqId, { ...tracked, sequence: seq, settled: true });
  }
}

export function scheduleApprovalCardsSync(ctx: FeishuContext) {
  if (!isCenter(ctx) || !isReady(ctx) || ctx.options.mesh === undefined) return;
  const chat = centerRouterChat(ctx);
  if (chat === null) {
    if (owner(ctx) !== null) requestControl(ctx, "sync");
    return;
  }
  enqueue(ctx, chat.chatId, () => syncApprovalCards(ctx), { key: "mesh-approvals" });
}
