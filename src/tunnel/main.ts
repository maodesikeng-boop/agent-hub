// 隧道命令的入口：node <代码目录>/src/tunnel/main.ts <子命令>（用法见 cli.ts 的 TUNNEL_USAGE）。
// 守护进程的数据目录和 hub 一样按 AGENT_HUB_HOME（默认 ~/.agent-hub）找；令牌读 state/ui-token，所以要用跑守护进程的那个用户跑。
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { homedir, hostname } from "node:os";
import { TUNNEL_ADMIN_TIMEOUT_MS } from "../shared/limits.ts";
import { resolveHubPaths } from "../shared/paths.ts";
import { AdminError, AdminUnavailableError, runTunnelCli } from "./cli.ts";

const paths = resolveHubPaths(process.env, homedir());

function admin(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
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
}

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["inherit", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.once("error", (error) => {
      process.stderr.write(`[tunnel] 起不来 ${cmd}：${error.message}\n`);
      resolve({ code: 127, stdout });
    });
    child.once("close", (code) => resolve({ code: code ?? 1, stdout }));
  });
}

process.exitCode = await runTunnelCli({
  argv: process.argv.slice(2),
  stdout: process.stdout,
  stderr: process.stderr,
  admin,
  run,
  readFile: (path) => readFileSync(path, "utf8"),
  hostname,
});
