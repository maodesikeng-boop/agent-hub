// run/bin/hub：守护进程生成的小外壳（m2-plan 第 2 节）。写死 Node 和 src/hub/main.ts 的绝对路径，
// agent 的 PATH 里没有 node 也能跑；组装代码把 run/bin 放到 claude 的 PATH 最前面。
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN_DIR_MODE = 0o700;
const SHIM_MODE = 0o700;

export const DEFAULT_HUB_MAIN = fileURLToPath(new URL("../../hub/main.ts", import.meta.url));

export interface HubShimOptions {
  /** run/bin/。 */
  binDir: string;
  /** 默认是跑守护进程的这个 Node。 */
  nodePath?: string;
  /** 默认是仓库里的 src/hub/main.ts。 */
  mainScript?: string;
}

/** sh 的单引号转义：' → '\''。 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function hubShimContent(nodePath: string, mainScript: string): string {
  return `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(mainScript)} "$@"\n`;
}

/** 写（或重写）<binDir>/hub，临时文件 + 改名；返回它的路径。 */
export function installHubShim(opts: HubShimOptions): string {
  mkdirSync(opts.binDir, { recursive: true, mode: BIN_DIR_MODE });
  chmodSync(opts.binDir, BIN_DIR_MODE);
  const target = join(opts.binDir, "hub");
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, hubShimContent(opts.nodePath ?? process.execPath, opts.mainScript ?? DEFAULT_HUB_MAIN), { mode: SHIM_MODE });
  // writeFileSync 的 mode 受 umask 影响，改名前再定一次
  chmodSync(tmp, SHIM_MODE);
  renameSync(tmp, target);
  return target;
}
