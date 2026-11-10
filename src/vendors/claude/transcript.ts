// claude 的原始记录在哪（docs/vendor-plugin-design.md 的 C8，按家分发在 src/daemon/driver/transcript.ts）。
// <CLAUDE_CONFIG_DIR，默认 ~/.claude>/projects/<目录名>/<会话 ID>.jsonl。
// 目录名 = 工作目录路径里非字母数字的字符都换成 "-"（/Users/a.b/.x → -Users-a-b--x）；超过 200 个字符的截成 200 个再接一个路径的哈希。
// 工作目录是软链时 claude 用的是真实路径（/tmp/x 存在 -private-tmp-x 下），所以原样和 realpath 两种都查。
// 出处：https://code.claude.com/docs/en/sessions（Where transcripts are stored）、https://code.claude.com/docs/en/claude-directory。
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isFile, listDir, safeId, type TranscriptRef, type TranscriptRoots } from "../../daemon/driver/transcript-files.ts";

/** claude 目录名超过这么多字符就截断再接哈希。 */
const CLAUDE_PROJECT_DIR_MAX = 200;

/** claude 的目录名：非字母数字都换成 "-"。 */
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
    // 目录已经没了：只按原样的路径查
  }
  for (const dir of cwds) {
    const name = claudeProjectDirName(dir);
    if (name.length <= CLAUDE_PROJECT_DIR_MAX) {
      const file = join(projects, name, `${id}.jsonl`);
      if (isFile(file)) return file;
      continue;
    }
    // 太长的：前 200 个字符 + 哈希。哈希不自己算，找以前 200 个字符开头的目录里有这个会话文件的
    const prefix = name.slice(0, CLAUDE_PROJECT_DIR_MAX);
    for (const entry of listDir(projects)) {
      if (!entry.startsWith(prefix)) continue;
      const file = join(projects, entry, `${id}.jsonl`);
      if (isFile(file)) return file;
    }
  }
  return null;
}
