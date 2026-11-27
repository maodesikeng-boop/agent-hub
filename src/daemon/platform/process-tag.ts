// Invariant: process tagging and reaping never target PID <= 1, the daemon itself, or processes owned by another user.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SessionId } from "../../shared/domain.ts";
import { ENV_SESSION_OWNER_TAG, KILL_WAIT_MS, PS_TIMEOUT_MS, SESSION_TAG_MAX_DEPTH } from "../../shared/limits.ts";
import { isAlive, signalPid, waitForExit } from "../driver/process.ts";
import { isPathInsideOrEqual } from "./win32/path-key.ts";

export interface TaggedProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly tag: string;
  readonly command: string;
  readonly cwd: string | null;
}

export interface ListTaggedProcessesOptions {
  readonly platform?: NodeJS.Platform;
  readonly procRoot?: string;
  readonly ownPid?: number;
  readonly ownUid?: number;
  readonly runPs?: (args: string[]) => Promise<string | null>;
  readonly cwdOf?: (pids: readonly number[]) => Promise<ReadonlyMap<number, string>>;
}

export interface ReapTaggedProcessesOptions extends ListTaggedProcessesOptions {
  readonly killWaitMs?: number;
  /** Only matching processes (and their process groups) are stopped; the rest are left running. */
  readonly select?: (proc: TaggedProcessInfo) => boolean;
}

export interface ReapTaggedProcessesResult {
  readonly reapedPids: readonly number[];
  readonly survivingPids: readonly number[];
}

const MAX_REAP_SCAN_ROUNDS = 3;
const MAX_COMMAND_CHARS = 200;
const PS_MAX_BUFFER = 16 * 1024 * 1024;
const VALID_NONCE = /^[A-Za-z0-9_-]+$/;
const TAG_ENV_PATTERN = new RegExp(`(?:^|\\s)${ENV_SESSION_OWNER_TAG}=([^\\s]+)`);

function splitTagTokens(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function findMatchingTagToken(envValue: string, tag: string): string | null {
  if (envValue === "" || tag === "") return null;
  const isPrefix = tag.endsWith(":");
  const isSuffix = !isPrefix && tag.startsWith(":");
  for (const token of splitTagTokens(envValue)) {
    if (isPrefix ? token.startsWith(tag) : isSuffix ? token.endsWith(tag) : token === tag) return token;
  }
  return null;
}

function appendOwnerTag(ownToken: string, parentTag?: string): string {
  if (parentTag === undefined || parentTag.trim() === "") return ownToken;
  const ancestors = splitTagTokens(parentTag).filter((token) => token !== ownToken);
  const kept = ancestors.slice(0, Math.max(0, SESSION_TAG_MAX_DEPTH - 1));
  return [...kept, ownToken].join(",");
}

/**
 * Precondition: sessionId is a positive integer and nonce is a non-empty alphanumeric token.
 * Postcondition: returns a tag string carrying this session's token, appending to parentTag up to SESSION_TAG_MAX_DEPTH ancestors when present.
 */
export function makeSessionOwnerTag(sessionId: SessionId, nonce: string, parentTag?: string): string {
  if (!Number.isInteger(sessionId) || sessionId <= 0) {
    throw new Error(`Invalid sessionId for owner tag: ${sessionId}`);
  }
  if (!VALID_NONCE.test(nonce)) {
    throw new Error(`Invalid nonce for owner tag: ${nonce}`);
  }
  return appendOwnerTag(`s${sessionId}:${nonce}`, parentTag);
}

/**
 * Precondition: watchId is a positive integer and nonce is a non-empty alphanumeric token.
 * Postcondition: returns a tag string carrying this watch's token, appending to parentTag up to SESSION_TAG_MAX_DEPTH ancestors when present.
 */
export function makeWatchOwnerTag(watchId: number, nonce: string, parentTag?: string): string {
  if (!Number.isInteger(watchId) || watchId <= 0) {
    throw new Error(`Invalid watchId for owner tag: ${watchId}`);
  }
  if (!VALID_NONCE.test(nonce)) {
    throw new Error(`Invalid nonce for owner tag: ${nonce}`);
  }
  return appendOwnerTag(`watch${watchId}:${nonce}`, parentTag);
}

/**
 * Precondition: envValue is the raw value of ENV_SESSION_OWNER_TAG and tag is a single session token.
 * Postcondition: returns true if and only if tag matches an exact comma-delimited token inside envValue.
 */
export function envContainsSessionTag(envValue: string, tag: string): boolean {
  if (envValue === "" || tag === "" || tag.includes(",")) return false;
  return splitTagTokens(envValue).some((token) => token === tag);
}

/**
 * Precondition: roots are real absolute paths owned by one session (its working directory, temp dir).
 * Postcondition: true only when the process runs inside one of roots; a tagged process elsewhere may be a shared service another session or the user still relies on.
 */
export function runsInsideRoots(proc: Pick<TaggedProcessInfo, "cwd">, roots: readonly string[]): boolean {
  const cwd = proc.cwd;
  if (cwd === null) return false;
  return roots.some((root) => root !== "" && isPathInsideOrEqual(root, cwd));
}

export function parseLsofCwd(stdout: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) {
      const parsed = Number(line.slice(1));
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } else if (line.startsWith("n") && pid !== null) {
      cwds.set(pid, line.slice(1));
    }
  }
  return cwds;
}

function runLsofCwd(pids: readonly number[]): Promise<ReadonlyMap<number, string>> {
  if (pids.length === 0) return Promise.resolve(new Map());
  return new Promise((resolve) => {
    try {
      // lsof exits 1 when any pid vanished but still prints the others, so stdout is parsed regardless of the exit code.
      execFile(
        "lsof",
        ["-a", "-d", "cwd", "-p", pids.join(","), "-Fn"],
        { timeout: PS_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: PS_MAX_BUFFER, env: { ...process.env, LC_ALL: "C" } },
        (_error, stdout) => resolve(parseLsofCwd(String(stdout ?? ""))),
      );
    } catch {
      resolve(new Map());
    }
  });
}

function readLinuxCwd(procDir: string): string | null {
  try {
    return readlinkSync(join(procDir, "cwd")).replace(/ \(deleted\)$/, "");
  } catch {
    return null;
  }
}

function runPsWide(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        "ps",
        args,
        { timeout: PS_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: PS_MAX_BUFFER, env: { ...process.env, LC_ALL: "C" } },
        (error, stdout) => resolve(error ? null : stdout),
      );
    } catch {
      resolve(null);
    }
  });
}

async function listDarwinTagged(
  tag: string,
  ownPid: number,
  ownUid: number | undefined,
  ps: (args: string[]) => Promise<string | null>,
  cwdOf: (pids: readonly number[]) => Promise<ReadonlyMap<number, string>>,
): Promise<TaggedProcessInfo[] | null> {
  const stdout = await ps(["eww", "-A", "-o", "pid=,ppid=,pgid=,uid=,command="]);
  if (stdout === null) return null;
  const results: Omit<TaggedProcessInfo, "cwd">[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const pgid = Number(match[3]);
    const uid = Number(match[4]);
    if (pid <= 1 || pid === ownPid) continue;
    if (ownUid !== undefined && uid !== ownUid) continue;
    const rest = match[5]!;
    const tagMatch = TAG_ENV_PATTERN.exec(rest);
    if (tagMatch === null) continue;
    const matchedToken = findMatchingTagToken(tagMatch[1]!, tag);
    if (matchedToken === null) continue;
    const command = rest.slice(0, Math.min(tagMatch.index, MAX_COMMAND_CHARS)).trim() || rest.slice(0, MAX_COMMAND_CHARS).trim();
    results.push({ pid, ppid, pgid, tag: matchedToken, command });
  }
  const cwds = await cwdOf(results.map((proc) => proc.pid));
  return results.map((proc) => ({ ...proc, cwd: cwds.get(proc.pid) ?? null }));
}

function parseLinuxStat(raw: string): { ppid: number; pgid: number } | null {
  const closeParen = raw.lastIndexOf(")");
  if (closeParen < 0) return null;
  const fields = raw.slice(closeParen + 1).trim().split(/\s+/);
  // After comm and state (index 0), field 1 is ppid and field 2 is pgrp.
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  if (!Number.isInteger(ppid) || !Number.isInteger(pgid)) return null;
  return { ppid, pgid };
}

function listLinuxTagged(tag: string, procRoot: string, ownPid: number, ownUid: number | undefined): TaggedProcessInfo[] | null {
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return null;
  }
  const envPrefix = `${ENV_SESSION_OWNER_TAG}=`;
  const results: TaggedProcessInfo[] = [];
  for (const name of entries) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    const pid = Number(name);
    if (pid <= 1 || pid === ownPid) continue;
    const procDir = join(procRoot, name);
    if (ownUid !== undefined) {
      try {
        if (statSync(procDir).uid !== ownUid) continue;
      } catch {
        continue;
      }
    }
    let envRaw: string;
    try {
      envRaw = readFileSync(join(procDir, "environ"), "utf8");
    } catch {
      continue;
    }
    const envEntry = envRaw.split("\0").find((entry) => entry.startsWith(envPrefix));
    if (envEntry === undefined) continue;
    const matchedToken = findMatchingTagToken(envEntry.slice(envPrefix.length), tag);
    if (matchedToken === null) continue;
    let ppid = 0;
    let pgid = 0;
    try {
      const parsed = parseLinuxStat(readFileSync(join(procDir, "stat"), "utf8"));
      if (parsed !== null) {
        ppid = parsed.ppid;
        pgid = parsed.pgid;
      }
    } catch {
    }
    let command = "";
    try {
      command = readFileSync(join(procDir, "cmdline"), "utf8").replaceAll("\0", " ").trim().slice(0, MAX_COMMAND_CHARS);
    } catch {
    }
    results.push({ pid, ppid, pgid, tag: matchedToken, command, cwd: readLinuxCwd(procDir) });
  }
  return results;
}

/**
 * Precondition: tag is a non-empty single session owner token (or prefix ending in ":").
 * Postcondition: returns same-user processes carrying tag via ps eww on darwin, /proc/<pid>/environ on linux, or empty array on win32 where Job Objects own descendants; excludes ownPid and PID <= 1.
 */
export async function listTaggedProcesses(
  tag: string,
  options?: ListTaggedProcessesOptions,
): Promise<TaggedProcessInfo[]> {
  return (await scanTaggedProcesses(tag, options)) ?? [];
}

/**
 * Precondition: same as listTaggedProcesses.
 * Postcondition: like listTaggedProcesses, but returns null when the process table could not be read, so callers can tell "none running" from "unknown".
 */
export async function scanTaggedProcesses(
  tag: string,
  options?: ListTaggedProcessesOptions,
): Promise<TaggedProcessInfo[] | null> {
  if (tag === "") return [];
  const platform = options?.platform ?? process.platform;
  if (platform === "win32") return [];
  const ownPid = options?.ownPid ?? process.pid;
  const ownUid = options?.ownUid ?? process.getuid?.();
  if (platform === "darwin") return listDarwinTagged(tag, ownPid, ownUid, options?.runPs ?? runPsWide, options?.cwdOf ?? runLsofCwd);
  if (platform === "linux") {
    const found = listLinuxTagged(tag, options?.procRoot ?? "/proc", ownPid, ownUid);
    if (found === null || options?.cwdOf === undefined) return found;
    const cwds = await options.cwdOf(found.map((proc) => proc.pid));
    return found.map((proc) => ({ ...proc, cwd: cwds.get(proc.pid) ?? null }));
  }
  return [];
}

async function resolveOwnPgid(
  platform: NodeJS.Platform,
  ownPid: number,
  procRoot: string,
  ps: (args: string[]) => Promise<string | null>,
): Promise<number | null> {
  if (platform === "linux") {
    try {
      return parseLinuxStat(readFileSync(join(procRoot, String(ownPid), "stat"), "utf8"))?.pgid ?? null;
    } catch {
      return null;
    }
  }
  if (platform === "darwin") {
    const out = await ps(["-p", String(ownPid), "-o", "pgid="]);
    const pgid = out === null ? Number.NaN : Number(out.trim());
    return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
  }
  return null;
}

/**
 * Precondition: tag identifies a retired or ending session whose children should no longer run.
 * Postcondition: SIGSTOPs and SIGKILLs every matching process accepted by select (plus the process groups those processes lead, never the daemon's own), waits up to killWaitMs, and reports reaped and surviving PIDs.
 */
export async function reapTaggedProcesses(
  tag: string,
  options?: ReapTaggedProcessesOptions,
): Promise<ReapTaggedProcessesResult> {
  const platform = options?.platform ?? process.platform;
  if (tag === "" || platform === "win32") return { reapedPids: [], survivingPids: [] };
  const ownPid = options?.ownPid ?? process.pid;
  const procRoot = options?.procRoot ?? "/proc";
  const ownPgid = await resolveOwnPgid(platform, ownPid, procRoot, options?.runPs ?? runPsWide);
  const targets = new Set<number>();
  const targetedPids = new Set<number>();

  try {
    for (let round = 0; round < MAX_REAP_SCAN_ROUNDS; round++) {
      const found = await listTaggedProcesses(tag, options);
      let added = false;
      for (const proc of found) {
        if (options?.select !== undefined && !options.select(proc)) continue;
        if (proc.pid <= 1 || proc.pid === ownPid) continue;
        if (!targetedPids.has(proc.pid)) {
          targetedPids.add(proc.pid);
          added = true;
        }
        // Only a tagged group leader's group is killed, so a session never takes down a group some other program leads.
        const groupTarget = ownPgid !== null && proc.pgid === proc.pid && proc.pgid > 1 && proc.pgid !== ownPgid ? -proc.pgid : null;
        if (groupTarget !== null && !targets.has(groupTarget)) {
          targets.add(groupTarget);
          signalPid(groupTarget, "SIGSTOP");
          added = true;
        }
        if (!targets.has(proc.pid)) {
          targets.add(proc.pid);
          signalPid(proc.pid, "SIGSTOP");
          added = true;
        }
      }
      if (!added) break;
    }
  } finally {
    for (const target of targets) {
      signalPid(target, "SIGKILL");
    }
  }

  const deadline = Date.now() + (options?.killWaitMs ?? KILL_WAIT_MS);
  const reapedPids: number[] = [];
  const survivingPids: number[] = [];
  for (const pid of targetedPids) {
    const remaining = Math.max(0, deadline - Date.now());
    const exited = !isAlive(pid) || (remaining > 0 && (await waitForExit(pid, remaining)));
    if (exited) reapedPids.push(pid);
    else survivingPids.push(pid);
  }
  return { reapedPids, survivingPids };
}
