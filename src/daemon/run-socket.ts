// 守护进程所有 Unix socket（hub.sock、ui.sock、peer.sock）听之前的准备，只此一处：
// 建 run/（0700）、realpath、查路径长度、残留 socket 先试连再删、listen、socket 改成 0600、失败就关掉再抛。
import { chmodSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { HUB_SOCKET_PROBE_MS } from "../shared/limits.ts";
import { assertSocketPathFits } from "../shared/paths.ts";

const RUN_DIR_MODE = 0o700;
const SOCKET_MODE = 0o600;

/** 试连一次：连得上返回 true；ECONNREFUSED、ENOENT（没人监听）返回 false；别的错原样抛。 */
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

/** 残留的 socket（上次没正常关）删掉；还有人在监听就拒绝启动；那里是别的东西就报错，不替用户删。 */
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

/**
 * 在 socketPath（所在目录就是 run/）上听一个 Unix socket，返回 realpath 过的路径。
 * 听的方式（Fastify 的 app.listen、http.createServer……）由调用方的 listen 决定；listen 或改权限失败就调 abort 关掉已经在听的，再把错抛出去。
 * listen 和 chmod 之间 socket 短暂是 umask 给的权限，但 run/ 已经是 0700，别人进不来。
 */
export async function listenOnRunSocket(
  socketPath: string,
  listen: (realSocketPath: string) => Promise<void>,
  abort: () => Promise<void>,
): Promise<string> {
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
