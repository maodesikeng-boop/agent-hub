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
