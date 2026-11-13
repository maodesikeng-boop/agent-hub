// 本机管理 socket run/admin.sock（docs/hub-tunnel-design.md 第 7 节）：隧道命令（src/tunnel/）经它找守护进程。
// 只有本机这个用户能连（run/ 0700、socket 0600），另外要带界面令牌 state/ui-token（agent 读不到 state/）：
// agent 和守护进程是同一个系统用户，光靠文件权限挡不住它。
// 接口（JSON 进、JSON 出；输入不对 400 { error }）：
//   POST /tunnel/key           { regenerate? }        → { publicKey }
//   POST /tunnel/connect       { code }               → { status }
//   GET  /tunnel/status                               → { status }
//   POST /tunnel/slots         { name, publicKey }    → { port, entryPort, invite, expiresAt }
//   POST /tunnel/slots/remove  { name }               → { removed: { port } | null }
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { TUNNEL_ADMIN_MAX_BODY_BYTES } from "../../shared/limits.ts";
import { listenOnRunSocket } from "../run-socket.ts";
import { TunnelInputError, type TunnelService } from "./service.ts";

export interface TunnelAdminOptions {
  runDir: string;
  socketPath: string;
  /** 认令牌：Authorization: Bearer <令牌>。 */
  authorize(token: string): boolean;
  service: Pick<TunnelService, "ensureKey" | "connect" | "status" | "addSlot" | "removeSlot">;
  /** 桌面外壳经本机管理端点优雅关机（Windows 下替代外部无法送达的 SIGTERM）。 */
  onShutdown?: () => void;
  log?: (line: string) => void;
}

export interface RunningTunnelAdmin {
  socketPath: string;
  close(): Promise<void>;
}

class BadRequest extends Error {}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > TUNNEL_ADMIN_MAX_BODY_BYTES) {
        chunks.length = 0;
        req.resume();
        reject(new BadRequest("请求太大"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > TUNNEL_ADMIN_MAX_BODY_BYTES) return;
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

const str = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (typeof value !== "string") throw new BadRequest(`缺少 ${key}`);
  return value;
};

export async function startTunnelAdmin(opts: TunnelAdminOptions): Promise<RunningTunnelAdmin> {
  const { service } = opts;
  const routes: Record<string, (body: Record<string, unknown>) => Promise<unknown> | unknown> = {
    "POST /tunnel/key": (body) => service.ensureKey({ regenerate: body.regenerate === true }),
    "POST /tunnel/connect": async (body) => ({ status: await service.connect(str(body, "code")) }),
    "GET /tunnel/status": () => ({ status: service.status() }),
    "POST /tunnel/slots": (body) => service.addSlot({ name: str(body, "name"), publicKey: str(body, "publicKey") }),
    "POST /tunnel/slots/remove": (body) => ({ removed: service.removeSlot(str(body, "name")) }),
    "POST /admin/shutdown": () => {
      if (opts.onShutdown) setImmediate(() => opts.onShutdown?.());
      return { ok: true };
    },
  };
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    if (token === "" || !opts.authorize(token)) return send(res, 401, { error: "令牌不对：要用跑守护进程的那个用户跑隧道命令" });
    try {
      const route = routes[`${req.method} ${new URL(req.url ?? "/", "http://admin").pathname}`];
      if (route === undefined) return send(res, 404, { error: "守护进程没有这个接口（两边代码版本不一样？）" });
      send(res, 200, await route(await readBody(req)));
    } catch (error) {
      if (error instanceof BadRequest || error instanceof TunnelInputError) return send(res, 400, { error: error.message });
      opts.log?.(`隧道管理接口出错：${error instanceof Error ? error.message : String(error)}`);
      send(res, 500, { error: `守护进程出错：${error instanceof Error ? error.message : String(error)}` });
    }
  });

  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
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
  return { socketPath, close };
}
