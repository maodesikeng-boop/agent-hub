import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  API_PATHS,
  LedgerRequestError,
  SELF_RELOAD_UNSUPPORTED_MESSAGE,
  serverInfoForClient,
  type BrowserSessionsResponse,
  type LoginLinkResponse,
  type SelfReloadRequestBody,
  type SelfReloadResponse,
  type SelfReloadStatus,
  type StateSnapshot,
} from "../../shared/index.ts";
import { peerRoutes } from "../peers/index.ts";
import {
  broadcastResync,
  clientAddress,
  clientOwnerKeyOf,
  closeSockets,
  contextOf,
  peerOf,
  sessionCookie,
  sessionOf,
  startSession,
  trackSocket,
  type UiCtx,
} from "./context.ts";
import { digest, fail, parseWithSchema, tokenEquals } from "./http.ts";
import { LOGIN_LINK_FRAGMENT_KEY, LOGIN_LINK_PAGE } from "./login-page.ts";
import { selfReloadBodySchema } from "./schemas.ts";
import { UI_TOKEN_PATTERN, newUiToken } from "./token.ts";
import { DESKTOP_PRODUCT, DESKTOP_PROTOCOL_VERSION, type DesktopAuthStatusResponse, type DesktopHealthResponse } from "./types.ts";

function registerLoginRoutes(routes: FastifyInstance, c: UiCtx): void {
  const { sessions, loginLinks } = c;
  routes.get(API_PATHS.auth, async (req, reply) => {
    const { token, link } = req.query as { token?: unknown; link?: unknown };
    if (token === undefined && link === undefined) return reply.type("text/html; charset=utf-8").header("referrer-policy", "no-referrer").send(LOGIN_LINK_PAGE);
    if (token === undefined || link !== undefined || !tokenEquals(c.auth.expectedToken, token)) return fail(reply, "unauthorized");
    startSession(c, req, reply);
    return reply.redirect("/", 302);
  });

  routes.post(API_PATHS.auth, async (req, reply) => {
    const body = (req.body ?? {}) as { link?: unknown; token?: unknown };
    if (body.token !== undefined && body.link === undefined) {
      if (!tokenEquals(c.auth.expectedToken, body.token)) return fail(reply, "unauthorized");
      startSession(c, req, reply);
      return reply.code(204).send();
    }
    if (!loginLinks.consume(body.link)) return fail(reply, "unauthorized");
    startSession(c, req, reply);
    return reply.code(204).send();
  });

  routes.get(API_PATHS.authStatus, async (req): Promise<DesktopAuthStatusResponse> => {
    const identity = contextOf(c, req)?.identity;
    const status = identity?.kind === "cookie" ? "active" : "unauthenticated";
    return {
      status,
      product: DESKTOP_PRODUCT,
      protocolVersion: DESKTOP_PROTOCOL_VERSION,
      instanceId: c.instanceId,
    };
  });

  routes.get(API_PATHS.health, async (): Promise<DesktopHealthResponse> => ({
    ok: true,
    product: DESKTOP_PRODUCT,
    protocolVersion: DESKTOP_PROTOCOL_VERSION,
    instanceId: c.instanceId,
  }));

  routes.get(API_PATHS.browserSessions, async (req): Promise<BrowserSessionsResponse> => {
    const current = sessionOf(c, req);
    return { sessions: sessions.list().map((s) => ({ ...s, current: s.id === current })) };
  });

  routes.delete("/api/sessions/:id", async (req, reply) => {
    const id = String((req.params as { id?: unknown }).id ?? "");
    if (!sessions.revoke(id)) return fail(reply, "not_found");
    closeSockets(c, id);
    if (id === sessionOf(c, req)) reply.header("set-cookie", sessionCookie(req, "", 0));
    return reply.code(204).send();
  });

  routes.post(API_PATHS.logoutAll, async (req, reply) => {
    const next = c.opts.rotateToken?.() ?? newUiToken();
    if (!UI_TOKEN_PATTERN.test(next)) throw new Error("rotated ui token must be at least 16 characters of [A-Za-z0-9_-]");
    c.auth.expectedToken = digest(next);
    sessions.revokeAll();
    loginLinks.clear();
    closeSockets(c);
    return reply.header("set-cookie", sessionCookie(req, "", 0)).code(204).send();
  });

  routes.post(API_PATHS.loginLinks, async (req, reply) => {
    const { code, expiresAt } = loginLinks.issue();
    const origin = `http://${req.headers.host}`;
    return reply.code(201).send({ url: `${origin}/auth#${LOGIN_LINK_FRAGMENT_KEY}=${code}`, expiresAt } satisfies LoginLinkResponse);
  });
}

const idleSelfReload = (): SelfReloadStatus => ({
  state: "idle",
  build: false,
  requestedAt: null,
  deadlineAt: null,
  overdue: false,
  busy: [],
  unresumable: [],
  lastFailure: null,
});

export function registerSessionRoutes(routes: FastifyInstance, c: UiCtx): void {
  const { opts, ledger } = c;
  registerLoginRoutes(routes, c);

  if (opts.peers !== undefined) {
    routes.register(peerRoutes, {
      peers: opts.peers,
      ...(opts.mesh ? { mesh: opts.mesh } : {}),
      ...(opts.feishuPeer ? { feishuPeer: opts.feishuPeer } : {}),
      peerOf: (req) => peerOf(c, req),
      clientScopeOf: (req) => createHash("sha256").update(clientOwnerKeyOf(c, req)).digest("hex").slice(0, 24),
      trackSocket: (req, socket) => trackSocket(c, req, socket),
      onChange: () => broadcastResync(c),
      ...(opts.peerProxy ? { proxy: opts.peerProxy } : {}),
    });
  }

  routes.post(API_PATHS.selfReload, async (req): Promise<SelfReloadResponse> => {
    const body: SelfReloadRequestBody = parseWithSchema(selfReloadBodySchema, req.body ?? {});
    if (!opts.selfReload) throw new LedgerRequestError("conflict", SELF_RELOAD_UNSUPPORTED_MESSAGE);
    return opts.selfReload.request({ build: body.build === true, by: "网页" });
  });

  routes.get(API_PATHS.selfReload, async (): Promise<SelfReloadStatus> => opts.selfReload?.status() ?? idleSelfReload());

  routes.get(API_PATHS.state, async (req): Promise<StateSnapshot> => {
    const snap = ledger.snapshot();
    const router = peerOf(c, req) !== undefined ? { ...snap.router, commands: [], commandsHasMore: false } : snap.router;
    return {
      ...snap,
      router,
      server: serverInfoForClient(c.serverInfo, clientAddress(c, req)),
      bootId: c.instanceId,
    };
  });
}
