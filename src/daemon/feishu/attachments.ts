import { attachmentsOf } from "../../shared/attachments.ts";
import { askOf, type Message, type MessageId } from "../../shared/domain.ts";
import type { FeishuChatId, FeishuMessageId } from "../../shared/feishu.ts";
import { FEISHU_CONTROL_RETRY_MS, FEISHU_MEDIA_QUEUE_MAX, FEISHU_MEDIA_RETRY_MAX, FEISHU_PAGE_SIZE } from "../../shared/limits.ts";
import { sentFilesOf } from "../../shared/sent-files.ts";
import { resolveUpload } from "../uploads.ts";
import { handleError } from "./api.ts";
import type { FeishuAttachmentView } from "./cards.ts";
import { isReady, type AttachmentScope, type AttachmentSlot, type FeishuContext, type HostCard, type UploadJob } from "./context.ts";
import { refreshHostCard } from "./decision-cards.ts";
import { planFeishuFile, type FeishuFileService, type FeishuOutboundFile, type FeishuUploaded } from "./files.ts";
import { enqueue, settleIdle } from "./lanes.ts";
import { devicePostUuid } from "./projection.ts";
import type { FeishuChatBinding, FeishuPostRef } from "./store.ts";
import { FeishuAuthError, isFeishuRejection } from "./transport.ts";

type FilePart = Pick<FeishuOutboundFile, "messageId" | "part">;

const otherScope = (scope: AttachmentScope): AttachmentScope => (scope === "router" ? "pm" : "router");

function outboundFilesOf(ctx: FeishuContext, message: Message): FeishuOutboundFile[] {
  const user = message.sender === "user";
  const ask = askOf(message);
  const list: readonly { id: string | null }[] = user ? attachmentsOf(message) : ask !== null ? (ask.deliverables ?? []) : sentFilesOf(message);
  const dir = user ? ctx.options.uploadsDir : ctx.options.sentFilesDir;
  return list.flatMap((item, part) => {
    const copy = item.id === null ? null : resolveUpload(dir, item.id);
    return copy === null ? [] : [{ messageId: message.id, part, path: copy.path, name: copy.name, mime: copy.mime, bytes: copy.size }];
  });
}

const outboundFileOf = (ctx: FeishuContext, message: Message | null, part: number) =>
  message === null ? undefined : outboundFilesOf(ctx, message).find((f) => f.part === part);

const fileRef = (file: FilePart, scope: AttachmentScope = "pm"): FeishuPostRef =>
  scope === "router" ? { kind: "router_file", messageId: file.messageId, part: file.part } : { kind: "file", messageId: file.messageId, part: file.part };

const uploadKey = (file: FilePart) => `${file.messageId}:${file.part}`;

function peerUploadedOf(ctx: FeishuContext, file: FeishuOutboundFile, scope: AttachmentScope): FeishuUploaded | undefined {
  const peer = ctx.store.postOf(fileRef(file, otherScope(scope)));
  if (peer === null || peer.mediaKey === null) return undefined;
  const plan = planFeishuFile(file);
  if (plan.kind === "image") return { kind: "image", imageKey: peer.mediaKey };
  if (plan.kind === "file") return { kind: "file", fileKey: peer.mediaKey, msgType: plan.msgType };
  return undefined;
}

function backoff(ctx: FeishuContext, attempt: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      ctx.uploads.timers.delete(timer);
      resolve();
    }, FEISHU_CONTROL_RETRY_MS * 2 ** attempt);
    timer.unref?.();
    ctx.uploads.timers.add(timer);
  });
}

async function uploadWithRetry(ctx: FeishuContext, service: FeishuFileService, file: FeishuOutboundFile): Promise<FeishuUploaded | null | undefined> {
  for (let attempt = 0; ; attempt++) {
    if (ctx.life.closed || !isReady(ctx)) return undefined;
    try {
      return await service.upload(file);
    } catch (error) {
      handleError(ctx, error);
      if (ctx.life.closed || !isReady(ctx)) return undefined;
      if (isFeishuRejection(error) || error instanceof FeishuAuthError || attempt >= FEISHU_MEDIA_RETRY_MAX) return null;
      await backoff(ctx, attempt);
    }
  }
}

function startUpload(ctx: FeishuContext, file: FeishuOutboundFile): UploadJob | null {
  const { uploads } = ctx;
  const key = uploadKey(file);
  const existing = uploads.jobs.get(key);
  if (existing !== undefined) return existing;
  const service = ctx.link.files;
  if (service === null || ctx.life.closed || !isReady(ctx)) return null;
  if (uploads.inFlight >= FEISHU_MEDIA_QUEUE_MAX) {
    ctx.log(`飞书：在传的附件满了（${FEISHU_MEDIA_QUEUE_MAX} 个），「${file.name}」等一会儿再传`);
    return null;
  }
  const job: UploadJob = { startedAt: ctx.now(), done: Promise.resolve(), result: undefined, follows: new Set() };
  uploads.inFlight++;
  job.done = uploads
    .limit(() => uploadWithRetry(ctx, service, file))
    .then(
      (result) => {
        job.result = result;
        if (result === undefined && uploads.jobs.get(key) === job) uploads.jobs.delete(key);
      },
      (error: unknown) => {
        handleError(ctx, error);
        job.result = null;
      },
    )
    .finally(() => {
      uploads.inFlight--;
      settleIdle(ctx);
    });
  uploads.jobs.set(key, job);
  return job;
}

export function startUploadsOf(ctx: FeishuContext, message: Message) {
  for (const file of outboundFilesOf(ctx, message)) {
    if (ctx.store.postOf(fileRef(file, "pm"))?.mediaKey == null && ctx.store.postOf(fileRef(file, "router"))?.mediaKey == null) startUpload(ctx, file);
  }
}

export const attachmentSlots = (ctx: FeishuContext, message: Message, sending = false, scope: AttachmentScope = "pm"): AttachmentSlot[] =>
  outboundFilesOf(ctx, message).map((file) => {
    const row = ctx.store.postOf(fileRef(file, scope));
    const job = row === null || row.state === "uploading" ? (ctx.uploads.jobs.get(uploadKey(file)) ?? null) : null;
    const result = job?.result !== undefined ? job.result : peerUploadedOf(ctx, file, scope);
    return { file, row, job, result, sending };
  });

export async function prepareAttachments(ctx: FeishuContext, message: Message, scope: AttachmentScope = "pm"): Promise<AttachmentSlot[]> {
  const jobs = outboundFilesOf(ctx, message).flatMap((file) => {
    if (ctx.store.postOf(fileRef(file, scope)) !== null || peerUploadedOf(ctx, file, scope) !== undefined) return [];
    const job = startUpload(ctx, file);
    return job === null || job.result !== undefined ? [] : [job];
  });
  const left = jobs.length === 0 ? 0 : Math.max(...jobs.map((j) => j.startedAt)) + ctx.attachWaitMs - ctx.now();
  if (left > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(jobs.map((j) => j.done)), new Promise((resolve) => { timer = setTimeout(resolve, left); })]);
    clearTimeout(timer);
  }
  return attachmentSlots(ctx, message, true, scope);
}

function attachmentView({ file, row, job, result, sending }: AttachmentSlot): FeishuAttachmentView | null {
  const plan = planFeishuFile(file);
  const name = file.name;
  if (plan.kind === "too_large") return { kind: "too_large", name, bytes: file.bytes };
  if (row?.state === "uploading" && row.mediaKey === null) return result === null ? { kind: "failed", name } : { kind: "uploading", name };
  if (row !== null) {
    if (row.cardId === null) return null;
    if (row.mediaKey === null) return { kind: "failed", name };
    return plan.kind === "image" ? { kind: "image", name, imageKey: row.mediaKey } : { kind: "sent", name };
  }
  if (job === null && !sending) return null;
  if (result === undefined) return { kind: "uploading", name };
  if (result === null) return { kind: "failed", name };
  return result.kind === "image" ? { kind: "image", name, imageKey: result.imageKey } : null;
}

export const attachmentViews = (slots: readonly AttachmentSlot[]) => slots.flatMap((slot) => attachmentView(slot) ?? []);

async function sendUploadedFile(
  ctx: FeishuContext,
  chatId: FeishuChatId,
  file: FeishuOutboundFile,
  uploaded: Extract<FeishuUploaded, { kind: "file" }>,
  scope: AttachmentScope,
): Promise<FeishuMessageId | null | undefined> {
  const files = ctx.link.files;
  if (files === null) return undefined;
  try {
    return await files.sendFile(chatId, uploaded, devicePostUuid(ctx, scope === "router" ? "rf" : "f", `${file.messageId}-${file.part}`));
  } catch (error) {
    if (!isFeishuRejection(error)) throw error;
    handleError(ctx, error);
    return null;
  }
}

function forgetUploadUnlessPeerPending(ctx: FeishuContext, file: FilePart, scope: AttachmentScope) {
  if (ctx.store.postOf(fileRef(file, otherScope(scope)))?.state !== "uploading") ctx.uploads.jobs.delete(uploadKey(file));
}

export async function followUpAttachments(ctx: FeishuContext, chatId: FeishuChatId, slots: readonly AttachmentSlot[], host: HostCard, scope: AttachmentScope = "pm") {
  const rejected: FeishuOutboundFile[] = [];
  for (const { file, row, result } of slots) {
    if (row !== null) continue;
    const ref = fileRef(file, scope);
    const onHost = { ref, chatId, messageId: host.messageId, cardId: host.cardId, sequence: 0 };
    if (planFeishuFile(file).kind === "too_large" || result === null) {
      ctx.store.savePost({ ...onHost, state: "final", mediaKey: null }, ctx.now());
    } else if (result === undefined) {
      ctx.store.savePost({ ...onHost, state: "uploading" }, ctx.now());
      followUpload(ctx, chatId, file, scope);
      continue;
    } else if (result.kind === "image") {
      ctx.store.savePost({ ...onHost, state: "final", mediaKey: result.imageKey }, ctx.now());
    } else if (result.kind === "file") {
      const sent = await sendUploadedFile(ctx, chatId, file, result, scope);
      if (sent === undefined) continue;
      if (sent === null) {
        const job = ctx.uploads.jobs.get(uploadKey(file));
        if (job !== undefined) job.result = null;
        ctx.store.savePost({ ...onHost, state: "uploading" }, ctx.now());
        rejected.push(file);
        continue;
      }
      ctx.store.savePost({ ref, chatId, messageId: sent, cardId: null, sequence: 0, state: "final", mediaKey: result.fileKey }, ctx.now());
    }
    forgetUploadUnlessPeerPending(ctx, file, scope);
  }
  for (const file of rejected) await completeUpload(ctx, chatId, file.messageId, file.part, scope);
}

function followUpload(ctx: FeishuContext, chatId: FeishuChatId, file: FeishuOutboundFile, scope: AttachmentScope = "pm") {
  const job = startUpload(ctx, file);
  const followKey = `${scope}:${chatId}`;
  if (job === null || job.follows.has(followKey)) return;
  job.follows.add(followKey);
  void job.done.then(() => {
    if (job.result !== undefined) enqueue(ctx, chatId, () => completeUpload(ctx, chatId, file.messageId, file.part, scope));
  });
}

async function completeUpload(ctx: FeishuContext, chatId: FeishuChatId, messageId: MessageId, part: number, scope: AttachmentScope = "pm") {
  const ref = fileRef({ messageId, part }, scope);
  const row = ctx.store.postOf(ref);
  if (row?.state !== "uploading" || row.chatId !== chatId) return;
  const message = ctx.ledger.getMessage(messageId);
  const file = outboundFileOf(ctx, message, part);
  if (file !== undefined && row.mediaKey === null) {
    const job = ctx.uploads.jobs.get(uploadKey({ messageId, part }));
    const result = job?.result !== undefined ? job.result : peerUploadedOf(ctx, file, scope);
    if (result === undefined) {
      followUpload(ctx, chatId, file, scope);
      return;
    }
    let mediaKey: string | null = null;
    if (result?.kind === "image") mediaKey = result.imageKey;
    else if (result?.kind === "file") {
      const sent = await sendUploadedFile(ctx, chatId, file, result, scope);
      if (sent === undefined) return;
      if (sent === null && job !== undefined) job.result = null;
      else mediaKey = result.fileKey;
    }
    if (mediaKey !== null) ctx.store.savePost({ ...row, mediaKey }, ctx.now());
  }
  if (message !== null) await refreshHostCard(ctx, message, row.messageId);
  const latest = ctx.store.postOf(ref);
  if (latest !== null && ctx.store.chatById(chatId) !== null) ctx.store.savePost({ ...latest, state: "final" }, ctx.now());
  forgetUploadUnlessPeerPending(ctx, { messageId, part }, scope);
}

export async function resumeUploads(ctx: FeishuContext, chat: FeishuChatBinding) {
  for (const post of ctx.store.uploadingPosts(chat.chatId, FEISHU_PAGE_SIZE)) {
    if (post.ref.kind !== "file" && post.ref.kind !== "router_file") continue;
    const scope: AttachmentScope = post.ref.kind === "router_file" ? "router" : "pm";
    const { messageId, part } = post.ref;
    const candidate = outboundFileOf(ctx, ctx.ledger.getMessage(messageId), part);
    const needsUpload =
      post.mediaKey === null &&
      ctx.uploads.jobs.get(uploadKey({ messageId, part }))?.result === undefined &&
      (candidate === undefined || peerUploadedOf(ctx, candidate, scope) === undefined);
    if (!needsUpload || candidate === undefined) await completeUpload(ctx, chat.chatId, messageId, part, scope);
    else followUpload(ctx, chat.chatId, candidate, scope);
  }
}
