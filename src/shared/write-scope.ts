// Worker 可写范围（用户 2026-11-06 定的硬规则）：数据目录（~/.agent-hub）里 Worker 只能写自己的工作目录，别处一律不能新建、改动；
// 数据目录以外原样不管。项目经理不受限（没有可写范围）。state/（数据库、令牌、性格设定）的保护也在这条里，不再单独一套。
// 这里只定“能写哪儿”，跟厂商无关；每家怎么落实（OS 沙箱、厂商自己的沙箱和审批……）在 daemon/driver/write-scope.ts 的 WRITE_SCOPE_ENFORCERS。
import type { AgentRole } from "./domain.ts";

export interface WriteScope {
  /** 数据目录（paths.ts 的 home，realpath 过：macOS 上 /var 是 /private/var，沙箱按真实路径匹配）。 */
  dataDir: string;
  /** 数据目录里仍能写的目录：Worker 自己的 worktree（realpath 过）。在主文件夹干活的 Worker（--no-worktree）是空的。 */
  writableDirs: string[];
}

/**
 * 这个会话的可写范围：Worker 才有，项目经理（和别的角色）返回 null。
 * 工作目录在数据目录里（worktree）就放行它；在数据目录外（主文件夹）本来就不受限，不用放行。
 */
export function workerWriteScope(input: { role: AgentRole; dataDir: string; cwd: string }): WriteScope | null {
  if (input.role !== "worker") return null;
  const dataDir = trimSlash(input.dataDir);
  const cwd = trimSlash(input.cwd);
  return { dataDir, writableDirs: isStrictlyInside(cwd, dataDir) ? [cwd] : [] };
}

function trimSlash(p: string): string {
  const t = p.replace(/\/+$/, "");
  return t === "" ? "/" : t;
}

function normalizePathSegments(rawPath: string, homeDir?: string): string {
  let p = rawPath.trim().replace(/\\/g, "/");
  if (homeDir) {
    const cleanHome = homeDir.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (p === "~" || p.startsWith("~/")) p = cleanHome + p.slice(1);
    else p = p.replace(/^\$\{?HOME\}?(?=\/|$)/, cleanHome);
  }
  const absolute = p.startsWith("/");
  const segments: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
      else if (!absolute) segments.push("..");
    } else {
      segments.push(part);
    }
  }
  return (absolute ? "/" : "") + segments.join("/");
}

/** 规整成绝对路径：展开 ~ 和 $HOME、相对 cwd 解析、消掉 . 和 ..，不分大小写（APFS 默认不分）。 */
function resolveLower(targetPath: string, cwd?: string, homeDir?: string): string {
  const home = homeDir ?? (typeof process !== "undefined" ? process.env.HOME : undefined);
  const t = targetPath.trim().replace(/\\/g, "/");
  const relative = !t.startsWith("/") && t !== "~" && !t.startsWith("~/") && !/^\$\{?HOME\}?(\/|$)/.test(t);
  const joined = relative && cwd && cwd.trim() !== "" ? `${cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "")}/${t}` : t;
  return normalizePathSegments(joined, home).toLowerCase();
}

function insideLower(p: string, dir: string): boolean {
  return dir !== "" && dir !== "/" && (p === dir || p.startsWith(`${dir}/`));
}

function isStrictlyInside(p: string, dir: string): boolean {
  const a = resolveLower(p);
  const b = resolveLower(dir);
  return a !== b && insideLower(a, b);
}

/**
 * 按可写范围这个路径能不能写：不在数据目录里、或在放行的目录里就能写。相对路径按 cwd 解析，~ 和 $HOME 按 homeDir（默认 HOME）展开。
 * 给要自己判断路径的地方用（codex 的审批）；能用 OS 沙箱的厂商不靠它。
 */
export function scopeAllowsWrite(scope: WriteScope, targetPath: string, cwd?: string, homeDir?: string): boolean {
  if (targetPath.trim() === "") return true;
  const p = resolveLower(targetPath, cwd, homeDir);
  if (!insideLower(p, resolveLower(scope.dataDir, undefined, homeDir))) return true;
  return scope.writableDirs.some((d) => insideLower(p, resolveLower(d, undefined, homeDir)));
}

const SHELL_WRITE_INDICATORS =
  />|>>|\b(tee|sed|awk|perl|python\d*|node|ruby|cp|mv|rm|mkdir|touch|ln|dd|truncate|patch|install|chmod|chown|tar|unzip|git|sh|bash|zsh)\b/;
const READONLY_COMMAND = /^\s*(cat|head|tail|less|more|wc|stat|ls|file|grep|rg)\b/;

/**
 * 命令行会不会写到范围外（只能看字面，给 codex 的审批用：那是要越出 codex 沙箱跑的命令）：
 * 工作目录本身在范围外，或某个词按 cwd 解析后落在范围外，并且不是 cat、ls 这类只读命令。
 * 看不出不写字面路径的写法（脚本里拼出来的路径），codex 那边的说明见 codex-protocol.ts 的 decideCommandApproval。
 */
export function commandMayWriteOutsideScope(command: string, scope: WriteScope, cwd: string, homeDir?: string): boolean {
  const tokens = command
    .split(/[\s><|&;'"`()=]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const touches = !scopeAllowsWrite(scope, cwd, undefined, homeDir) || tokens.some((tok) => !scopeAllowsWrite(scope, tok, cwd, homeDir));
  if (!touches) return false;
  if (SHELL_WRITE_INDICATORS.test(command)) return true;
  return !READONLY_COMMAND.test(command);
}
