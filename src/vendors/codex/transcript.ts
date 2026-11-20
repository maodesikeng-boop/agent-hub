// Rollouts live in sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl (older ones .jsonl.zst); archived ones are flat.
import { homedir } from "node:os";
import { join } from "node:path";
import { listDir, safeId, type TranscriptRef, type TranscriptRoots } from "../../daemon/driver/transcript-files.ts";

export function codexTranscriptPath(ref: TranscriptRef, roots: TranscriptRoots = {}): string | null {
  const id = ref.vendorSessionId;
  if (!safeId(id)) return null;
  const env = roots.env ?? process.env;
  const codexHome = env.CODEX_HOME ?? join(roots.home ?? homedir(), ".codex");
  const names = new Set([`-${id}.jsonl`, `-${id}.jsonl.zst`]);
  const match = (dir: string): string | null => {
    for (const name of listDir(dir)) {
      if (!name.startsWith("rollout-")) continue;
      for (const tail of names) if (name.endsWith(tail)) return join(dir, name);
    }
    return null;
  };
  const sessions = join(codexHome, "sessions");
  const newestFirst = (dir: string) => listDir(dir).filter((n) => /^\d+$/.test(n)).sort().reverse();
  for (const year of newestFirst(sessions)) {
    for (const month of newestFirst(join(sessions, year))) {
      for (const day of newestFirst(join(sessions, year, month))) {
        const found = match(join(sessions, year, month, day));
        if (found !== null) return found;
      }
    }
  }
  return match(join(codexHome, "archived_sessions"));
}
