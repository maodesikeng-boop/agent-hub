import { readFileSync } from "node:fs";
import { request } from "node:http";
import { ADMIN_SOCKET_TIMEOUT_MS } from "../shared/limits.ts";
import type { HubPaths } from "../shared/paths.ts";

export class AdminUnavailableError extends Error {
  constructor(socketPath: string) {
    super(`连不上本机守护进程（${socketPath}）：先启动 agent-hub 守护进程`);
  }
}
export class AdminError extends Error {}

export type AdminMethod = "GET" | "POST" | "PUT" | "DELETE";

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
