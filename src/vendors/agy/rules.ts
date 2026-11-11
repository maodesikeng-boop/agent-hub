// agy 的产品提示词常驻通道（spec 的 capabilities.systemPrompt 是 "resident"，docs/system-prompt-channels.md 第 2 节）：
// agy 没有系统提示词参数，但会把每个工作区（cwd 和每个 --add-dir）下 .agents/rules/*.md 里 trigger: always_on 的规则
// 放进系统提示词的 <user_rules> 区，agy 内部压缩对话（/compact、自动压缩）只换掉历史、这一区每个请求都重新带上（2026-11-11 实测）。
// 所以每次起进程前把 prompt.md 切块写进启动目录（守护进程自己的 ~/.agent-hub/state/launch/<会话>/）下的规则目录，再 --add-dir 它：
// 不写用户的项目目录和 worktree，git status 不多东西；只读 Worker 的沙箱哪里都能读（密钥除外），也读得到。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { AGY_RULE_FILE_MAX_BYTES, AGY_RULE_FILES_MAX, AGY_RULE_TOTAL_BUDGET_BYTES, AGY_RULE_SINGLE_BUDGET_BYTES } from "./limits.ts";

/** 启动目录下放规则的工作区目录名（--add-dir 它）。 */
export const AGY_RULES_WORKSPACE_DIR = "agy-rules";
/** 工作区里规则文件的相对目录（agy 的工作区自定义根是 .agents，规则在它的 rules/ 下）。 */
const RULES_SUBDIR = join(".agents", "rules");
/** 规则文件名：fusa-01.md、fusa-02.md……agy 按文件名顺序拼，两位数保证 01..08 的顺序。 */
const RULE_FILE_RE = /^fusa-\d{2}\.md$/;
const ruleFileName = (index: number) => `fusa-${String(index + 1).padStart(2, "0")}.md`;
/** 常驻规则的 frontmatter（agy 的 trigger：always_on 每个请求都带）。 */
const RULE_FRONTMATTER = "---\ntrigger: always_on\n---\n";

function utf8Cut(buf: Buffer, maxBytes: number): number {
  let end = Math.min(maxBytes, buf.length);
  while (end > 0 && end < buf.length && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return end;
}

/**
 * 把提示词按字节切块：每块不超过 maxBytes，尽量在换行处断（断在块内最后一个换行之后），一行本身超长才按 UTF-8 字符边界硬切。
 * 最多 maxChunks 块，超出的部分截掉、在最后一块末尾写明截掉了多少字节。空白提示词返回 []。
 */
export function splitPromptForRules(prompt: string, maxBytes = AGY_RULE_FILE_MAX_BYTES, maxChunks = AGY_RULE_FILES_MAX): string[] {
  const text = prompt.trim();
  if (text === "") return [];
  const buf = Buffer.from(text, "utf8");
  const chunks: string[] = [];
  let start = 0;
  while (start < buf.length && chunks.length < maxChunks) {
    let end = start + utf8Cut(buf.subarray(start), maxBytes);
    if (end < buf.length) {
      const newline = buf.lastIndexOf(0x0a, end - 1);
      if (newline >= start) end = newline + 1;
    }
    chunks.push(buf.subarray(start, end).toString("utf8"));
    start = end;
  }
  if (start < buf.length) {
    chunks[chunks.length - 1] += `\n\n（提示词超过 ${maxBytes * maxChunks} 字节，后面 ${buf.length - start} 字节没放进规则区）\n`;
  }
  return chunks;
}

/**
 * 按 prompt.md 重写这个会话的规则目录，返回要 --add-dir 的工作区目录；提示词空白返回 null（不加 --add-dir）。
 * 每次起进程都调：内容跟着 prompt.md（性格设定改了下次起进程就是新的）；块数变少时删掉多出来的旧块，目录里的文件数不会越变越多。
 */
export function writeAgyPromptRules(promptFile: string): string | null {
  let prompt = "";
  try {
    prompt = readFileSync(promptFile, "utf8");
  } catch {
    prompt = "";
  }
  const workspace = join(dirname(promptFile), AGY_RULES_WORKSPACE_DIR);
  const rulesDir = join(workspace, RULES_SUBDIR);
  const chunks = splitPromptForRules(prompt);
  if (chunks.length === 0) {
    rmSync(workspace, { recursive: true, force: true });
    return null;
  }
  mkdirSync(rulesDir, { recursive: true, mode: 0o700 });
  const keep = new Set(chunks.map((_, i) => ruleFileName(i)));
  for (const name of readdirSync(rulesDir)) {
    if (RULE_FILE_RE.test(name) && !keep.has(name)) rmSync(join(rulesDir, name), { force: true });
  }
  chunks.forEach((chunk, i) => {
    // 原子替换：上一个进程（或后台写交接复制的那份）可能正在读规则，不能让它读到写了一半的文件
    writeFileAtomic.sync(join(rulesDir, ruleFileName(i)), `${RULE_FRONTMATTER}${chunk}`, { mode: 0o600 });
  });
  return workspace;
}

/**
 * 主会话起进程时写好的规则目录（后台写交接复制的那份用）：不重写，跟主会话这次进程的系统提示词逐字一样（前缀缓存吃得上）。
 * 没写过（提示词空白、或者还没起过进程）返回 null。
 */
export function existingAgyPromptRules(promptFile: string): string | null {
  const workspace = join(dirname(promptFile), AGY_RULES_WORKSPACE_DIR);
  const rulesDir = join(workspace, RULES_SUBDIR);
  if (!existsSync(rulesDir)) return null;
  return readdirSync(rulesDir).some((name) => RULE_FILE_RE.test(name)) ? workspace : null;
}

/** 每次启动重新扫描，不缓存；真实路径去重，避免全局规则软链重复计数。 */
export function agyRuleBudgetWarning(home: string, workspaces: readonly string[]): string | null {
  const seen = new Set<string>();
  let total = 0;
  let oversized = 0;
  const inspect = (file: string, needsTrigger: boolean) => {
    if (!existsSync(file)) return;
    const real = realpathSync(file);
    if (seen.has(real)) return;
    const text = readFileSync(real, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] ?? "";
    if (needsTrigger && !/^trigger:\s*["']?always_on["']?\s*(?:#.*)?$/m.test(frontmatter)) return;
    seen.add(real);
    const size = Buffer.byteLength(text, "utf8");
    total += size;
    if (size > AGY_RULE_SINGLE_BUDGET_BYTES) oversized++;
  };
  const root = (dir: string, rulesDir: string, needsTrigger: boolean) => {
    for (const name of ["AGENTS.md", "GEMINI.md"]) inspect(join(dir, name), false);
    if (existsSync(rulesDir)) for (const entry of readdirSync(rulesDir, { withFileTypes: true })) {
      if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md")) inspect(join(rulesDir, entry.name), needsTrigger);
    }
  };
  for (const dir of [join(home, ".gemini"), join(home, ".gemini", "config")]) root(dir, join(dir, "rules"), false);
  for (const dir of new Set(workspaces)) root(dir, join(dir, RULES_SUBDIR), true);
  if (total <= AGY_RULE_TOTAL_BUDGET_BYTES && oversized === 0) return null;
  return `agy 规则预算告警：规则共 ${total} 字节（预算约 ${AGY_RULE_TOTAL_BUDGET_BYTES}），${oversized} 个文件超过单文件 ${AGY_RULE_SINGLE_BUDGET_BYTES} 字节。自动压缩后项目规则或产品提示词可能缺失；未自动裁剪或调整顺序。`;
}
