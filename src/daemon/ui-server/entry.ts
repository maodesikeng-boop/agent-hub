import type { IncomingMessage } from "node:http";
import type { FastifyError, FastifyRequest } from "fastify";
import {
  API_PATHS,
  ConversationNotFoundError,
  DEVICE_PROXY_PREFIX,
  ENTRY_ONLY_API_PREFIXES,
  LedgerRequestError,
  type DeviceId,
} from "../../shared/index.ts";
import { FeishuSetupError } from "../feishu/setup.ts";
import { isCompressibleType } from "../peers/index.ts";
import { PickFolderError } from "../pick-folder.ts";
import { ProviderRequestError } from "../provider-manager/index.ts";
import { RouterTargetError } from "../router/index.ts";
import { UploadError } from "../uploads.ts";
import { listeningPort, sessionToken, type UiCtx } from "./context.ts";
import { codeOfStatus, fail } from "./http.ts";

const HOST_HEADER = /^(?:127\.0\.0\.1|localhost):(\d+)$/i;
const ORIGIN_HEADER = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)$/i;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type Listener = "uiPort" | "mesh";
export const listenerOf = new WeakMap<IncomingMessage, Listener>();
export const meshPeerOf = new WeakMap<object, DeviceId>();

type Entry = { kind: "loopback" } | { kind: "mesh" };
type EntryKind = Entry["kind"];

type Identity = { kind: "cookie"; sessionId: string } | { kind: "meshDevice"; peer: DeviceId } | { kind: "none" };
type IdentityKind = Exclude<Identity["kind"], "none">;

type EntryRejection = "forbidden_host" | "forbidden_identity";

interface EntryRule {
  listeners: readonly Listener[];
  host: ((req: FastifyRequest) => Entry | EntryRejection | null) | null;
  origin: ((origin: string, entry: Entry) => boolean) | null;
  identities: readonly IdentityKind[];
  sameMachine: boolean;
  browserPaths: boolean;
}

export interface RequestContext {
  entry: Entry;
  rule: EntryRule;
  identity: Identity;
}

const pathOf = (req: FastifyRequest) => req.url.split("?", 1)[0] ?? "";
const inDeviceScope = (path: string) => path.startsWith("/api/") && !ENTRY_ONLY_API_PREFIXES.some((prefix) => path.startsWith(prefix));
const isUpgrade = (req: FastifyRequest) => (req.headers.upgrade ?? "").toLowerCase() === "websocket";

function createEntryRules(c: UiCtx): Record<EntryKind, EntryRule> {
  const isLoopbackOrigin = (origin: string) => {
    const match = ORIGIN_HEADER.exec(origin);
    const port = listeningPort(c);
    return match !== null && port !== undefined && match[1] === String(port);
  };
  return {
    // DNS rebinding protection applies to every path, including static files and /auth.
    loopback: {
      listeners: ["uiPort"],
      host: (req) => {
        const local = HOST_HEADER.exec(req.headers.host ?? "");
        if (local === null) return null;
        const port = listeningPort(c);
        return port !== undefined && Number(local[1]) === port ? { kind: "loopback" } : "forbidden_host";
      },
      origin: isLoopbackOrigin,
      identities: ["cookie"],
      sameMachine: true,
      browserPaths: true,
    },
    // Mesh peers are identified by their TLS certificate; Host and Origin are attacker-controlled and cookies are ignored.
    mesh: {
      listeners: ["mesh"],
      host: null,
      origin: null,
      identities: ["meshDevice"],
      sameMachine: false,
      browserPaths: false,
    },
  };
}

function resolveEntry(entryRules: Record<EntryKind, EntryRule>, entryKinds: readonly EntryKind[], req: FastifyRequest): Entry | EntryRejection {
  const listener = listenerOf.get(req.raw) ?? "uiPort";
  for (const kind of entryKinds) {
    const rule = entryRules[kind];
    if (!rule.listeners.includes(listener)) continue;
    const entry = rule.host === null ? ({ kind } as Entry) : rule.host(req);
    if (entry !== null) return entry;
  }
  return "forbidden_host";
}

function installAuthHook(c: UiCtx): void {
  const { app, opts, sessions } = c;
  const entryRules = createEntryRules(c);
  const entryKinds = Object.keys(entryRules) as EntryKind[];
  app.addHook("onRequest", async (req, reply) => {
    const entry = resolveEntry(entryRules, entryKinds, req);
    if (typeof entry === "string") return fail(reply, entry);
    const rule = entryRules[entry.kind];
    const path = pathOf(req);
    reply.header("cache-control", "no-store");

    if (!rule.identities.includes("meshDevice") && path.startsWith("/api/peer/")) return fail(reply, "forbidden_peer");

    // A device removed from the trust table after its handshake is rejected here.
    let identity: Identity = { kind: "none" };
    if (rule.identities.includes("meshDevice")) {
      const peer = meshPeerOf.get(req.raw.socket);
      if (peer === undefined || opts.mesh?.trust.get(peer) === undefined || opts.peers === undefined) return fail(reply, "peer_unauthorized");
      identity = { kind: "meshDevice", peer };
      if (!inDeviceScope(path)) return fail(reply, "forbidden_peer");
    }

    if (identity.kind === "none") {
      // Browsers treat other localhost ports as same-site, so SameSite=Strict does not stop them; state-changing requests and WebSocket handshakes require a matching Origin.
      const unsafe = !SAFE_METHODS.has(req.method) || path === API_PATHS.ws || isUpgrade(req);
      if (unsafe && rule.origin !== null && !rule.origin(req.headers.origin ?? "", entry)) return fail(reply, "forbidden_origin");

      if (path.startsWith("/api/") || path.startsWith(`${DEVICE_PROXY_PREFIX}/`)) {
        const session = sessions.authenticate(sessionToken(req));
        if (session === null) {
          if (!(req.method === "GET" && path === API_PATHS.authStatus)) {
            return fail(reply, "unauthorized");
          }
        } else {
          identity = { kind: "cookie", sessionId: session.id };
        }
      }
    }
    c.contexts.set(req.raw, { entry, rule, identity });
  });
}

function installResponseHooks(c: UiCtx): void {
  c.app.addHook("onSend", async (req, reply, payload) => {
    if (
      payload !== null &&
      payload !== undefined &&
      req.method !== "HEAD" &&
      !req.headers["x-no-compression"] &&
      reply.statusCode !== 204 &&
      reply.statusCode !== 205 &&
      reply.statusCode !== 206 &&
      reply.statusCode !== 304 &&
      reply.getHeader("accept-ranges") === undefined &&
      reply.getHeader("content-range") === undefined &&
      isCompressibleType(reply.getHeader("content-type"))
    ) {
      const existing = reply.getHeader("vary");
      reply.header("vary", existing === undefined ? "Accept-Encoding" : `${String(existing)}, Accept-Encoding`);
    }
    return payload;
  });

  // @fastify/websocket's hook never runs after this hook rejects, so close the socket here or it hangs until shutdown.
  c.app.addHook("onResponse", async (req) => {
    if (isUpgrade(req)) req.raw.socket.destroy();
  });
}

type UiRequestError = FastifyError | ConversationNotFoundError | LedgerRequestError | RouterTargetError | UploadError | PickFolderError | ProviderRequestError | FeishuSetupError;

const routerTargetApiCode = (code: RouterTargetError["code"]) =>
  code === "not_found" || code === "device_not_found" ? "not_found" : code === "forbidden" ? "forbidden" : code === "invalid" ? "invalid" : "conflict";

function installErrorHandlers(c: UiCtx): void {
  c.app.setErrorHandler((err: UiRequestError, req, reply) => {
    const reason = err.message;
    if (err instanceof PickFolderError) return fail(reply, codeOfStatus(err.statusCode), reason);
    if (err instanceof ProviderRequestError) return fail(reply, codeOfStatus(err.statusCode), reason);
    if (err instanceof ConversationNotFoundError) return fail(reply, "not_found");
    if (err instanceof UploadError) return fail(reply, codeOfStatus(err.statusCode), reason);
    if (err instanceof LedgerRequestError) return fail(reply, err.code, reason);
    if (err instanceof RouterTargetError) return fail(reply, routerTargetApiCode(err.code), reason);
    if (err instanceof FeishuSetupError) return fail(reply, "invalid", reason);
    const status = (err as FastifyError).statusCode;
    if (status === 413) return fail(reply, "too_large");
    if (status !== undefined && status >= 400 && status < 500) {
      req.log.warn({ err }, "ui-server bad request");
      return fail(reply, codeOfStatus(status));
    }
    req.log.error({ err }, "ui-server request failed");
    return fail(reply, "internal");
  });
  c.app.setNotFoundHandler((_req, reply) => fail(reply, "not_found"));
}

export function installEntryHooks(c: UiCtx): void {
  installAuthHook(c);
  installResponseHooks(c);
  installErrorHandlers(c);
}
