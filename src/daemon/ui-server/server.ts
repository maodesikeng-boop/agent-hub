import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import fastifyCompress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { MeshConnection } from "../mesh/index.ts";
import { isCompressibleType } from "../peers/index.ts";
import { createUiCtx } from "./context.ts";
import { installEntryHooks, listenerOf, meshPeerOf } from "./entry.ts";
import { registerCapabilityRoutes } from "./routes-capabilities.ts";
import { registerCatalogRoutes } from "./routes-catalog.ts";
import { registerConversationRoutes } from "./routes-conversations.ts";
import { registerIntegrationRoutes } from "./routes-integrations.ts";
import { registerPmRoutes } from "./routes-pms.ts";
import { registerResourceRoutes } from "./routes-resources.ts";
import { registerRouterRoutes } from "./routes-router.ts";
import { registerSandboxApprovalRoutes } from "./routes-sandbox-approvals.ts";
import { registerSessionRoutes } from "./routes-session.ts";
import { registerUpdateRoutes } from "./routes-update.ts";
import { registerWsRoute } from "./routes-ws.ts";
import { registerStoredFileRoutes } from "./stored-files.ts";
import type { UiServerOptions } from "./types.ts";

export { ROOT_DIR } from "./context.ts";
export { DESKTOP_PRODUCT, DESKTOP_PROTOCOL_VERSION } from "./types.ts";
export type { UiServerOptions } from "./types.ts";

export function createUiServer(opts: UiServerOptions): FastifyInstance {
  const c = createUiCtx(opts);
  const { app } = c;
  installEntryHooks(c);

  app.register(fastifyCompress, {
    global: true,
    threshold: 1024,
    encodings: ["gzip", "deflate"],
    customTypes: isCompressibleType,
  });
  app.register(fastifyWebsocket);
  app.addHook("onClose", async () => {
    if (c.ownedDb !== undefined) c.ownedDb.close();
  });

  registerStoredFileRoutes(c);

  if (existsSync(opts.staticDir)) {
    app.register(fastifyStatic, { root: opts.staticDir });
  } else {
    app.log.warn(`static dir ${opts.staticDir} does not exist, serving API only`);
  }

  // @fastify/websocket's onRoute hook only sees routes registered after it, so routes live inside a plugin.
  app.register(async (routes) => {
    registerSessionRoutes(routes, c);
    registerCatalogRoutes(routes, c);
    registerConversationRoutes(routes, c);
    registerPmRoutes(routes, c);
    registerCapabilityRoutes(routes, c);
    registerRouterRoutes(routes, c);
    registerSandboxApprovalRoutes(routes, c);
    registerIntegrationRoutes(routes, c);
    registerResourceRoutes(routes, c);
    registerUpdateRoutes(routes, c);
    registerWsRoute(routes, c);
  });

  return app;
}

export interface RunningUiServer {
  app: FastifyInstance;
  port: number;
  acceptMeshConnection(connection: MeshConnection): void;
  close(): Promise<void>;
}

export async function startUiServer(opts: UiServerOptions & { port: number }): Promise<RunningUiServer> {
  const app = createUiServer(opts);
  await app.listen({ host: "127.0.0.1", port: opts.port });
  const addr = app.server.address();
  if (addr === null || typeof addr !== "object") throw new Error("ui-server is not listening on a TCP port");
  const meshServer: Server = createServer((req, res) => {
    listenerOf.set(req, "mesh");
    app.routing(req, res);
  });
  meshServer.on("upgrade", (req: IncomingMessage, socket, head) => {
    listenerOf.set(req, "mesh");
    app.server.emit("upgrade", req, socket, head);
  });
  const close = async () => {
    // Close Fastify first to drop WebSockets, then the remaining mesh connections.
    await app.close();
    meshServer.closeAllConnections();
  };
  return {
    app,
    port: addr.port,
    acceptMeshConnection(connection) {
      meshPeerOf.set(connection.socket, connection.peer.id);
      meshServer.emit("connection", connection.socket);
    },
    close,
  };
}
