import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { resolveChangeStreamRequest } from "../../shared/change-stream.ts";
import { API_PATHS, type WsServerMessage } from "../../shared/index.ts";
import { parsePresence } from "../push/presence.ts";
import { keepAlive } from "../ws-keepalive.ts";
import { peerOf, sessionOf, trackSocket, type UiCtx } from "./context.ts";

const onceClosed = (socket: WebSocket, fn: () => void) => {
  socket.once("close", fn);
  socket.once("error", fn);
};

function attachPresence(c: UiCtx, socket: WebSocket, req: FastifyRequest): void {
  const push = c.opts.push;
  if (push === undefined || sessionOf(c, req) === undefined) return;
  socket.on("message", (data: Buffer, isBinary: boolean) => {
    const message = isBinary ? null : parsePresence(data.toString("utf8"));
    if (message !== null) push.presence.report(socket, message);
  });
  onceClosed(socket, () => push.presence.remove(socket));
}

function catchUp(c: UiCtx, socket: WebSocket, req: FastifyRequest, since: number, send: (message: WsServerMessage) => void, unsubscribe: () => void): void {
  try {
    const result = c.ledger.changesSince(since);
    if (result.kind === "resync") return send({ type: "resync" });
    for (const change of result.changes) send(change);
  } catch (err) {
    req.log.error({ err }, "ui-server websocket catch-up failed");
    unsubscribe();
    socket.close(1011, "internal_error");
  }
}

export function registerWsRoute(routes: FastifyInstance, c: UiCtx): void {
  routes.get(API_PATHS.ws, { websocket: true }, (socket, req) => {
    // injectWS requests have no req.query, so parse the URL directly.
    const streamRequest = resolveChangeStreamRequest(new URL(req.url, "http://localhost").searchParams, c.instanceId);
    const isPeerSocket = peerOf(c, req) !== undefined;
    const send = (message: WsServerMessage) => {
      if (isPeerSocket && (message.type === "router.command.created" || message.type === "router.command.updated")) return;
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };
    c.wsSenders.add(send);
    onceClosed(socket, () => c.wsSenders.delete(send));
    // The ledger is synchronous, so nothing can land between subscribe and backfill; each change is sent once in seq order.
    const unsubscribe = c.ledger.onChange(send);
    onceClosed(socket, unsubscribe);
    if (c.opts.mesh && !isPeerSocket) {
      const offAccount = c.opts.mesh.onChange(() => send({ type: "account.updated" }));
      onceClosed(socket, offAccount);
    }
    attachPresence(c, socket, req);
    trackSocket(c, req, socket);
    keepAlive(socket, c.opts.wsHeartbeatMs);

    if (streamRequest.kind === "resync") send({ type: "resync" });
    if (streamRequest.kind === "replay") catchUp(c, socket, req, streamRequest.since, send, unsubscribe);
  });
}
