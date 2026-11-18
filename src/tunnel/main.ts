// 隧道命令的入口：node <代码目录>/src/tunnel/main.ts <子命令>（用法见 cli.ts 的 TUNNEL_USAGE）。
// 守护进程的数据目录和 hub 一样按 AGENT_HUB_HOME（默认 ~/.agent-hub）找；令牌读 state/ui-token，所以要用跑守护进程的那个用户跑。
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { resolveHubPaths } from "../shared/paths.ts";
import { createAdminClient } from "./admin-client.ts";
import { runTunnelCli } from "./cli.ts";

const paths = resolveHubPaths(process.env, homedir());

const admin = createAdminClient(paths);

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
