// 本机管理 socket run/admin.sock 的客户端（daemon/admin/socket.ts 的另一头）：飞书命令和账号组网命令共用。
// 令牌读 state/ui-token，所以要用跑守护进程的那个用户跑。
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { ADMIN_SOCKET_TIMEOUT_MS } from "../shared/limits.ts";
import type { HubPaths } from "../shared/paths.ts";

/** 连不上本机守护进程（没启动，或者不是跑守护进程的那个用户）。 */
export class AdminUnavailableError extends Error {
  constructor(socketPath: string) {
    super(`连不上本机守护进程（${socketPath}）：先启动 agent-hub 守护进程`);
  }
}
/** 管理 socket 回了错误。 */
export class AdminError extends Error {}

export type AdminMethod = "GET" | "POST" | "PUT" | "DELETE";

/** 后置：200 回 JSON；连不上抛 AdminUnavailableError，回错误抛 AdminError（message 是守护进程给的原因）。 */
export function createAdminClient(paths: Pick<HubPaths, "uiTokenFile" | "adminSock">) {
  return function admin(method: AdminMethod, path: string, body?: unknown): Promise<unknown> {
    let token: string;
    try {
      token = readFileSync(paths.uiTokenFile, "utf8").trim();
    } catch {
      return Promise.reject(new AdminUnavailableError(paths.adminSock));
    }
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: paths.adminSock,
          method,
          path,
          timeout: ADMIN_SOCKET_TIMEOUT_MS,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => (text += chunk));
          res.on("end", () => {
            let value: unknown = null;
            try {
              value = JSON.parse(text);
            } catch {
              // 下面按状态码报
            }
            if (res.statusCode === 200) return resolve(value);
            const message = (value as { error?: unknown } | null)?.error;
            reject(new AdminError(typeof message === "string" ? message : `守护进程回了 ${res.statusCode}`));
          });
        },
      );
      req.on("timeout", () => req.destroy(new AdminError("守护进程没回话")));
      req.on("error", (error: NodeJS.ErrnoException) =>
        reject(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? new AdminUnavailableError(paths.adminSock) : error),
      );
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  };
}
