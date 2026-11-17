// 截图工具要删、要写的每个目录，动手之前都先过这一关：和用户真实的数据目录重叠就拒绝。
// 真实数据目录认两处：~/.agent-hub，和设了 AGENT_HUB_HOME 时它指的目录。比较前两边都解开软链。
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { resolveHubPaths } from "../../src/shared/paths.ts";

const MAX_LINK_HOPS = 40;

/**
 * 后置：path 的真实路径。路径还不存在时，找最近一个存在的上级取真实路径再拼回剩下的部分；
 * 路上指向还不存在的地方的软链也照着解开。软链绕圈超过 MAX_LINK_HOPS 层抛 Error。
 */
export function realPathOf(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  let hops = 0;
  for (;;) {
    try {
      return join(realpathSync.native(current), ...rest);
    } catch {
      const link = symlinkTarget(current);
      if (link !== undefined) {
        if (++hops > MAX_LINK_HOPS) throw new Error(`${path} 的软链绕了 ${MAX_LINK_HOPS} 层以上`);
        current = resolve(dirname(current), link);
        continue;
      }
      const parent = dirname(current);
      if (parent === current) return join(current, ...rest);
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

function symlinkTarget(path: string): string | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
  } catch {
    return undefined;
  }
}

/** macOS 和 Windows 的文件系统默认不分大小写。 */
const fold = (p: string) => (process.platform === "darwin" || process.platform === "win32" ? p.toLowerCase() : p);
const withSep = (p: string) => (p.endsWith(sep) ? p : p + sep);

function overlaps(a: string, b: string): boolean {
  const [x, y] = [fold(a), fold(b)];
  return x === y || x.startsWith(withSep(y)) || y.startsWith(withSep(x));
}

/**
 * 前置：在对 path 做任何删除、创建、写入之前调用。
 * 后置：path 和真实数据目录（默认的 ~/.agent-hub，加上 env 里 AGENT_HUB_HOME 指的目录）互不包含才返回；否则抛 Error。
 */
export function assertIsolated(path: string, env: Record<string, string | undefined> = process.env, userHome: string = homedir()): void {
  const target = realPathOf(path);
  const roots = new Set([resolveHubPaths({}, userHome).home, resolveHubPaths(env, userHome).home].map(realPathOf));
  for (const root of roots) {
    if (overlaps(target, root)) throw new Error(`${path}（真实路径 ${target}）和真实数据目录 ${root} 重叠，拒绝动它`);
  }
}
