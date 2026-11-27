import type { AgentRole } from "./domain.ts";

export interface WriteScope {
  dataDir: string;
  protectedRoots?: string[];
  writableDirs: string[];
  readScope: DataDirReadScope;
}

export type WriteBounds = Pick<WriteScope, "dataDir" | "protectedRoots" | "writableDirs">;

export function protectedRootsOf(scope: WriteBounds): string[] {
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

export interface DataDirReadScope {
  dataDir: string;
  readable: string[];
  connectable: string[];
}

export const DATA_DIR_READABLE_ENTRIES: readonly string[] = ["worktrees", "uploads", "tools"];
export const RUN_DIR_READABLE_ENTRIES: readonly string[] = ["bin"];
export const RUN_DIR_CONNECTABLE_ENTRIES: readonly string[] = ["hub.sock"];

function joinUnder(base: string, ...parts: string[]): string {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return [base.replace(/[\\/]+$/, ""), ...parts].join(sep);
}

export function dataDirReadScope(input: { dataDir: string; launchDir?: string; extraReadable?: readonly string[] }): DataDirReadScope {
  const dataDir = trimSlash(input.dataDir);
  const readable = [
    ...DATA_DIR_READABLE_ENTRIES.map((e) => joinUnder(dataDir, e)),
    ...RUN_DIR_READABLE_ENTRIES.map((e) => joinUnder(dataDir, "run", e)),
  ];
  const covered = (p: string) => readable.some((r) => insideLower(resolveLower(p), resolveLower(r)));
  for (const raw of [...(input.launchDir === undefined ? [] : [input.launchDir]), ...(input.extraReadable ?? [])]) {
    const p = trimSlash(raw);
    if (!isStrictlyInside(p, dataDir) || covered(p)) continue;
    readable.push(p);
  }
  return { dataDir, readable, connectable: RUN_DIR_CONNECTABLE_ENTRIES.map((e) => joinUnder(dataDir, "run", e)) };
}

export function workerWriteScope(input: {
  role: AgentRole;
  dataDir: string;
  protectedRoots?: readonly string[];
  cwd: string;
  addDirs?: readonly string[];
  launchDir?: string;
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
    readScope: dataDirReadScope({
      dataDir,
      ...(input.launchDir === undefined ? {} : { launchDir: input.launchDir }),
      extraReadable: [cwd, ...(input.addDirs ?? [])],
    }),
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

// Drive-relative paths (C:foo) and NTFS alternate data streams (a.txt:zone) cannot be attributed safely.
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

// NFC then case-fold because APFS and NTFS are case-insensitive by default.
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

export function scopeAllowsWrite(scope: WriteBounds, targetPath: string, cwd?: string, homeDir?: string): boolean {
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

function splitShellSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[;\n|]|(?<![<>])&(?!>)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const CD_SEGMENT = /^[\s({]*(?:\S*\b(?:sh|bash|zsh|cmd(?:\.exe)?|pwsh(?:\.exe)?|powershell(?:\.exe)?)\s+(?:[-/]\w+\s+)*[-/](?:c|Command)\s+['"]?)?\s*(cd|pushd|popd|Set-Location)\b\s*(.*)$/i;

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

function segmentMayWriteOutsideScope(segment: string, scope: WriteBounds, dir: string | null, homeDir?: string): boolean {
  const tokens = segment
    .split(/[\s><|&;'"`()=]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const touches = dir === null || !scopeAllowsWrite(scope, dir, undefined, homeDir) || tokens.some((tok) => !scopeAllowsWrite(scope, tok, dir, homeDir));
  if (!touches) return false;
  if (SHELL_WRITE_INDICATORS.test(segment)) return true;
  return !READONLY_COMMAND.test(segment);
}

// Literal-only fallback when no OS sandbox exists; variables, generated paths and symlinks are invisible here.
export function commandMayWriteOutsideScope(command: string, scope: WriteBounds, cwd: string, homeDir?: string): boolean {
  let dir: string | null = cwd;
  for (const segment of splitShellSegments(command)) {
    const cd = CD_SEGMENT.exec(segment);
    if (cd) dir = cdTarget(cd[1]!, cd[2] ?? "", dir);
    else if (segmentMayWriteOutsideScope(segment, scope, dir, homeDir)) return true;
  }
  return false;
}

export function prependMissingArgs(prefix: readonly string[], args: readonly string[]): string[] {
  if (prefix.length === 0) return [...args];
  for (let i = 0; i + prefix.length <= args.length; i++) {
    if (prefix.every((token, offset) => args[i + offset] === token)) return [...args];
  }
  return [...prefix, ...args];
}
