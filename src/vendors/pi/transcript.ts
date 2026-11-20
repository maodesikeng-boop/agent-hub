// pi encodes the realpath of cwd (/var -> --private-var-...).
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { listDir, safeId, type TranscriptRef, type TranscriptRoots } from "../../daemon/driver/transcript-files.ts";
import { MAX_PI_SESSION_SUBDIRS_SCAN } from "./limits.ts";

// pi encodes cwd as --<path with / \ : replaced by ->--.
export function piSessionDirName(cwd: string): string {
  const stripped = cwd.replace(/^[/\\]+/, "");
  const encoded = stripped.replace(/[/\\:]/g, "-");
  return `--${encoded}--`;
}

export function piSessionsRoot(roots: TranscriptRoots = {}): string {
  const env = roots.env ?? process.env;
  if (typeof env.PI_CODING_AGENT_SESSION_DIR === "string" && env.PI_CODING_AGENT_SESSION_DIR.trim() !== "") {
    return env.PI_CODING_AGENT_SESSION_DIR.trim();
  }
  const configDir =
    typeof env.PI_CODING_AGENT_DIR === "string" && env.PI_CODING_AGENT_DIR.trim() !== ""
      ? env.PI_CODING_AGENT_DIR.trim()
      : join(roots.home ?? homedir(), ".pi", "agent");
  return join(configDir, "sessions");
}

function realpathWithDeletedTail(target: string): string | null {
  if (!target) return null;
  const tail: string[] = [];
  let cur = target;
  for (let depth = 0; depth < 32; depth++) {
    try {
      const resolved = realpathSync(cur);
      return tail.length === 0 ? resolved : join(resolved, ...tail.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return null;
      tail.push(basename(cur));
      cur = parent;
    }
  }
  return null;
}

function findSessionFilesInDir(dir: string, id: string): string[] {
  const suffix = `_${id}.jsonl`;
  const exact = `${id}.jsonl`;
  return listDir(dir)
    .filter((name) => name === exact || name.endsWith(suffix))
    .sort()
    .reverse()
    .map((name) => join(dir, name));
}

export function piSessionFiles(ref: TranscriptRef, roots: TranscriptRoots = {}): string[] {
  const id = ref.vendorSessionId;
  if (!safeId(id)) return [];
  const sessionsRoot = piSessionsRoot(roots);
  const candidateDirs: string[] = [];
  const addCandidate = (cwd: string | null) => {
    if (!cwd) return;
    const dir = join(sessionsRoot, piSessionDirName(cwd));
    if (!candidateDirs.includes(dir)) candidateDirs.push(dir);
  };
  addCandidate(realpathWithDeletedTail(ref.cwd));
  addCandidate(ref.cwd);

  const found: string[] = [];
  for (const dir of candidateDirs) {
    for (const file of findSessionFilesInDir(dir, id)) {
      if (!found.includes(file)) found.push(file);
    }
  }
  if (found.length > 0) return found;

  const subdirs = listDir(sessionsRoot).slice(0, MAX_PI_SESSION_SUBDIRS_SCAN);
  for (const sub of subdirs) {
    const dir = join(sessionsRoot, sub);
    if (candidateDirs.includes(dir)) continue;
    for (const file of findSessionFilesInDir(dir, id)) {
      if (!found.includes(file)) found.push(file);
    }
  }
  return found;
}

export function piTranscriptPath(ref: TranscriptRef, roots: TranscriptRoots = {}): string | null {
  return piSessionFiles(ref, roots)[0] ?? null;
}
