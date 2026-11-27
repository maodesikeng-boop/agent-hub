// agy has no system prompt flag but injects always_on .agents/rules/*.md from each --add-dir into <user_rules>, which survives compaction.
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomicSyncWithRetry } from "../../daemon/platform/index.ts";
import { AGY_RULE_FILE_MAX_BYTES, AGY_RULE_FILES_MAX, AGY_RULE_TOTAL_BUDGET_BYTES, AGY_RULE_SINGLE_BUDGET_BYTES } from "./limits.ts";

export const AGY_RULES_WORKSPACE_DIR = "agy-rules";
const RULES_SUBDIR = join(".agents", "rules");
const SKILLS_SUBDIR = join(".agents", "skills");
// agy concatenates rule files in file name order.
const RULE_FILE_RE = /^fusa-\d{2}\.md$/;
const ruleFileName = (index: number) => `fusa-${String(index + 1).padStart(2, "0")}.md`;
const RULE_FRONTMATTER = "---\ntrigger: always_on\n---\n";

function utf8Cut(buf: Buffer, maxBytes: number): number {
  let end = Math.min(maxBytes, buf.length);
  while (end > 0 && end < buf.length && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return end;
}

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

export function writeAgyPromptRules(promptFile: string, skillsDir?: string): string | null {
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
    // Atomic replace: a running process or a handover copy may be reading the rules.
    writeFileAtomicSyncWithRetry(join(rulesDir, ruleFileName(i)), `${RULE_FRONTMATTER}${chunk}`, { mode: 0o600 });
  });
  linkAgySkills(workspace, skillsDir);
  return workspace;
}

// agy 1.5.6 skips symlinked skills, so hard link SKILL.md (copy across filesystems).
function linkAgySkills(workspace: string, skillsDir: string | undefined): void {
  const target = join(workspace, SKILLS_SUBDIR);
  const wanted = new Set<string>();
  if (skillsDir !== undefined && existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      const source = join(skillsDir, entry.name, "SKILL.md");
      if (!entry.isDirectory() || !existsSync(source)) continue;
      wanted.add(entry.name);
      const dest = join(target, entry.name, "SKILL.md");
      if (existsSync(dest) && statSync(dest, { bigint: true }).ino === statSync(source, { bigint: true }).ino) continue;
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      rmSync(dest, { force: true });
      try {
        linkSync(source, dest);
      } catch {
        copyFileSync(source, dest);
      }
    }
  }
  if (!existsSync(target)) return;
  for (const name of readdirSync(target)) if (!wanted.has(name)) rmSync(join(target, name), { recursive: true, force: true });
}

export function existingAgyPromptRules(promptFile: string): string | null {
  const workspace = join(dirname(promptFile), AGY_RULES_WORKSPACE_DIR);
  const rulesDir = join(workspace, RULES_SUBDIR);
  if (!existsSync(rulesDir)) return null;
  return readdirSync(rulesDir).some((name) => RULE_FILE_RE.test(name)) ? workspace : null;
}

export interface AgyRuleFileInfo {
  path: string;
  bytes: number;
}

export interface AgyRuleBudgetReport {
  totalBytes: number;
  files: AgyRuleFileInfo[];
  oversizedFiles: AgyRuleFileInfo[];
}

/**
 * Inspects deduplicated global and workspace rule files loaded by agy and measures UTF-8 byte sizes.
 * Postcondition: returns totalBytes, all active rule files sorted by bytes descending, and oversizedFiles
 * whose UTF-8 size exceeds AGY_RULE_SINGLE_BUDGET_BYTES sorted by bytes descending. Broken symlinks and
 * non-always_on workspace rules are skipped without throwing.
 */
export function inspectAgyRuleBudget(_home: string, _workspaces: readonly string[]): AgyRuleBudgetReport {
  throw new Error("Not implemented");
}

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
