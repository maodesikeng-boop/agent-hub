// Dir names replace non-alphanumerics with -; names over 200 chars are truncated and suffixed with a hash.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isFile, listDir, safeId, type TranscriptRef, type TranscriptRoots } from "../../daemon/driver/transcript-files.ts";

const CLAUDE_PROJECT_DIR_MAX = 200;

export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function claudeTranscriptPath(ref: TranscriptRef, roots: TranscriptRoots = {}): string | null {
  const { vendorSessionId: id, cwd } = ref;
  if (!safeId(id) || cwd === "") return null;
  const env = roots.env ?? process.env;
  const configDir = env.CLAUDE_CONFIG_DIR ?? join(roots.home ?? homedir(), ".claude");
  const projects = join(configDir, "projects");
  const cwds = [cwd];
  try {
    const real = realpathSync(cwd);
    if (real !== cwd) cwds.push(real);
  } catch {
  }
  for (const dir of cwds) {
    const name = claudeProjectDirName(dir);
    if (name.length <= CLAUDE_PROJECT_DIR_MAX) {
      const file = join(projects, name, `${id}.jsonl`);
      if (isFile(file)) return file;
      continue;
    }
    // claude's hash is not reproducible here, so search dirs sharing the 200-char prefix.
    const prefix = name.slice(0, CLAUDE_PROJECT_DIR_MAX);
    for (const entry of listDir(projects)) {
      if (!entry.startsWith(prefix)) continue;
      const file = join(projects, entry, `${id}.jsonl`);
      if (isFile(file)) return file;
    }
  }
  return null;
}
