// hub 命令的入口：守护进程生成的 run/bin/hub 外壳用 Node 直接跑这个文件（见 daemon/agent-api/shim.ts）。
import { runHub } from "./cli.ts";

process.exitCode = await runHub({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  // 只有写了 --stdin 才取 process.stdin
  stdin: () => process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
