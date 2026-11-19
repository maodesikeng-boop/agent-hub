// 飞书终端命令的入口：node <代码目录>/src/feishu/main.ts <子命令>（用法见 cli.ts 的 FEISHU_USAGE）。
// 守护进程的数据目录和 hub 一样按 AGENT_HUB_HOME（默认 ~/.agent-hub）找；令牌读 state/ui-token，所以要用跑守护进程的那个用户跑。
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import qrcode from "qrcode-generator";
import { resolveHubPaths } from "../shared/paths.ts";
import { createAdminClient } from "../admin/client.ts";
import { runFeishuCli } from "./cli.ts";

const paths = resolveHubPaths(process.env, homedir());

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}

function renderQr(url: string): string {
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  return qr.createASCII(1, 2);
}

process.exitCode = await runFeishuCli({
  argv: process.argv.slice(2),
  stdin: readStdin,
  stdout: process.stdout,
  stderr: process.stderr,
  admin: createAdminClient(paths),
  renderQr,
  sleep: (ms) => sleep(ms).then(() => undefined),
});
