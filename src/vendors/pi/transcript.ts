// Pi 的原始会话记录路径定位（docs/vendors/pi.md 第 5 节）：
// 默认位于 <PI_CODING_AGENT_SESSION_DIR ?? (PI_CODING_AGENT_DIR ?? ~/.pi/agent)/sessions>/--<encoded-cwd>--/<ISO-timestamp>_<sessionId>.jsonl。
// 实测 macOS 下 Pi 子进程按 realpath 后的 process.cwd() 编码目录名（如 /var/... → --private-var-...--），
// 因此同时查 realpathSync(cwd) 与原始 cwd 对应的目录，未命中时扫描 sessions/ 下最近子目录兜底。
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { listDir, safeId, type TranscriptRef, type TranscriptRoots } from "../../daemon/driver/transcript-files.ts";
import { MAX_PI_SESSION_SUBDIRS_SCAN } from "./limits.ts";

/** Pi 把工作目录编码成 `--<去掉前导分隔符后把 / \ : 换成 ->--`。 */
export function piSessionDirName(cwd: string): string {
  const stripped = cwd.replace(/^[/\\]+/, "");
  const encoded = stripped.replace(/[/\\:]/g, "-");
  return `--${encoded}--`;
}

/** 解析 Pi 的会话根目录（优先 PI_CODING_AGENT_SESSION_DIR，其次 PI_CODING_AGENT_DIR/sessions，默认 ~/.pi/agent/sessions）。 */
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

/** 在单个编码目录中找出匹配 `_<id>.jsonl` 的文件（若有多个，按 ISO 时间戳文件名倒序返回最新的一份）。 */
function findSessionFilesInDir(dir: string, id: string): string[] {
  const suffix = `_${id}.jsonl`;
  const exact = `${id}.jsonl`;
  return listDir(dir)
    .filter((name) => name === exact || name.endsWith(suffix))
    .sort()
    .reverse()
    .map((name) => join(dir, name));
}

/** 找出该会话在 Pi sessions 目录下留下的所有 JSONL 文件（最新在前）。 */
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

  // 兜底：若工作目录软链变化或跨目录迁移，扫描 sessionsRoot 下子目录（有硬上限防无界遍历）
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
