// Windows MXC ProcessContainer 进程流式桥接启动器：
// 由 `wrapReadonlyWithWin32Mxc` 通过 `node.exe mxc-runner.ts --config-base64 <...>`（或 `--config-file`）拉起；
// 自身运行在 `fusa-run.exe` 的 kill-on-close Job 内，按需动态引入 `@microsoft/mxc-sdk/v1` 的 `spawn()`，
// 转发标准输入输出与中断信号，并在 `HUB_SOCK` 为命名管道时建立单会话 127.0.0.1 回环桥接供容器内 `hub.exe` 通信。
import { readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";
import { WIN_MXC_REQUEST_FILE_MAX_BYTES } from "../../../shared/limits.ts";
import { isWindowsNamedPipe } from "../../../shared/paths.ts";
import { buildWin32MxcCommandLine, type MxcRunnerConfig } from "./mxc-readonly.ts";
import { normalizePathForComparison } from "./path-key.ts";

export function parseMxcRunnerCliArgs(argv: readonly string[]): MxcRunnerConfig {
  const flag = argv[0];
  const val = argv[1];
  if (!flag || !val) {
    throw new Error("Usage: mxc-runner.ts <--config-base64 <b64> | --config-file <path>>");
  }
  let rawJson: string;
  if (flag === "--config-base64") {
    if (Buffer.byteLength(val, "utf8") > WIN_MXC_REQUEST_FILE_MAX_BYTES * 2) {
      throw new Error("MXC inline base64 config exceeds maximum size");
    }
    rawJson = Buffer.from(val, "base64").toString("utf8");
  } else if (flag === "--config-file") {
    try {
      const size = statSync(val).size;
      if (size > WIN_MXC_REQUEST_FILE_MAX_BYTES) {
        throw new Error(`MXC config file exceeds ${WIN_MXC_REQUEST_FILE_MAX_BYTES} bytes`);
      }
      rawJson = readFileSync(val, "utf8");
    } finally {
      try {
        unlinkSync(val);
      } catch {
        // 已清理或不存在时忽略
      }
    }
  } else {
    throw new Error(`Unknown mxc-runner flag: ${flag}`);
  }
  return JSON.parse(rawJson) as MxcRunnerConfig;
}

interface LoopbackPipeBridge {
  endpoint: string;
  close(): Promise<void>;
}

async function startHubPipeLoopbackBridge(pipePath: string): Promise<LoopbackPipeBridge> {
  const activeSockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    activeSockets.add(client);
    const upstream = createConnection(pipePath);
    activeSockets.add(upstream);
    const cleanup = () => {
      activeSockets.delete(client);
      activeSockets.delete(upstream);
    };
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", cleanup);
    upstream.on("close", cleanup);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("Failed to bind loopback TCP bridge for HUB_SOCK");
  }
  return {
    endpoint: `tcp://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const sock of activeSockets) sock.destroy();
        activeSockets.clear();
        server.close(() => resolve());
      }),
  };
}

function buildContainerEnv(baseEnv: NodeJS.ProcessEnv, shimEnv?: NodeJS.ProcessEnv): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const src of [baseEnv, shimEnv]) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (typeof v !== "string" || k.length === 0 || k.includes("=")) continue;
      merged[k] = v;
    }
  }
  return merged;
}

async function runMain(argv: readonly string[]): Promise<number> {
  const cfg = parseMxcRunnerCliArgs(argv);
  const cwd = process.cwd();
  const { command, extraEnv } = buildWin32MxcCommandLine(cfg.program, cfg.args, {
    cwd,
    env: process.env,
  });
  const containerEnv = buildContainerEnv(process.env, extraEnv);

  let hubBridge: LoopbackPipeBridge | null = null;
  if (containerEnv.HUB_SOCK && isWindowsNamedPipe(containerEnv.HUB_SOCK)) {
    hubBridge = await startHubPipeLoopbackBridge(containerEnv.HUB_SOCK);
    containerEnv.HUB_SOCK = hubBridge.endpoint;
  }

  const mxc = await import("@microsoft/mxc-sdk/v1");
  const request: ContainerRequest = {
    command,
    containment: { type: "processcontainer" },
    workingDirectory: cwd,
    environment: containerEnv,
    inheritDefaultEnvironment: true,
    filesystem: cfg.filesystem,
    network: cfg.network,
    ui: cfg.ui,
  };

  let proc: Awaited<ReturnType<typeof mxc.spawn>> | undefined;
  try {
    proc = await mxc.spawn(request, { telemetry: { enabled: false } });
    const stdinStream = proc.standardInput;
    const stdoutStream = proc.standardOutput;
    const stderrStream = proc.standardError;

    const outputDone: Promise<void>[] = [];
    if (stdoutStream) {
      outputDone.push(
        new Promise<void>((resolve) => {
          stdoutStream.on("data", (chunk: Buffer) => {
            process.stdout.write(chunk);
          });
          stdoutStream.once("end", resolve);
          stdoutStream.once("close", resolve);
          stdoutStream.once("error", () => resolve());
        }),
      );
    }
    if (stderrStream) {
      outputDone.push(
        new Promise<void>((resolve) => {
          stderrStream.on("data", (chunk: Buffer) => {
            process.stderr.write(chunk);
          });
          stderrStream.once("end", resolve);
          stderrStream.once("close", resolve);
          stderrStream.once("error", () => resolve());
        }),
      );
    }
    if (stdinStream) {
      stdinStream.on("error", () => {});
      process.stdin.pipe(stdinStream);
    }

    const onStopSignal = () => {
      try {
        proc?.kill();
      } catch {
        // 容器已退出时忽略
      }
    };
    process.on("SIGINT", onStopSignal);
    process.on("SIGTERM", onStopSignal);
    process.on("SIGBREAK", onStopSignal);

    try {
      const waitRes = await proc.wait();
      await Promise.allSettled(outputDone);
      return waitRes.exitCode;
    } finally {
      process.off("SIGINT", onStopSignal);
      process.off("SIGTERM", onStopSignal);
      process.off("SIGBREAK", onStopSignal);
    }
  } finally {
    try {
      proc?.dispose();
    } catch {
      // 释放异常忽略
    }
    if (hubBridge) {
      await hubBridge.close();
    }
  }
}

function realOrSelf(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

if (
  process.argv[1] &&
  normalizePathForComparison(realOrSelf(fileURLToPath(import.meta.url))) ===
    normalizePathForComparison(realOrSelf(process.argv[1]))
) {
  runMain(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[fusa-mxc-runner] ${msg}\n`);
      process.exitCode = 1;
    });
}
