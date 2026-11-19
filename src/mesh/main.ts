// 账号组网终端命令的入口：node <代码目录>/src/mesh/main.ts <子命令>（用法见 cli.ts 的 MESH_USAGE）。
// 守护进程的数据目录和 hub 一样按 AGENT_HUB_HOME（默认 ~/.agent-hub）找；令牌读 state/ui-token，所以要用跑守护进程的那个用户跑。
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createAdminClient } from "../admin/client.ts";
import { resolveHubPaths } from "../shared/paths.ts";
import { runMeshCli } from "./cli.ts";

const paths = resolveHubPaths(process.env, homedir());
const cleanup: Array<() => void> = [];
let reader: ReturnType<typeof createInterface> | undefined;

try {
  process.exitCode = await runMeshCli({
    argv: process.argv.slice(2),
    stdout: process.stdout,
    stderr: process.stderr,
    admin: createAdminClient(paths),
    readLine: async (prompt) => {
      if (reader === undefined) {
        const created = createInterface({ input: process.stdin, output: process.stdout });
        reader = created;
        cleanup.push(() => created.close());
      }
      return reader.question(prompt);
    },
    sleep: (ms) => sleep(ms).then(() => undefined),
  });
} finally {
  for (const close of cleanup) close();
}
