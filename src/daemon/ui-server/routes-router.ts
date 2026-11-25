import type { FastifyInstance } from "fastify";
import {
  API_PATHS,
  LedgerRequestError,
  type ArchiveAllReportsResponse,
  type CancelTaskGraphResponse,
  type DecideTaskNodeResponse,
  type DeviceRouterDigest,
  type PostRouterCommandResponse,
  type RecheckUserBlockerResponse,
  type ResolveRouterItemRequest,
  type ResolveRouterItemResponse,
  type RouterCommandsPage,
  type RouterItemsPage,
  type SkipTaskNodeResponse,
  type UpdateRouterSettingsResponse,
} from "../../shared/index.ts";
import { routerTargetOpSchema } from "../router/index.ts";
import { peerOf, type UiCtx } from "./context.ts";
import { fail, idParam, parseId, parseNodeKeyParam, parseOptionalPositiveInt, parseWithSchema } from "./http.ts";
import {
  cancelTaskGraphBodySchema,
  decideRouterItemBodySchema,
  decideTaskNodeBodySchema,
  emptyObjectBodySchema,
  postRouterCommandBodySchema,
  resolveRouterItemBodySchema,
  skipTaskNodeBodySchema,
  updateRouterSettingsBodySchema,
} from "./schemas.ts";

type PageQuery = { cursor?: unknown; before?: unknown; limit?: unknown };

const cursorOf = (query: PageQuery): string | undefined =>
  typeof query.cursor === "string" && query.cursor.trim() !== ""
    ? query.cursor
    : typeof query.before === "string" && query.before.trim() !== ""
      ? query.before
      : undefined;

type DecisionBody = { clientId: string; optionIndex?: number | null | undefined; choice?: string | null | undefined; note?: string | undefined };

const decisionOf = (raw: DecisionBody) => ({
  clientId: raw.clientId,
  optionIndex: raw.optionIndex ?? null,
  ...(raw.choice !== undefined && raw.choice !== null ? { choice: raw.choice } : {}),
  ...(raw.note !== undefined ? { note: raw.note } : {}),
});

function registerRouterItemRoutes(routes: FastifyInstance, c: UiCtx): void {
  const { opts, ledger } = c;
  routes.get(API_PATHS.routerDigest, async (): Promise<DeviceRouterDigest> => {
    return ledger.getRouterDigest();
  });

  routes.get(API_PATHS.routerItems, async (req): Promise<RouterItemsPage> => {
    const query = req.query as PageQuery & { kind?: unknown };
    const cursor = cursorOf(query);
    const limit = parseOptionalPositiveInt(query.limit, "limit");
    if (query.kind === undefined) return ledger.listRouterItems(cursor, limit);
    if (query.kind !== "report") throw new LedgerRequestError("invalid", "kind 只能是 report");
    return ledger.listRouterItems(cursor, limit, query.kind);
  });

  routes.post("/api/router/items/:id/resolve", async (req): Promise<ResolveRouterItemResponse> => {
    const itemId = idParam(req.params, "router item id");
    const raw = parseWithSchema(resolveRouterItemBodySchema, req.body);
    const body: ResolveRouterItemRequest = "action" in raw ? { action: "archive" } : decisionOf(raw);
    return ledger.resolveRouterItem(itemId, body);
  });

  routes.post("/api/asks/:id/answer", async (req): Promise<ResolveRouterItemResponse> => {
    const messageId = idParam(req.params, "message id");
    const raw = parseWithSchema(decideRouterItemBodySchema, req.body);
    return ledger.answerAsk(messageId, decisionOf(raw));
  });

  routes.post("/api/user-blockers/:id/recheck", async (req): Promise<RecheckUserBlockerResponse> => {
    const blockerId = idParam(req.params, "user blocker id");
    const vendor = ledger.userBlockerVendor(blockerId);
    if (vendor !== null && opts.models) await opts.models.list({ vendor, refresh: true });
    return ledger.recheckUserBlocker(blockerId);
  });

  routes.post("/api/router/items/:id/decide", async (req): Promise<ResolveRouterItemResponse> => {
    const itemId = idParam(req.params, "router item id");
    const raw = parseWithSchema(decideRouterItemBodySchema, req.body);
    return ledger.resolveRouterItem(itemId, decisionOf(raw));
  });

  routes.post("/api/router/items/:id/archive", async (req): Promise<ResolveRouterItemResponse> => {
    const itemId = idParam(req.params, "router item id");
    parseWithSchema(emptyObjectBodySchema, req.body ?? {});
    return ledger.resolveRouterItem(itemId, { action: "archive" });
  });
}

function registerRouterCommandRoutes(routes: FastifyInstance, c: UiCtx): void {
  const { opts, ledger } = c;
  routes.get(API_PATHS.routerCommands, async (req, reply): Promise<RouterCommandsPage> => {
    if (peerOf(c, req) !== undefined) return fail(reply, "forbidden_peer") as never;
    const query = req.query as PageQuery;
    const cursor = cursorOf(query);
    const limit = parseOptionalPositiveInt(query.limit, "limit");
    return ledger.listRouterCommands ? ledger.listRouterCommands(cursor, limit) : { commands: [], nextCursor: null, hasMore: false };
  });

  routes.post(API_PATHS.routerCommands, async (req, reply): Promise<PostRouterCommandResponse> => {
    if (peerOf(c, req) !== undefined) return fail(reply, "forbidden_peer") as never;
    if (!opts.routerDispatcher) return fail(reply, "unavailable", "当前服务未启用总助分派引擎") as never;
    const raw = parseWithSchema(postRouterCommandBodySchema, req.body);
    const command = await opts.routerDispatcher.submitCommand(raw, { background: true });
    return { command };
  });

  routes.post("/api/router/commands/:id/retry", async (req, reply): Promise<PostRouterCommandResponse> => {
    if (peerOf(c, req) !== undefined) return fail(reply, "forbidden_peer") as never;
    if (!opts.routerDispatcher) return fail(reply, "unavailable", "当前服务未启用总助分派引擎") as never;
    const commandId = idParam(req.params, "router command id");
    parseWithSchema(emptyObjectBodySchema, req.body ?? {});
    const command = await opts.routerDispatcher.retryCommand(commandId, { background: true });
    return { command };
  });

  routes.post(API_PATHS.routerTargetOps, async (req, reply) => {
    if (!opts.routerLocalPort) return fail(reply, "unavailable", "当前服务未启用总助目标端口");
    const op = parseWithSchema(routerTargetOpSchema, req.body);
    const result = await opts.routerLocalPort.executeOp(op);
    return { result };
  });

  routes.post(API_PATHS.routerReportsArchiveAll, async (req): Promise<ArchiveAllReportsResponse> => {
    parseWithSchema(emptyObjectBodySchema, req.body ?? {});
    return ledger.archiveAllRouterReports();
  });

  routes.put(API_PATHS.routerSettings, async (req): Promise<UpdateRouterSettingsResponse> => {
    const raw = parseWithSchema(updateRouterSettingsBodySchema, req.body);
    return {
      settings: ledger.updateRouterSettings({
        vendor: raw.vendor,
        model: raw.model,
        effort: raw.effort,
      }),
    };
  });
}

function registerTaskGraphRoutes(routes: FastifyInstance, c: UiCtx): void {
  const { ledger } = c;
  routes.post("/api/task-graphs/:graphId/nodes/:nodeKey/decide", async (req): Promise<DecideTaskNodeResponse> => {
    const params = req.params as { graphId?: unknown; nodeKey?: unknown };
    const graphId = parseId(params.graphId, "graphId");
    const nodeKey = parseNodeKeyParam(params.nodeKey);
    const raw = parseWithSchema(decideTaskNodeBodySchema, req.body);
    return ledger.decideTaskNode(graphId, nodeKey, raw);
  });

  routes.post("/api/task-graphs/:graphId/nodes/:nodeKey/skip", async (req): Promise<SkipTaskNodeResponse> => {
    const params = req.params as { graphId?: unknown; nodeKey?: unknown };
    const graphId = parseId(params.graphId, "graphId");
    const nodeKey = parseNodeKeyParam(params.nodeKey);
    const raw = parseWithSchema(skipTaskNodeBodySchema, req.body ?? {});
    return ledger.skipTaskNode(graphId, nodeKey, {
      ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
    });
  });

  routes.post("/api/task-graphs/:graphId/cancel", async (req): Promise<CancelTaskGraphResponse> => {
    const graphId = parseId((req.params as { graphId?: unknown }).graphId, "graphId");
    const raw = parseWithSchema(cancelTaskGraphBodySchema, req.body ?? {});
    return ledger.cancelTaskGraph(graphId, {
      ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
    });
  });
}

export function registerRouterRoutes(routes: FastifyInstance, c: UiCtx): void {
  registerRouterItemRoutes(routes, c);
  registerRouterCommandRoutes(routes, c);
  registerTaskGraphRoutes(routes, c);
}
