// 本机管理 socket run/admin.sock 的客户端（daemon/tunnel/admin.ts 的另一头）：隧道命令和飞书命令共用。
// 令牌读 state/ui-token，所以要用跑守护进程的那个用户跑。
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { TUNNEL_ADMIN_TIMEOUT_MS } from "../shared/limits.ts";
import type { HubPaths } from "../shared/paths.ts";
import { AdminError, AdminUnavailableError } from "./cli.ts";

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
          timeout: TUNNEL_ADMIN_TIMEOUT_MS,
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
