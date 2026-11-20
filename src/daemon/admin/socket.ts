// Local admin socket for terminal tools; it also requires the UI token because agents run as the same OS user and file modes alone cannot stop them.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { z } from "zod";
import { isDeviceId } from "../../shared/api.ts";
import { ADMIN_SOCKET_MAX_BODY_BYTES } from "../../shared/limits.ts";
import { FeishuSetupError, feishuChatPolicyBodySchema, feishuCredentialsSchema, feishuDisconnectSchema, type FeishuSetupService } from "../feishu/setup.ts";
import type { Mesh } from "../mesh/index.ts";
import { listenOnRunSocket } from "../run-socket.ts";

export interface AdminSocketOptions {
  runDir: string;
  socketPath: string;
  authorize(token: string): boolean;
  feishu?: () => FeishuSetupService | undefined;
  mesh?: () => Mesh | undefined;
  /** Desktop shells request graceful shutdown here because Windows cannot deliver SIGTERM to the daemon. */
  onShutdown?: () => void;
  /** Requests get 503 until hardening (Windows pipe DENY FusaWorker) finishes; on failure the socket closes instead of serving unprotected. */
  secure?: (socketPath: string) => Promise<void>;
  log?: (line: string) => void;
}

export class AdminSocketInsecureError extends Error {
  constructor(socketPath: string, cause: unknown) {
    super(`管理 socket ${socketPath} 加固失败，已关掉：${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "AdminSocketInsecureError";
  }
}

export interface RunningAdminSocket {
  socketPath: string;
  close(): Promise<void>;
}

class BadRequest extends Error {}

type Route = (body: Record<string, unknown>) => Promise<unknown> | unknown;

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > ADMIN_SOCKET_MAX_BODY_BYTES) {
        chunks.length = 0;
        req.resume();
        reject(new BadRequest("请求太大"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > ADMIN_SOCKET_MAX_BODY_BYTES) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (text === "") return resolve({});
      try {
        const value: unknown = JSON.parse(text);
        if (typeof value !== "object" || value === null || Array.isArray(value)) return reject(new BadRequest("请求体要是 JSON 对象"));
        resolve(value as Record<string, unknown>);
      } catch {
        reject(new BadRequest("请求体不是 JSON"));
      }
    });
    req.on("error", reject);
  });
}

const feishuPolicySchema = z.object({ pmId: z.number().int().positive() }).passthrough();

function feishuRoutes(get: () => FeishuSetupService | undefined): Record<string, Route> {
  const feishu = (): FeishuSetupService => {
    const service = get();
    if (service === undefined) throw new FeishuSetupError("守护进程没开飞书");
    return service;
  };
  return {
    "GET /feishu/status": () => feishu().status(),
    "POST /feishu/registration": () => feishu().startRegistration(),
    "DELETE /feishu/registration": () => feishu().cancelRegistration(),
    "PUT /feishu/credentials": (body) => feishu().saveCredentials(feishuCredentialsSchema.parse(body)),
    "POST /feishu/bind-code": () => feishu().issueBindCode(),
    "PUT /feishu/policy": (body) => {
      const { pmId, ...rest } = feishuPolicySchema.parse(body);
      return feishu().setChatPolicy({ pmId, ...feishuChatPolicyBodySchema.parse(rest) });
    },
    "POST /feishu/resync": () => feishu().resync(),
    "POST /feishu/disconnect": (body) => feishu().disconnect(feishuDisconnectSchema.parse(body)),
  };
}

const deviceIdSchema = z.string().refine((v) => isDeviceId(v), "设备编号不对");
const meshSchemas = {
  login: z.strictObject({
    relayUrl: z.string().url("中继网址不对").optional(),
    githubClientId: z.string().min(1, "Client ID 不能为空").max(128, "Client ID 太长").optional(),
  }),
  begin: z.strictObject({ requestId: deviceIdSchema }),
  answer: z.strictObject({ requestId: deviceIdSchema, match: z.boolean() }),
  priority: z.strictObject({ priority: z.array(deviceIdSchema).max(64) }),
  remove: z.strictObject({ id: deviceIdSchema }),
};

class MeshInputError extends Error {}

function meshRoutes(get: () => Mesh | undefined): Record<string, Route> {
  const mesh = (): Mesh => {
    const service = get();
    if (service === undefined) throw new MeshInputError("守护进程没开账号组网");
    return service;
  };
  const wrap =
    (handler: Route): Route =>
    async (body) => {
      try {
        return await handler(body);
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof MeshInputError) throw error;
        throw new MeshInputError(error instanceof Error ? error.message : String(error));
      }
    };
  return {
    "GET /mesh/status": () => mesh().status(),
    "POST /mesh/login": wrap((body) => mesh().startLogin(meshSchemas.login.parse(body))),
    "DELETE /mesh/login": () => {
      mesh().cancelLogin();
      return mesh().status();
    },
    "POST /mesh/logout": wrap(async () => {
      await mesh().logout();
      return mesh().status();
    }),
    "POST /mesh/approvals/begin": wrap((body) => mesh().beginApproval(meshSchemas.begin.parse(body).requestId)),
    "POST /mesh/approvals/answer": wrap((body) => {
      const { requestId, match } = meshSchemas.answer.parse(body);
      return mesh().answerApproval(requestId, match);
    }),
    "PUT /mesh/priority": wrap(async (body) => {
      await mesh().setCenterPriority(meshSchemas.priority.parse(body).priority);
      return mesh().status();
    }),
    "POST /mesh/devices/remove": wrap(async (body) => {
      await mesh().removeDevice(meshSchemas.remove.parse(body).id);
      return mesh().status();
    }),
  };
}

export async function startAdminSocket(opts: AdminSocketOptions): Promise<RunningAdminSocket> {
  const routes: Record<string, Route> = {
    ...feishuRoutes(() => opts.feishu?.()),
    ...meshRoutes(() => opts.mesh?.()),
    "POST /admin/shutdown": () => {
      if (opts.onShutdown) setImmediate(() => opts.onShutdown?.());
      return { ok: true };
    },
  };
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
  };
  let secured = opts.secure === undefined;
  const beforeSecured = new Set<Socket>();
  const server = createServer(async (req, res) => {
    if (!secured) return send(res, 503, { error: "管理接口还在启动，稍后再试" });
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    if (token === "" || !opts.authorize(token)) return send(res, 401, { error: "令牌不对：要用跑守护进程的那个用户跑这个命令" });
    try {
      const route = routes[`${req.method} ${new URL(req.url ?? "/", "http://admin").pathname}`];
      if (route === undefined) return send(res, 404, { error: "守护进程没有这个接口（两边代码版本不一样？）" });
      send(res, 200, await route(await readBody(req)));
    } catch (error) {
      if (error instanceof BadRequest || error instanceof MeshInputError || error instanceof FeishuSetupError) return send(res, 400, { error: error.message });
      if (error instanceof z.ZodError) return send(res, 400, { error: error.issues[0]?.message ?? "参数不对" });
      opts.log?.(`管理接口出错：${error instanceof Error ? error.message : String(error)}`);
      send(res, 500, { error: `守护进程出错：${error instanceof Error ? error.message : String(error)}` });
    }
  });

  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  if (!secured) {
    server.on("connection", (socket: Socket) => {
      if (secured) return;
      beforeSecured.add(socket);
      socket.once("close", () => beforeSecured.delete(socket));
    });
  }
  const socketPath = await listenOnRunSocket(
    opts.socketPath,
    (path) =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => {
          server.off("error", reject);
          resolve();
        });
      }),
    close,
  );
  if (opts.secure !== undefined) {
    try {
      await opts.secure(socketPath);
    } catch (error) {
      await close();
      throw new AdminSocketInsecureError(socketPath, error);
    }
    secured = true;
    for (const socket of beforeSecured) socket.destroy();
    beforeSecured.clear();
  }
  return { socketPath, close };
}
