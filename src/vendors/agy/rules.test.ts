// agy 产品提示词规则目录（rules.ts）：切块、写文件、旧块清理。
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGY_RULE_FILE_MAX_BYTES, AGY_RULE_FILES_MAX } from "./limits.ts";
import { AGY_RULES_WORKSPACE_DIR, splitPromptForRules, writeAgyPromptRules } from "./rules.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function launchDir(): string {
  const d = mkdtempSync(join(tmpdir(), "agy-rules-"));
  dirs.push(d);
  return d;
}

const rulesFiles = (workspace: string) => readdirSync(join(workspace, ".agents", "rules")).sort();
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("splitPromptForRules", () => {
  it("空白返回空；短的整块；按字节切、在换行处断，拼回去等于原文（去掉首尾空白）", () => {
    expect(splitPromptForRules(" \n ")).toEqual([]);
    expect(splitPromptForRules("\n一句话\n")).toEqual(["一句话"]);
    const lines = Array.from({ length: 50 }, (_, i) => `第${i}行：中文内容占三个字节`);
    const text = lines.join("\n");
    const chunks = splitPromptForRules(text, 200, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
    for (const c of chunks) expect(bytes(c)).toBeLessThanOrEqual(200);
    for (const c of chunks.slice(0, -1)) expect(c.endsWith("\n")).toBe(true);
  });

  it("一行超长按 UTF-8 字符边界硬切，不切坏汉字", () => {
    const text = "汉".repeat(100);
    const chunks = splitPromptForRules(text, 31, 100);
    expect(chunks.join("")).toBe(text);
    for (const c of chunks) {
      expect(bytes(c)).toBeLessThanOrEqual(31);
      expect(c).not.toContain("�");
    }
  });

  it("超过块数上限：截掉后面的，最后一块末尾写明截掉了多少字节", () => {
    const text = "x\n".repeat(100);
    const chunks = splitPromptForRules(text, 10, 3);
    expect(chunks).toHaveLength(3);
    expect(chunks.at(-1)).toMatch(/后面 \d+ 字节没放进规则区/);
  });
});

describe("writeAgyPromptRules", () => {
  it("写到启动目录的 agy-rules/.agents/rules/fusa-NN.md，带 always_on 的 frontmatter，返回要 --add-dir 的目录", () => {
    const d = launchDir();
    const promptFile = join(d, "prompt.md");
    writeFileSync(promptFile, "你是项目经理。\n");
    const workspace = writeAgyPromptRules(promptFile);
    expect(workspace).toBe(join(d, AGY_RULES_WORKSPACE_DIR));
    expect(rulesFiles(workspace!)).toEqual(["fusa-01.md"]);
    expect(readFileSync(join(workspace!, ".agents", "rules", "fusa-01.md"), "utf8")).toBe("---\ntrigger: always_on\n---\n你是项目经理。");
  });

  it("提示词变短：多出来的旧块删掉（文件数不越变越多），别的文件不动；变空：整个目录删掉、返回 null", () => {
    const d = launchDir();
    const promptFile = join(d, "prompt.md");
    writeFileSync(promptFile, "行\n".repeat(AGY_RULE_FILE_MAX_BYTES));
    const workspace = writeAgyPromptRules(promptFile)!;
    expect(rulesFiles(workspace).length).toBeGreaterThan(1);
    expect(rulesFiles(workspace).length).toBeLessThanOrEqual(AGY_RULE_FILES_MAX);
    writeFileSync(join(workspace, ".agents", "rules", "keep.txt"), "别人的");
    writeFileSync(promptFile, "短\n");
    writeAgyPromptRules(promptFile);
    expect(rulesFiles(workspace)).toEqual(["fusa-01.md", "keep.txt"]);
    writeFileSync(promptFile, "   ");
    expect(writeAgyPromptRules(promptFile)).toBeNull();
    expect(existsSync(workspace)).toBe(false);
  });

  it("项目经理现在最长的提示词（约 44KB 中文）切成每块不超过上限的 3 块，拼回去不丢字", () => {
    const d = launchDir();
    const promptFile = join(d, "prompt.md");
    const prompt = Array.from({ length: 900 }, (_, i) => `第 ${i} 条：项目经理的规矩和 hub 命令表`).join("\n");
    writeFileSync(promptFile, prompt);
    expect(bytes(prompt)).toBeGreaterThan(40_000);
    const workspace = writeAgyPromptRules(promptFile)!;
    const files = rulesFiles(workspace);
    expect(files).toEqual(["fusa-01.md", "fusa-02.md", "fusa-03.md"]);
    const bodies = files.map((f) => readFileSync(join(workspace, ".agents", "rules", f), "utf8").replace(/^---\ntrigger: always_on\n---\n/, ""));
    for (const b of bodies) expect(bytes(b)).toBeLessThanOrEqual(AGY_RULE_FILE_MAX_BYTES);
    expect(bodies.join("")).toBe(prompt);
  });
});
