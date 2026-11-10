// codex 的原始记录在哪（docs/vendor-plugin-design.md 的 C8，按家分发在 src/daemon/driver/transcript.ts）。
// <CODEX_HOME，默认 ~/.codex>/sessions/年/月/日/rollout-<本地时间>-<thread id>.jsonl；老的会压成 .jsonl.zst；
// 归档的在 <CODEX_HOME>/archived_sessions/ 下同样的文件名（不分日期目录）。日期是会话开始那天，我们的账本里没有，
// 所以按 thread id 在日期目录里找，不算日期。
// 出处：https://developers.openai.com/codex/app/troubleshooting（Session transcripts / Archived sessions）；
// 文件名的拼法见 openai/codex 的 codex-rs/rollout/src/recorder.rs。
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
  // 年/月/日：新的在后面，倒着找（正在用的会话几乎都在最近几天）
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
