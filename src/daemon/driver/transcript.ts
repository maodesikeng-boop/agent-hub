// 会话的“原始记录在哪”：我们不存会话原文，只在账本 agent_sessions 里记 vendor、vendor_session_id、cwd；
// 具体内容在各家厂商自己的目录里，这里按这三样算出路径（hub worker show 的“原始记录”那一行用）。
// 算不出来、文件不存在就返回 null（“找不到”），不猜。只读文件系统，不写、不删。
//
// 三家实际的位置（本机 2026-11 核对过，官方文档有的附出处）：
// - claude：<CLAUDE_CONFIG_DIR，默认 ~/.claude>/projects/<目录名>/<会话 ID>.jsonl。
//   目录名 = 工作目录路径里非字母数字的字符都换成 "-"（/Users/a.b/.x → -Users-a-b--x）；超过 200 个字符的截成 200 个再接一个路径的哈希。
//   工作目录是软链时 claude 用的是真实路径（/tmp/x 存在 -private-tmp-x 下），所以原样和 realpath 两种都查。
//   出处：https://code.claude.com/docs/en/sessions（Where transcripts are stored）、https://code.claude.com/docs/en/claude-directory。
// - codex：<CODEX_HOME，默认 ~/.codex>/sessions/年/月/日/rollout-<本地时间>-<thread id>.jsonl；老的会压成 .jsonl.zst；
//   归档的在 <CODEX_HOME>/archived_sessions/ 下同样的文件名（不分日期目录）。日期是会话开始那天，我们的账本里没有，
//   所以按 thread id 在日期目录里找，不算日期。
//   出处：https://developers.openai.com/codex/app/troubleshooting（Session transcripts / Archived sessions）；
//   文件名的拼法见 openai/codex 的 codex-rs/rollout/src/recorder.rs。
// - agy：~/.gemini/antigravity-cli/conversations/<conversation id>.db（一个 SQLite 文件，一个会话一个）；
//   brain/<conversation id>/ 只放它的临时文件（scratch），不是对话内容。官方文档没写这个存储位置，只有本机核对。
import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agyCliDataDir, agyDataPaths } from "../../shared/paths.ts";
import type { AgentVendor } from "../../shared/vendors.ts";

export interface TranscriptRef {
  vendor: string;
  vendorSessionId: string;
  cwd: string;
}

interface TranscriptRoots {
  /** 用户目录，默认 os.homedir()；测试用。 */
  home?: string;
  /** 环境变量，默认 process.env（CLAUDE_CONFIG_DIR、CODEX_HOME）。 */
  env?: Readonly<Record<string, string | undefined>>;
}

/** claude 目录名超过这么多字符就截断再接哈希。 */
const CLAUDE_PROJECT_DIR_MAX = 200;

/** 会话 ID 要能当文件名的一部分：不含路径分隔符，也不是 . / ..。 */
function safeId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id);
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const listDir = (path: string): string[] => {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
};

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

export function agyTranscriptPath(ref: TranscriptRef, roots: TranscriptRoots = {}): string | null {
  const id = ref.vendorSessionId;
  if (!safeId(id)) return null;
  const file = agyDataPaths(agyCliDataDir(roots.home)).conversationDb(id);
  return isFile(file) ? file : null;
}

/** 按厂商分发；不认识的厂商返回 null。 */
export function vendorTranscriptPath(ref: TranscriptRef, roots: TranscriptRoots = {}): string | null {
  const finders: Record<AgentVendor, (ref: TranscriptRef, roots: TranscriptRoots) => string | null> = {
    claude: claudeTranscriptPath,
    codex: codexTranscriptPath,
    agy: agyTranscriptPath,
  };
  const find = (finders as Record<string, ((ref: TranscriptRef, roots: TranscriptRoots) => string | null) | undefined>)[ref.vendor];
  return find === undefined ? null : find(ref, roots);
}
