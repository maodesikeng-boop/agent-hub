// 联机的接口（shared/api.ts 的 API_PATHS）：浏览器管设备（/api/devices*）、设备之间（/api/peer/*）、入口转发（/d/<设备>/api/*）。
// 谁能访问由 ui-server/server.ts 的钩子先管：/api/devices* 和 /d/ 只认浏览器 cookie；/api/peer/* 只认设备令牌（pair 凭邀请码）。
// 这里注册在 server.ts 的路由插件里（@fastify/websocket 之后）。
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { API_ERRORS } from "../../shared/errors.ts";
import { API_PATHS, type ApiErrorBody, type DevicesResponse } from "../../shared/index.ts";
import { proxyHttp, proxyWebSocket, splitProxyUrl, type ProxyContext, type ProxyTarget } from "./proxy.ts";
import { PeerError, type Peers } from "./service.ts";
import type { PeerRecord } from "./store.ts";

export interface PeerRoutesOptions {
  peers: Peers;
  /** 这次请求是哪台设备带令牌来的（server.ts 的认证钩子认出来的）；浏览器来的是 undefined。 */
  peerOf: (req: FastifyRequest) => PeerRecord | undefined;
  /** 浏览器经入口连别的设备的 WebSocket：记到它的会话下，退出登录时一起关。 */
  trackSocket: (req: FastifyRequest, socket: WebSocket) => void;
  /** 转发的可调项：fetch、WebSocket 心跳间隔（测试里换）。 */
  proxy?: Pick<ProxyContext, "fetch" | "pingMs" | "heartbeatMs">;
  /** 设备列表或名字变化后通知（如给已连的 WebSocket 推 resync）。 */
  onChange?: () => void;
}

const fail = (reply: FastifyReply, error: PeerError) =>
  reply.code(error.statusCode).send((error.code === undefined ? { error: error.message } : { error: error.message, code: error.code }) satisfies ApiErrorBody);

const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ error: API_ERRORS.device_not_found.text, code: "device_not_found" } satisfies ApiErrorBody);

export async function peerRoutes(app: FastifyInstance, opts: PeerRoutesOptions): Promise<void> {
  const { peers } = opts;
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof PeerError) return fail(reply, err);
    throw err;
  });

  /** /api/peer/* 里要设备令牌的：钩子已经拦过，这里再确认一次并取出是哪台。 */
  const requirePeer = (req: FastifyRequest): PeerRecord => {
    const peer = opts.peerOf(req);
    if (peer === undefined) throw new PeerError(401, "peer_unauthorized");
    return peer;
  };
  const idParam = (req: FastifyRequest) => String((req.params as { id?: unknown }).id ?? "");

  // ---- 浏览器 → 入口：管设备 ----
  app.get(API_PATHS.devices, async (): Promise<DevicesResponse> => ({ devices: peers.list() }));
  app.post(API_PATHS.devices, async (req, reply) => {
    const added = await peers.add(req.body);
    opts.onChange?.();
    return reply.code(201).send(added);
  });
  app.post(API_PATHS.deviceInvites, async (_req, reply) => reply.code(201).send(peers.createInvite()));
  app.patch("/api/devices/:id", async (req) => {
    const renamed = await peers.rename(idParam(req), req.body);
    opts.onChange?.();
    return renamed;
  });
  app.delete("/api/devices/:id", async (req, reply) => {
    peers.remove(idParam(req));
    opts.onChange?.();
    return reply.code(204).send();
  });

  // ---- 设备 → 设备 ----
  app.post(API_PATHS.peerPair, async (req) => {
    const paired = peers.acceptPair(req.body);
    opts.onChange?.();
    return paired;
  });
  app.put(API_PATHS.peerDevices, async (req, reply) => {
    peers.receiveDeviceList(requirePeer(req).id, req.body);
    opts.onChange?.();
    return reply.code(204).send();
  });
  app.post(API_PATHS.peerUnpair, async (req, reply) => {
    peers.receiveUnpair(requirePeer(req).id);
    opts.onChange?.();
    return reply.code(204).send();
  });
  app.post(API_PATHS.peerInvites, async (req, reply) => reply.code(201).send(peers.inviteFor(requirePeer(req).id, req.body)));
  app.post(API_PATHS.peerIntroductions, async (req) => {
    const introduced = await peers.introduce(requirePeer(req).id, req.body);
    opts.onChange?.();
    return introduced;
  });
  app.put(API_PATHS.peerName, async (req, reply) => {
    requirePeer(req);
    peers.renameSelf(req.body);
    opts.onChange?.();
    return reply.code(204).send();
  });

  // ---- 入口转发：/d/<设备>/api/* ----
  // 单独一个插件：请求体不解析，原样流给对方（上传最大 20 MB，不在入口落地）
  app.register(async (proxy) => {
    proxy.removeAllContentTypeParsers();
    proxy.addContentTypeParser("*", (_req, _payload, done) => done(null));

    /** 地址合规、设备认识 → 转发目标；不然回 404（未知设备、../ 之类都一样，不多说）。 */
    const resolve = (req: FastifyRequest): { target: ProxyTarget; rest: string; id: string } | null => {
      const split = splitProxyUrl(req.url);
      const target = split === null ? null : peers.target(split.device);
      return split === null || target === null ? null : { target, rest: split.rest, id: split.device };
    };
    const contextFor = (id: string): ProxyContext => ({
      ...opts.proxy,
      selfId: peers.selfId,
      forget: () => {
        peers.forget(id);
        opts.onChange?.();
      },
    });

    // WebSocket（/d/<设备>/api/ws?since=）：握手前先查设备，不认识就 404，不升级
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
        proxyWebSocket(socket, resolved.target, resolved.rest, contextFor(resolved.id));
      },
    );

    proxy.all("/d/*", async (req, reply) => {
      const resolved = resolve(req);
      if (resolved === null) return notFound(reply);
      return proxyHttp(req, reply, resolved.target, resolved.rest, contextFor(resolved.id));
    });
  });
}
