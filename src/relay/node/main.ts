import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { startNodeRelay } from "./server.ts";

const USAGE =
  "用法：node src/relay/node/main.ts --port <端口> --origin https://<对外地址> [--db <文件，默认 relay.sqlite>] [--host <地址，默认 0.0.0.0>] [--trust-proxy] [--debug-frames]\n";

export async function runRelayCli(
  argv: string[],
  io: { stdout: { write(text: string): unknown }; stderr: { write(text: string): unknown } },
  signals: Pick<NodeJS.EventEmitter, "once" | "off"> = process,
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        port: { type: "string" },
        origin: { type: "string" },
        db: { type: "string" },
        host: { type: "string" },
        "trust-proxy": { type: "boolean" },
        "debug-frames": { type: "boolean" },
      },
      strict: true,
    }));
  } catch {
    io.stderr.write(USAGE);
    return 2;
  }
  const port = Number(values.port);
  let origin: URL | null = null;
  try {
    origin = values.origin === undefined ? null : new URL(values.origin);
  } catch {
    origin = null;
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535 || values.port === undefined || origin === null || !/^https?:$/.test(origin.protocol)) {
    io.stderr.write(USAGE);
    return 2;
  }
  const relay = await startNodeRelay({
    port,
    host: values.host ?? "0.0.0.0",
    dbFile: values.db ?? "relay.sqlite",
    publicOrigin: origin.origin,
    trustProxy: values["trust-proxy"] ?? false,
    debugFrames: values["debug-frames"] ?? false,
    log: (line) => io.stdout.write(`${line}\n`),
  });
  await new Promise<void>((resolve) => {
    const stop = () => {
      signals.off("SIGINT", stop);
      signals.off("SIGTERM", stop);
      resolve();
    };
    signals.once("SIGINT", stop);
    signals.once("SIGTERM", stop);
  });
  await relay.close();
  io.stdout.write("中继已关闭\n");
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await runRelayCli(process.argv.slice(2), process);
}
