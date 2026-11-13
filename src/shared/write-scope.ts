// Worker 可写范围（用户 2026-11-06 定的硬规则）：数据目录（~/.agent-hub）里 Worker 只能写自己的工作目录，别处一律不能新建、改动；
// 数据目录以外原样不管。项目经理不受限（没有可写范围）。state/（数据库、令牌、性格设定）的保护也在这条里，不再单独一套。
// 这里只定“能写哪儿”，跟厂商无关；每家怎么落实（OS 沙箱、厂商自己的沙箱和审批……）在 daemon/driver/write-scope.ts 的 WRITE_SCOPE_ENFORCERS。
import type { AgentRole } from "./domain.ts";

export interface WriteScope {
  /** 数据目录（paths.ts 的 home，realpath 过：macOS 上 /var 是 /private/var，沙箱按真实路径匹配）。 */
  dataDir: string;
  /**
   * 所有受保护根目录（含数据目录与各卷同卷 worktree 根，如 `D:\.fusa-wt\<指纹>`；macOS / Linux / Windows 三平台一致语义）。
   * 旧构造点未显式传入时默认按 `[dataDir]` 处理。
   */
  protectedRoots?: string[];
  /** 受保护根里仍能写的目录：Worker 自己的 worktree（realpath 过）。在主文件夹干活的 Worker（--no-worktree）是空的。 */
  writableDirs: string[];
}

/** 取出 WriteScope 的全部去重受保护根目录（始终包含 dataDir）。 */
export function protectedRootsOf(scope: WriteScope): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [scope.dataDir, ...(scope.protectedRoots ?? [])]) {
    const trimmed = trimSlash(raw);
    const key = resolveLower(trimmed);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * 这个会话的可写范围：Worker 才有，项目经理（和别的角色）返回 null。
 * 工作目录在任意受保护根（数据目录或同卷 worktree 根）里就放行它；在受保护根外（主文件夹）本来就不受限，不用放行。
 */
export function workerWriteScope(input: {
  role: AgentRole;
  dataDir: string;
  protectedRoots?: readonly string[];
  cwd: string;
}): WriteScope | null {
  if (input.role !== "worker") return null;
  const dataDir = trimSlash(input.dataDir);
  const cwd = trimSlash(input.cwd);
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const raw of [dataDir, ...(input.protectedRoots ?? [])]) {
    const clean = trimSlash(raw);
    const key = resolveLower(clean);
    if (!seen.has(key)) {
      seen.add(key);
      roots.push(clean);
    }
  }
  const wrapsAnyRoot = roots.some((root) => {
    const a = resolveLower(cwd);
    const b = resolveLower(root);
    return a === b || insideLower(b, a);
  });
  const insideAnyRoot = !wrapsAnyRoot && roots.some((root) => isStrictlyInside(cwd, root));
  return {
    dataDir,
    protectedRoots: roots,
    writableDirs: insideAnyRoot ? [cwd] : [],
  };
}

function trimSlash(p: string): string {
  const stripped = stripWinDeviceNamespace(p.trim());
  if (/^[A-Za-z]:[\\/]*$/.test(stripped)) {
    const sep = stripped.includes("\\") ? "\\" : "/";
    return `${stripped.slice(0, 2)}${sep}`;
  }
  const t = stripped.replace(/[\\/]+$/, "");
  if (t === "") return p.includes("\\") ? "\\" : "/";
  return t;
}

function stripWinDeviceNamespace(raw: string): string {
  if (/^\\\\\?\\UNC\\/i.test(raw)) return `\\\\${raw.slice(8)}`;
  if (/^\\\\\?\\[A-Za-z]:[\\/]/.test(raw)) return raw.slice(4);
  return raw;
}

/** 拒绝 Windows 盘符相对路径（`C:foo`）与 NTFS 备用数据流（`a.txt:zone`）：这类写法字面无法安全归属，一律判不可写。 */
export function hasUnsafeWindowsColonSyntax(rawPath: string): boolean {
  const clean = stripWinDeviceNamespace(rawPath.trim());
  if (clean === "") return false;
  const firstColon = clean.indexOf(":");
  if (firstColon < 0) return false;
  if (firstColon !== 1 || !/^[A-Za-z]:[\\/]/.test(clean)) return true;
  return clean.indexOf(":", 2) >= 0;
}

function isHomeExpr(p: string): boolean {
  return (
    p === "~" ||
    p.startsWith("~/") ||
    p.startsWith("~\\") ||
    /^\$\{?HOME\}?(?=[\\/]|$)/.test(p) ||
    /^%USERPROFILE%(?=[\\/]|$)/i.test(p) ||
    /^\$env:USERPROFILE(?=[\\/]|$)/i.test(p)
  );
}

function expandHomePrefix(p: string, cleanHome: string): string {
  if (p === "~" || p.startsWith("~/")) return cleanHome + p.slice(1);
  if (p.startsWith("~\\")) return `${cleanHome}/${p.slice(2)}`;
  if (/^\$\{?HOME\}?(?=[\\/]|$)/.test(p)) return p.replace(/^\$\{?HOME\}?/, cleanHome);
  if (/^%USERPROFILE%(?=[\\/]|$)/i.test(p)) return p.replace(/^%USERPROFILE%/i, cleanHome);
  if (/^\$env:USERPROFILE(?=[\\/]|$)/i.test(p)) return p.replace(/^\$env:USERPROFILE/i, cleanHome);
  return p;
}

function isAbsNormalized(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:\//.test(p);
}

function normalizePathSegments(rawPath: string, homeDir?: string): string {
  let p = stripWinDeviceNamespace(rawPath.trim()).replace(/\\/g, "/");
  if (homeDir) {
    const cleanHome = stripWinDeviceNamespace(homeDir.trim()).replace(/\\/g, "/").replace(/\/+$/, "");
    p = expandHomePrefix(p, cleanHome);
  }
  if (p.startsWith("//")) {
    const uncParts = p.slice(2).split("/").filter(Boolean);
    if (uncParts.length >= 2) {
      const hostShare = `//${uncParts[0]}/${uncParts[1]}`;
      const segments: string[] = [];
      for (const part of uncParts.slice(2)) {
        if (part === ".") continue;
        if (part === "..") segments.pop();
        else segments.push(part);
      }
      return segments.length > 0 ? `${hostShare}/${segments.join("/")}` : hostShare;
    }
  }
  const driveMatch = /^([A-Za-z]:)(?:\/(.*))?$/.exec(p);
  if (driveMatch) {
    const drive = driveMatch[1]!;
    const rest = driveMatch[2] ?? "";
    const segments: string[] = [];
    for (const part of rest.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") segments.pop();
      else segments.push(part);
    }
    return segments.length > 0 ? `${drive}/${segments.join("/")}` : `${drive}/`;
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

function defaultHomeFromProcess(): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  return process.env.HOME || process.env.USERPROFILE;
}

/** 规整成比较用绝对路径：展开 ~/$HOME/%USERPROFILE%、相对 cwd 解析、消掉 . 和 ..，先 NFC 再不分大小写（APFS/NTFS 默认不分）。 */
function resolveLower(targetPath: string, cwd?: string, homeDir?: string): string {
  const home = homeDir ?? defaultHomeFromProcess();
  const stripped = stripWinDeviceNamespace(targetPath.trim());
  const t = stripped.replace(/\\/g, "/");
  const relative = !isAbsNormalized(t) && !isHomeExpr(stripped);
  const joined =
    relative && cwd && cwd.trim() !== ""
      ? `${stripWinDeviceNamespace(cwd.trim()).replace(/\\/g, "/").replace(/\/+$/, "")}/${t}`
      : stripped;
  return normalizePathSegments(joined, home).normalize("NFC").toLowerCase();
}

function insideLower(p: string, dir: string): boolean {
  if (dir === "" || dir === "/" || /^[a-z]:\/$/.test(dir)) return false;
  const cleanDir = dir.replace(/\/+$/, "");
  return p === cleanDir || p.startsWith(`${cleanDir}/`);
}

function isStrictlyInside(p: string, dir: string): boolean {
  const a = resolveLower(p).replace(/\/+$/, "");
  const b = resolveLower(dir).replace(/\/+$/, "");
  return a !== b && insideLower(a, b);
}

/**
 * 按可写范围这个路径能不能写：不在任何受保护根里、或在放行的目录里就能写。相对路径按 cwd 解析，~/$HOME/%USERPROFILE% 按 homeDir 展开。
 * 给要自己判断路径的地方用（codex 的审批）；能用 OS 沙箱的厂商不靠它。
 */
export function scopeAllowsWrite(scope: WriteScope, targetPath: string, cwd?: string, homeDir?: string): boolean {
  if (targetPath.trim() === "") return true;
  if (hasUnsafeWindowsColonSyntax(targetPath)) return false;
  const p = resolveLower(targetPath, cwd, homeDir);
  const roots = protectedRootsOf(scope);
  const inProtected = roots.some((root) => insideLower(p, resolveLower(root, undefined, homeDir)));
  if (!inProtected) return true;
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
const CD_SEGMENT = /^[\s({]*(?:\S*\b(?:sh|bash|zsh|cmd(?:\.exe)?|pwsh(?:\.exe)?|powershell(?:\.exe)?)\s+(?:[-/]\w+\s+)*[-/](?:c|Command)\s+['"]?)?\s*(cd|pushd|popd|Set-Location)\b\s*(.*)$/i;

/** 这一段 cd 之后的工作目录；看不出来（cd -、popd、带变量）返回 null。 */
function cdTarget(verb: string, rawArgs: string, dir: string | null): string | null {
  if (verb.toLowerCase() === "popd") return null;
  const arg = rawArgs
    .replace(/['"]/g, "")
    .split(/\s+/)
    .find((a) => a !== "" && a.toLowerCase() !== "/d" && (a === "-" || !a.startsWith("-")));
  if (arg === undefined || arg === "~") return "~";
  if (hasUnsafeWindowsColonSyntax(arg)) return null;
  if (arg === "-" || /[`*?]|\$(?!\{?HOME\b|env:USERPROFILE\b)/i.test(arg) || (/%.+%/.test(arg) && !/^%USERPROFILE%([\\/]|$)/i.test(arg))) {
    return null;
  }
  if (arg.startsWith("/") || /^[A-Za-z]:[\\/]/.test(arg) || arg.startsWith("\\\\") || isHomeExpr(arg)) return arg;
  return dir === null ? null : `${dir.replace(/[\\/]+$/, "")}/${arg}`;
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
