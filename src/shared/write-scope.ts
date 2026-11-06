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

/** 按 ; && || | & 换行拆成一段段命令。不管引号：`bash -c "cd x && touch y"` 引号里的也照样拆开跟踪，拆错了只会多拦。 */
function splitShellSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[;\n|]|(?<![<>])&(?!>)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 换目录的一段：cd、pushd、popd，前面可以有 ( { 和 sh/bash/zsh -c 的引号。第 2 组是 cd 的参数。 */
const CD_SEGMENT = /^[\s({]*(?:\S*\b(?:sh|bash|zsh)\s+(?:-\w+\s+)*-c\s+['"]?)?\s*(cd|pushd|popd)\b\s*(.*)$/;

/** 这一段 cd 之后的工作目录；看不出来（cd -、popd、带变量）返回 null。 */
function cdTarget(verb: string, rawArgs: string, dir: string | null): string | null {
  if (verb === "popd") return null;
  const arg = rawArgs
    .replace(/['"]/g, "")
    .split(/\s+/)
    .find((a) => a !== "" && (a === "-" || !a.startsWith("-")));
  if (arg === undefined || arg === "~") return "~";
  if (arg === "-" || /[`*?]|\$(?!\{?HOME\b)/.test(arg)) return null;
  if (arg.startsWith("/") || arg.startsWith("~/") || /^\$\{?HOME\}?(\/|$)/.test(arg)) return arg;
  return dir === null ? null : `${dir.replace(/\/+$/, "")}/${arg}`;
}

/** 一段命令会不会写到范围外：工作目录看不出、在范围外，或某个词落在范围外，并且不是只读命令。 */
function segmentMayWriteOutsideScope(segment: string, scope: WriteScope, dir: string | null, homeDir?: string): boolean {
  const tokens = segment
    .split(/[\s><|&;'"`()=]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const touches = dir === null || !scopeAllowsWrite(scope, dir, undefined, homeDir) || tokens.some((tok) => !scopeAllowsWrite(scope, tok, dir, homeDir));
  if (!touches) return false;
  if (SHELL_WRITE_INDICATORS.test(segment)) return true;
  return !READONLY_COMMAND.test(segment);
}

/**
 * 命令行会不会写到范围外（只能看字面，给没有 OS 沙箱时的兜底用：codex 的审批、agy 的工具检查）：
 * 按 ; && || | 拆成一段段，跟着 cd 换工作目录，每段判断：工作目录在范围外、或某个词按工作目录解析后落在范围外，并且不是 cat、ls 这类只读命令。
 * 看不出不写字面路径的写法（变量、脚本里拼出来的路径、软链接），已知局限见 docs/write-scope.md。
 */
export function commandMayWriteOutsideScope(command: string, scope: WriteScope, cwd: string, homeDir?: string): boolean {
  let dir: string | null = cwd;
  for (const segment of splitShellSegments(command)) {
    const cd = CD_SEGMENT.exec(segment);
    if (cd) dir = cdTarget(cd[1]!, cd[2] ?? "", dir);
    else if (segmentMayWriteOutsideScope(segment, scope, dir, homeDir)) return true;
  }
  return false;
}
