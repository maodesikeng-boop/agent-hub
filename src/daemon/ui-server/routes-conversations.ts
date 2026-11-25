import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ATTACHMENTS_MISSING_MESSAGE,
  COMPLETED_WORK_PAGE_SIZE,
  FILE_ACTIONS,
  LedgerRequestError,
  isLoopbackAddress,
  sentFilesOf,
  type CommandsResponse,
  type CompletedCursor,
  type CompletedWorkPage,
  type ConversationsLookup,
  type FileAction,
  type FileActionResponse,
  type FilesResponse,
  type PostMessageResponse,
  type RewindMessageResponse,
} from "../../shared/index.ts";
import {
  FILE_ACTIONS_UNAVAILABLE_MESSAGE,
  FileActionsUnavailable,
  OPEN_NOT_ALLOWED_MESSAGE,
  OpenNotAllowed,
  OpenTargetMissing,
  performFileAction,
} from "../open-file.ts";
import { resolveUpload } from "../uploads.ts";
import { clientAddress, type UiCtx } from "./context.ts";
import { NON_NEGATIVE_INT, POSITIVE_INT, fail, idParam, parseId, parseIdList, parseOptionalPositiveInt } from "./http.ts";
import { parsePostBody } from "./schemas.ts";

async function doFileAction(reply: FastifyReply, run: () => Promise<FileActionResponse>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof OpenTargetMissing) return fail(reply, "not_found");
    if (error instanceof OpenNotAllowed) return fail(reply, "forbidden", OPEN_NOT_ALLOWED_MESSAGE);
    if (error instanceof FileActionsUnavailable) return fail(reply, "unavailable", FILE_ACTIONS_UNAVAILABLE_MESSAGE);
    console.error("ui-server open failed:", error);
    return fail(reply, "internal", "没能打开这个文件");
  }
}

const parseAction = (raw: unknown): FileAction | null => ((FILE_ACTIONS as readonly unknown[]).includes(raw) ? (raw as FileAction) : null);

function registerFileActionRoutes(routes: FastifyInstance, c: UiCtx): void {
  const { ledger, runOpen } = c;
  const { uploadsDir, sentFilesDir } = c.opts;
  // A remote browser would open the file on the daemon machine's screen, not the user's.
  const requireLocal = (req: FastifyRequest): void => {
    if (!isLoopbackAddress(clientAddress(c, req))) throw new FileActionsUnavailable();
  };

  routes.post("/api/messages/:id/files/:index/:action", async (req, reply) => {
    const { id, index, action } = req.params as Record<string, unknown>;
    const act = parseAction(action);
    const message = typeof id === "string" && POSITIVE_INT.test(id) ? ledger.getMessage(Number(id)) : null;
    const file = message === null || typeof index !== "string" || !NON_NEGATIVE_INT.test(index) ? undefined : sentFilesOf(message)[Number(index)];
    if (act === null || message === null || file === undefined || file.id === null) return fail(reply, "not_found");
    const copy = resolveUpload(sentFilesDir, file.id);
    const sessionId = message.sessionId;
    return doFileAction(reply, async () => {
      requireLocal(req);
      return performFileAction(
        act,
        {
          original: file.path,
          isAllowed: (real) => sessionId !== null && ledger.sentFileAllows(sessionId, real),
          copy: copy?.path ?? null,
          name: file.name,
        },
        runOpen,
      );
    });
  });

  routes.post("/api/attachments/:id/:action", async (req, reply) => {
    const { id, action } = req.params as Record<string, unknown>;
    const act = parseAction(action);
    const attachment = resolveUpload(uploadsDir, String(id ?? ""));
    if (act === null || attachment === null) return fail(reply, "not_found");
    return doFileAction(reply, async () => {
      requireLocal(req);
      return performFileAction(act, { original: null, isAllowed: () => false, copy: attachment.path, name: attachment.name }, runOpen);
    });
  });
}

export function registerConversationRoutes(routes: FastifyInstance, c: UiCtx): void {
  const { opts, ledger } = c;
  routes.get("/api/conversations/:id/commands", async (req): Promise<CommandsResponse> => {
    const conversationId = idParam(req.params, "conversation id");
    return opts.composer ? opts.composer.commands(conversationId) : { commands: [] };
  });

  routes.get("/api/conversations/:id/files", async (req): Promise<FilesResponse> => {
    const conversationId = idParam(req.params, "conversation id");
    const { q } = req.query as { q?: unknown };
    return opts.composer ? opts.composer.files(conversationId, typeof q === "string" ? q : "") : { entries: [], truncated: false };
  });

  routes.get("/api/conversations/lookup", async (req): Promise<ConversationsLookup> => {
    const { ids, workerIds } = req.query as { ids?: unknown; workerIds?: unknown };
    return ledger.lookupConversations({ ids: parseIdList(ids, "ids"), workerIds: parseIdList(workerIds, "workerIds") });
  });

  routes.get("/api/pms/:id/completed", async (req): Promise<CompletedWorkPage> => {
    const pmId = idParam(req.params, "pm id");
    const { cursor, limit } = req.query as { cursor?: unknown; limit?: unknown };
    if (cursor !== undefined && typeof cursor !== "string") {
      throw new LedgerRequestError("invalid", "cursor must be a string");
    }
    const parsedCursor = cursor === undefined || cursor === "" ? null : (cursor as CompletedCursor);
    const parsedLimit = parseOptionalPositiveInt(limit, "limit") ?? COMPLETED_WORK_PAGE_SIZE;
    return ledger.completedWork(pmId, parsedCursor, parsedLimit);
  });

  routes.get("/api/conversations/:id/messages", async (req) => {
    const { id } = req.params as { id?: unknown };
    const { before } = req.query as { before?: unknown };
    return ledger.messagesBefore(parseId(id, "conversation id"), parseId(before, "before"));
  });

  routes.post("/api/conversations/:id/messages", async (req): Promise<PostMessageResponse> => {
    const conversationId = idParam(req.params, "conversation id");
    const { clientId, text, attachmentIds, workerPick } = parsePostBody(req.body);
    const attachments = attachmentIds.map((id) => resolveUpload(opts.uploadsDir, id) ?? undefined);
    if (attachments.some((a) => a === undefined)) throw new LedgerRequestError("invalid", ATTACHMENTS_MISSING_MESSAGE);
    return ledger.postUserMessage({
      conversationId,
      clientId,
      text,
      ...(attachments.length > 0 ? { attachments: attachments as NonNullable<(typeof attachments)[number]>[] } : {}),
      ...(workerPick !== undefined ? { workerPick } : {}),
    });
  });

  registerFileActionRoutes(routes, c);

  routes.post("/api/conversations/:id/stop", async (req, reply) => {
    ledger.requestStop(idParam(req.params, "conversation id"));
    return reply.code(202).send();
  });

  routes.post("/api/conversations/:id/end", async (req, reply) => {
    ledger.endWorkerConversation(idParam(req.params, "conversation id"));
    return reply.code(202).send();
  });

  routes.post("/api/conversations/:id/rewind", async (req): Promise<RewindMessageResponse> => {
    const id = idParam(req.params, "conversation id");
    return { message: ledger.rewindLastUserMessage(id) };
  });
}
