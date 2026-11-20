import { chmodSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { HUB_SOCKET_PROBE_MS } from "../shared/limits.ts";
import { assertSocketPathFits, isWindowsNamedPipe } from "../shared/paths.ts";
import { allowWin32NamedPipeUserAccess } from "./platform/index.ts";

const RUN_DIR_MODE = 0o700;
const SOCKET_MODE = 0o600;

function socketIsLive(socketPath: string): Promise<boolean> {
  return new Promise((done, fail) => {
    const socket = createConnection(socketPath);
    const finish = (result: boolean | Error) => {
      socket.destroy();
      if (result instanceof Error) fail(result);
      else done(result);
    };
    socket.setTimeout(HUB_SOCKET_PROBE_MS, () => finish(true));
    socket.once("connect", () => finish(true));
    socket.once("error", (err: NodeJS.ErrnoException) => {
      finish(err.code === "ECONNREFUSED" || err.code === "ENOENT" ? false : err);
    });
  });
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  let stat;
  try {
    stat = lstatSync(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (!stat.isSocket()) throw new Error(`socket 路径上已经有别的东西，不是 socket：${socketPath}。请确认后手动移走。`);
  if (await socketIsLive(socketPath)) throw new Error(`已有守护进程在跑：${socketPath} 上有人在监听，不能再启动一个。`);
  unlinkSync(socketPath);
}

/** Returns the realpath because sandbox rules compare resolved paths. */
export async function listenOnRunSocket(
  socketPath: string,
  listen: (realSocketPath: string) => Promise<void>,
  abort: () => Promise<void>,
): Promise<string> {
  if (isWindowsNamedPipe(socketPath)) {
    try {
      await listen(socketPath);
    } catch (err) {
      await abort();
      if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
        throw new Error(`已有守护进程在跑：${socketPath} 上有人在监听，不能再启动一个。`, { cause: err });
      }
      throw err;
    }
    if (process.platform === "win32") {
      allowWin32NamedPipeUserAccess(socketPath);
    }
    return socketPath;
  }
  const runDir = dirname(resolve(socketPath));
  mkdirSync(runDir, { recursive: true, mode: RUN_DIR_MODE });
  chmodSync(runDir, RUN_DIR_MODE);
  const realPath = join(realpathSync.native(runDir), basename(socketPath));
  assertSocketPathFits(realPath);
  await removeStaleSocket(realPath);
  try {
    await listen(realPath);
    chmodSync(realPath, SOCKET_MODE);
  } catch (err) {
    await abort();
    throw err;
  }
  return realPath;
}
