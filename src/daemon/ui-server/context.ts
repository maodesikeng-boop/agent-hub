import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  PEER_CLIENT_SCOPE_HEADER,
  SESSION_MAX_AGE_MS,
  serverInfoFor,
  uiCookieName,
  type Ledger,
  type ServerInfo,
  type WsServerMessage,
} from "../../shared/index.ts";
import { FileActionsUnavailable, runOpenCommand, type RunOpen } from "../open-file.ts";
import { createFolderPicker, type FolderPicker } from "../pick-folder.ts";
import { migrate, openDatabase, type Db } from "../store/index.ts";
import type { RequestContext } from "./entry.ts";
import { digest, readCookie } from "./http.ts";
import { createBrowserSessions, createLoginLinks } from "./sessions.ts";
import { UI_TOKEN_PATTERN } from "./token.ts";
import type { UiServerOptions } from "./types.ts";

export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const COOKIE_MAX_AGE_SECONDS = SESSION_MAX_AGE_MS / 1000;
const WS_CLOSE_UNAUTHORIZED = 1008;

type ClosableSocket = { close(code?: number, reason?: string): void };
type TrackedSocket = ClosableSocket & { once(event: "close", fn: () => void): unknown };

export interface UiCtx {
  opts: UiServerOptions;
  ledger: Ledger;
  app: FastifyInstance;
  serverInfo: ServerInfo;
  runOpen: RunOpen;
  instanceId: string;
  auth: { expectedToken: Buffer };
  ownedDb: Db | undefined;
  sessions: ReturnType<typeof createBrowserSessions>;
  loginLinks: ReturnType<typeof createLoginLinks>;
  wsSenders: Set<(message: WsServerMessage) => void>;
  socketsBySession: Map<string, Set<ClosableSocket>>;
  contexts: WeakMap<IncomingMessage, RequestContext>;
  folderPicker: FolderPicker;
}

export function createUiCtx(opts: UiServerOptions): UiCtx {
  const serverInfo = opts.serverInfo ?? { ...serverInfoFor(process.platform, { supervised: opts.selfReload !== undefined }), repoDir: ROOT_DIR };
  const runOpen: RunOpen =
    opts.runOpen ??
    (serverInfo.fileActions
      ? runOpenCommand
      : async () => {
          throw new FileActionsUnavailable();
        });
  if (!UI_TOKEN_PATTERN.test(opts.token)) throw new Error("ui token must be at least 16 characters of [A-Za-z0-9_-]");
  const instanceId = randomUUID();
  const expectedToken = digest(opts.token);
  let ownedDb: Db | undefined;
  if (opts.db === undefined) {
    ownedDb = openDatabase(":memory:");
    migrate(ownedDb);
  }
  const sessions = createBrowserSessions((opts.db ?? ownedDb)!, { ...(opts.now ? { now: opts.now } : {}) });
  const loginLinks = createLoginLinks({ ...(opts.now ? { now: opts.now } : {}) });
  const folderPicker = opts.folderPicker ?? createFolderPicker({ available: serverInfo.folderPicker });
  return {
    opts,
    ledger: opts.ledger,
    app: Fastify({ logger: opts.logger ?? false }),
    serverInfo,
    runOpen,
    instanceId,
    auth: { expectedToken },
    ownedDb,
    sessions,
    loginLinks,
    wsSenders: new Set(),
    socketsBySession: new Map(),
    contexts: new WeakMap(),
    folderPicker,
  };
}

export function broadcastResync(c: UiCtx): void {
  for (const send of c.wsSenders) send({ type: "resync" });
}

export function closeSockets(c: UiCtx, sessionId?: string): void {
  for (const [id, sockets] of c.socketsBySession) {
    if (sessionId !== undefined && id !== sessionId) continue;
    for (const socket of sockets) socket.close(WS_CLOSE_UNAUTHORIZED, "unauthorized");
    c.socketsBySession.delete(id);
  }
}

export const contextOf = (c: UiCtx, req: FastifyRequest) => c.contexts.get(req.raw);

export function sessionOf(c: UiCtx, req: FastifyRequest): string | undefined {
  const identity = contextOf(c, req)?.identity;
  return identity?.kind === "cookie" ? identity.sessionId : undefined;
}

export function peerOf(c: UiCtx, req: FastifyRequest) {
  const identity = contextOf(c, req)?.identity;
  return identity?.kind === "meshDevice" ? identity.peer : undefined;
}

export function clientOwnerKeyOf(c: UiCtx, req: FastifyRequest): string {
  const identity = contextOf(c, req)?.identity;
  if (identity?.kind === "cookie") return `session:${identity.sessionId}`;
  if (identity?.kind === "meshDevice") {
    const rawScope = req.headers[PEER_CLIENT_SCOPE_HEADER];
    const scope = typeof rawScope === "string" && /^[0-9a-f]{16,64}$/u.test(rawScope) ? rawScope : null;
    return scope ? `peer:${identity.peer}:${scope}` : `peer:${identity.peer}`;
  }
  return "anonymous";
}

export function trackSocket(c: UiCtx, req: FastifyRequest, socket: TrackedSocket): void {
  const sessionId = sessionOf(c, req);
  if (sessionId === undefined) return;
  const sockets = c.socketsBySession.get(sessionId) ?? new Set();
  sockets.add(socket);
  c.socketsBySession.set(sessionId, sockets);
  socket.once("close", () => {
    sockets.delete(socket);
    if (sockets.size === 0 && c.socketsBySession.get(sessionId) === sockets) c.socketsBySession.delete(sessionId);
  });
}

export function listeningPort(c: UiCtx): number | undefined {
  const addr = c.app.server.address();
  return addr !== null && typeof addr === "object" ? addr.port : c.opts.port;
}

export const sessionToken = (req: FastifyRequest) => readCookie(req.headers.cookie, uiCookieName(req.headers.host));

/** Secure cannot be set on http://127.0.0.1 or browsers drop the cookie. */
export const sessionCookie = (req: FastifyRequest, value: string, maxAgeSeconds: number) =>
  `${uiCookieName(req.headers.host)}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;

export function startSession(c: UiCtx, req: FastifyRequest, reply: FastifyReply) {
  const previous = c.sessions.authenticate(sessionToken(req));
  if (previous !== null) {
    c.sessions.revoke(previous.id);
    closeSockets(c, previous.id);
  }
  const session = c.sessions.create({ userAgent: req.headers["user-agent"] ?? "", entry: (req.headers.host ?? "").toLowerCase() });
  for (const id of session.evicted) closeSockets(c, id);
  reply.header("set-cookie", sessionCookie(req, session.token, COOKIE_MAX_AGE_SECONDS)).header("referrer-policy", "no-referrer");
  return session;
}

export const clientAddress = (c: UiCtx, req: FastifyRequest) => (contextOf(c, req)?.rule.sameMachine ? req.ip : undefined);
