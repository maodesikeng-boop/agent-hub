import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z } from "zod";
import { API_ERRORS } from "../../shared/errors.ts";
import type { PmId } from "../../shared/domain.ts";
import type { FeishuChatId } from "../../shared/feishu.ts";
import { API_PATHS, isDeviceId, type ApiErrorBody, type DeviceId, type DevicesResponse } from "../../shared/index.ts";
import type { AccountStatusView } from "../../shared/mesh.ts";
import {
  feishuForwardedEventSchema,
  feishuPeerAppSyncSchema,
  feishuPeerChatsSchema,
  type FeishuForwardedEvent,
  type FeishuPeerAppSync,
} from "../feishu/account-bot.ts";
import type { FeishuInboundStateSnapshot } from "../feishu/inbound-checkpoint.ts";
import type { FeishuCardActionResponse } from "../feishu/transport.ts";
import type { Mesh } from "../mesh/index.ts";
import { proxyHttp, proxyWebSocket, splitProxyUrl, type ProxyContext, type ProxyTarget } from "./proxy.ts";
import { PeerError, type Peers } from "./service.ts";

export interface FeishuPeerRoutesPort {
  acceptInbound(body: FeishuForwardedEvent): Promise<FeishuCardActionResponse | null>;
  learnChats(from: DeviceId, chats: { chatId: FeishuChatId; pmId: PmId }[]): void;
  exportApp(): FeishuPeerAppSync | null;
  applyApp(sync: FeishuPeerAppSync): Promise<void>;
  exportInboundState?(): FeishuInboundStateSnapshot | null;
  applyInboundState?(state: FeishuInboundStateSnapshot): void;
}

export interface PeerRoutesOptions {
  peers: Peers;
  mesh?: Pick<
    Mesh,
    "status" | "startLogin" | "cancelLogin" | "logout" | "beginApproval" | "answerApproval" | "setCenterPriority" | "trustStatements" | "receiveTrustStatements" | "leaseSnapshot"
  >;
  feishuPeer?: FeishuPeerRoutesPort;
  peerOf: (req: FastifyRequest) => DeviceId | undefined;
  clientScopeOf?: (req: FastifyRequest) => string | undefined;
  trackSocket: (req: FastifyRequest, socket: WebSocket) => void;
  proxy?: Pick<ProxyContext, "pingMs" | "heartbeatMs">;
  onChange?: () => void;
}

const fail = (reply: FastifyReply, error: PeerError) =>
  reply.code(error.statusCode).send((error.code === undefined ? { error: error.message } : { error: error.message, code: error.code }) satisfies ApiErrorBody);

const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: API_ERRORS.device_not_found.text, code: "device_not_found" } satisfies ApiErrorBody);

const accountSchemas = {
  login: z.strictObject({
    relayUrl: z.string().url("中继网址不对").optional(),
    githubClientId: z.string().min(1, "Client ID 不能为空").max(128, "Client ID 太长").optional(),
  }),
  answer: z.strictObject({ match: z.boolean({ error: "match 要是 true 或 false" }) }),
  priority: z.strictObject({ priority: z.array(z.string().refine((v) => isDeviceId(v), "设备编号不对")).max(64) }),
};

function parseOr400<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PeerError(400, issue?.code === "unrecognized_keys" ? `不认识的字段：${issue.keys[0]}` : (issue?.message ?? "请求体不对"), "invalid");
  }
  return parsed.data;
}
const asPeerError = async <T>(task: () => Promise<T>): Promise<T> => {
  try {
    return await task();
  } catch (error) {
    if (error instanceof PeerError) throw error;
    throw new PeerError(400, error instanceof Error ? error.message : String(error), "invalid");
  }
};

export async function peerRoutes(app: FastifyInstance, opts: PeerRoutesOptions): Promise<void> {
  const { peers, mesh } = opts;
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof PeerError) return fail(reply, err);
    throw err;
  });

  const requirePeer = (req: FastifyRequest): DeviceId => {
    const peer = opts.peerOf(req);
    if (peer === undefined) throw new PeerError(401, "peer_unauthorized");
    return peer;
  };
  const idParam = (req: FastifyRequest) => String((req.params as { id?: unknown }).id ?? "");

  app.get(API_PATHS.devices, async (): Promise<DevicesResponse> => ({ devices: peers.list() }));
  app.patch("/api/devices/:id", async (req) => {
    const renamed = await peers.rename(idParam(req), req.body);
    opts.onChange?.();
    return renamed;
  });
  app.delete("/api/devices/:id", async (req, reply) => {
    await peers.remove(idParam(req));
    opts.onChange?.();
    return reply.code(204).send();
  });

  if (mesh !== undefined) {
    app.get(API_PATHS.account, async (): Promise<AccountStatusView> => mesh.status());
    app.post(API_PATHS.accountLogin, async (req) => asPeerError(() => mesh.startLogin(parseOr400(accountSchemas.login, req.body))));
    app.delete(API_PATHS.accountLogin, async () => {
      mesh.cancelLogin();
      return mesh.status();
    });
    app.post(API_PATHS.accountLogout, async () => {
      await mesh.logout();
      opts.onChange?.();
      return mesh.status();
    });
    app.post("/api/account/approvals/:id/begin", async (req) => asPeerError(() => mesh.beginApproval(idParam(req))));
    app.post("/api/account/approvals/:id/answer", async (req) => {
      const { match } = parseOr400(accountSchemas.answer, req.body);
      return asPeerError(() => mesh.answerApproval(idParam(req), match));
    });
    app.put(API_PATHS.accountPriority, async (req) => {
      const { priority } = parseOr400(accountSchemas.priority, req.body);
      await asPeerError(() => mesh.setCenterPriority(priority));
      return mesh.status();
    });
  }

  app.put(API_PATHS.peerName, async (req, reply) => {
    requirePeer(req);
    peers.renameSelf(req.body);
    opts.onChange?.();
    return reply.code(204).send();
  });
  app.put(API_PATHS.peerRenamed, async (req, reply) => {
    peers.receiveRenamed(requirePeer(req), req.body);
    opts.onChange?.();
    return reply.code(204).send();
  });
  if (mesh !== undefined) {
    app.get(API_PATHS.peerTrust, async (req) => {
      requirePeer(req);
      return { statements: mesh.trustStatements() };
    });
    if (typeof mesh.leaseSnapshot === "function") {
      app.get(API_PATHS.peerLease, async (req) => {
        requirePeer(req);
        return mesh.leaseSnapshot();
      });
    }
    app.post(API_PATHS.peerTrust, async (req, reply) => {
      const from = requirePeer(req);
      try {
        mesh.receiveTrustStatements(from, req.body);
      } catch (error) {
        throw new PeerError(400, error instanceof Error ? error.message : "statements 不对", "invalid");
      }
      opts.onChange?.();
      return reply.code(204).send();
    });
  }
  if (opts.feishuPeer !== undefined) {
    const feishuPeer = opts.feishuPeer;
    app.post(API_PATHS.peerFeishuInbound, async (req) => {
      requirePeer(req);
      const body = parseOr400(feishuForwardedEventSchema, req.body);
      return (await feishuPeer.acceptInbound(body)) ?? {};
    });
    app.post(API_PATHS.peerFeishuChats, async (req, reply) => {
      const from = requirePeer(req);
      const { chats } = parseOr400(feishuPeerChatsSchema, req.body);
      feishuPeer.learnChats(from, chats);
      return reply.code(204).send();
    });
    app.get(API_PATHS.peerFeishuApp, async (req) => {
      requirePeer(req);
      return { app: feishuPeer.exportApp() };
    });
    app.put(API_PATHS.peerFeishuApp, async (req, reply) => {
      requirePeer(req);
      const sync = parseOr400(feishuPeerAppSyncSchema, req.body);
      await feishuPeer.applyApp(sync);
      return reply.code(204).send();
    });
  }

  // A separate plugin so request bodies stream through unparsed.
  app.register(async (proxy) => {
    proxy.removeAllContentTypeParsers();
    proxy.addContentTypeParser("*", (_req, _payload, done) => done(null));

    const resolve = (req: FastifyRequest): { target: ProxyTarget; rest: string } | null => {
      const split = splitProxyUrl(req.url);
      const target = split === null ? null : peers.target(split.device);
      return split === null || target === null ? null : { target, rest: split.rest };
    };

    // Check the device before upgrading; unknown devices get 404 without a WebSocket.
    proxy.get(
      `/d/:id${API_PATHS.ws}`,
      {
        websocket: true,
        preHandler: async (req, reply) => {
          if (resolve(req) === null) return notFound(reply);
        },
      },
      (socket, req) => {
        const resolved = resolve(req);
        if (resolved === null) return socket.close(4404, "not_found");
        opts.trackSocket(req, socket);
        proxyWebSocket(socket, resolved.target, resolved.rest, { ...opts.proxy });
      },
    );

    proxy.all("/d/*", async (req, reply) => {
      const resolved = resolve(req);
      if (resolved === null) return notFound(reply);
      const clientScope = opts.clientScopeOf?.(req);
      return proxyHttp(req, reply, resolved.target, resolved.rest, { ...opts.proxy, ...(clientScope !== undefined ? { clientScope } : {}) });
    });
  });
}
