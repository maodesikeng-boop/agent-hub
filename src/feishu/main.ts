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
