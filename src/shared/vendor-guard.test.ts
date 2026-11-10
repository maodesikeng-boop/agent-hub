// 厂商声明表统一的 CI 守卫测试（docs/vendor-registry-design.md 第 4 节）：
// 防止公共代码回潮写死单家厂商判断、厂商编号或命令名、AGY 数据目录字面量或提示词里的厂商工具名/CLI 名。
// 正则里的厂商编号、命令名、工具名都从名单（VENDOR_LIST）生成，不手写（docs/vendor-plugin-design.md 的 D3）：
// 加一家厂商不用改这里，它也受同样的保护。扫的范围（第 7 节“守住”）：src/ 里厂商文件夹以外的源码（含网页的 .tsx），
// 加上 test/ 里的测试工具（端到端的 harness、冒烟的 kit 这些公共零件；具体某家的冒烟场景、假程序不算）。
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGY_CLI_HOME_REL } from "../vendors/agy/spec.ts";
import { VENDOR_LIST } from "../vendors/registry.ts";
import { AGENT_VENDORS, vendorSpec } from "./vendors.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function listFiles(dir: string, accept: (path: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(relative(ROOT, entry.parentPath), entry.name).split("\\").join("/");
    if (accept(path)) out.push(path);
  }
  return out.sort();
}

const isTs = (path: string) => path.endsWith(".ts") || path.endsWith(".tsx");
const isExcludedTestOrFake = (path: string) => {
  const base = basename(path);
  return (
    path.endsWith(".test.ts") ||
    path.endsWith(".test.tsx") ||
    base === "test-helpers.ts" ||
    base.startsWith("fake-") ||
    path.split("/").some((part) => part.startsWith("fake-"))
  );
};
const isCommentLine = (line: string) => line.startsWith("//") || line.startsWith("*") || line.startsWith("/*");

interface Rule {
  name: string;
  files: string[];
  pattern: RegExp;
  expected: number;
}

/** test/ 里的公共测试零件（起守护进程、发消息、清环境、查进程）：和公共代码一样不许认识具体哪家。具体某家的冒烟场景不在这里。 */
const TEST_TOOL_FILES = ["test/clean-env.ts", "test/spawn-guard.ts", "test/e2e/harness.ts", "test/e2e/loopback-daemon.ts", "test/smoke/kit.ts", "test/smoke/main.ts"];

/** 公共代码：src/ 里厂商文件夹（src/vendors/ 下的名单、类型、加载器不算厂商文件夹）以外的源码，加上测试零件。 */
const commonTs = [
  ...listFiles("src", isTs).filter((path) => !isExcludedTestOrFake(path) && !/^src\/vendors\/[^/]+\//.test(path)),
  ...TEST_TOOL_FILES,
];

/** agy 文件夹（src/vendors/agy/）以外的源码：agy 专属的路径字面量只许写在它自己的文件夹里。 */
const srcOutsideAgyVendorDirTs = [
  ...listFiles("src", isTs).filter((path) => !isExcludedTestOrFake(path) && !path.startsWith("src/vendors/agy/")),
  ...TEST_TOOL_FILES,
];

const promptTs = ["src/daemon/prompt.ts"];

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alternation = (words: readonly string[]) => [...new Set(words)].map(escapeRe).join("|");

/** 写死某家的分支：vendor === "<编号>"、vendorSpec("<编号>")。 */
function vendorBranchPattern(ids: readonly string[]): RegExp {
  const any = alternation(ids);
  return new RegExp(`\\bvendor\\s*[!=]==?\\s*["'](${any})["']|\\bvendorSpec\\(\\s*["'](${any})["']`);
}

/** 厂商编号、命令名的字面量（引号括起的整串）和找不到它的错误码（<编号>_not_found）：公共代码按名单循环，不点名。 */
function vendorLiteralPattern(ids: readonly string[], commands: readonly string[]): RegExp {
  return new RegExp(`["'\`](${alternation([...ids, ...commands])})["'\`]|\\b(${alternation(ids)})_not_found\\b`);
}

/** 厂商专属数据目录（相对主目录，如 .gemini/antigravity-cli）的字面量：整串，或 join 的逐段写法。 */
function homeDirLiteralPattern(rel: string): RegExp {
  const parts = rel.split("/").map((part) => `["']${escapeRe(part)}["']`);
  return new RegExp(`${escapeRe(rel)}|${parts.join("\\s*,\\s*")}`);
}

/** 提示词里的厂商工具名、命令名：工具名取 subagentTools 和 backgroundCommandTool 里用反引号括起的名字。 */
interface PromptVendorTerms {
  ids: readonly string[];
  commands: readonly string[];
  tools: readonly string[];
}

interface PromptSpec {
  id: string;
  cli: { command: string };
  prompt: { subagentTools: readonly string[]; backgroundCommandTool: string };
}

function promptVendorTerms(specs: readonly PromptSpec[]): PromptVendorTerms {
  return {
    ids: specs.map((s) => s.id),
    commands: specs.map((s) => s.cli.command),
    tools: specs.flatMap((s) => [...s.prompt.subagentTools, ...[...s.prompt.backgroundCommandTool.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)]),
  };
}

/**
 * 带下划线或驼峰的工具名（spawn_agent、WaitMsBeforeAsync）不会是普通的词，出现就算；
 * Agent、Task 和厂商编号、命令名是普通的词，只在用反引号括起来时算。
 */
function promptHardcodedPattern({ ids, commands, tools }: PromptVendorTerms): RegExp {
  const distinctive = tools.filter((t) => /_|[a-z][A-Z]/.test(t));
  return new RegExp(`\\b(${alternation(distinctive)})\\b|\`(${alternation([...tools, ...ids, ...commands])})\``);
}

const VENDOR_BRANCH_PATTERN = vendorBranchPattern(AGENT_VENDORS);
const VENDOR_LITERAL_PATTERN = vendorLiteralPattern(AGENT_VENDORS, VENDOR_LIST.map((s) => s.cli.command));
const AGY_DATA_DIR_PATTERN = homeDirLiteralPattern(AGY_CLI_HOME_REL);
const PROMPT_HARDCODED_VENDOR_PATTERN = promptHardcodedPattern(promptVendorTerms(VENDOR_LIST));

const RULES: Rule[] = [
  {
    name: "公共代码不许写死单家厂商分支",
    files: commonTs,
    pattern: VENDOR_BRANCH_PATTERN,
    expected: 0,
  },
  {
    name: "公共代码不许点名厂商（编号、命令名的字面量，<编号>_not_found）",
    files: commonTs,
    pattern: VENDOR_LITERAL_PATTERN,
    expected: 0,
  },
  {
    name: "AGY 数据目录字面量只许在 agy 的文件夹里",
    files: srcOutsideAgyVendorDirTs,
    pattern: AGY_DATA_DIR_PATTERN,
    expected: 0,
  },
  {
    name: "prompt.ts 不许硬编码厂商工具名或 CLI",
    files: promptTs,
    pattern: PROMPT_HARDCODED_VENDOR_PATTERN,
    expected: 0,
  },
];

function scan(rule: Rule): string[] {
  const hits: string[] = [];
  for (const file of rule.files) {
    const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line === "" || isCommentLine(line)) continue;
      if (rule.pattern.test(line)) {
        hits.push(`${file}:${i + 1}  ${line}`);
      }
    }
  }
  return hits;
}

describe("厂商声明表统一：扫描守卫规则", () => {
  it("扫得到目标源码文件（目录结构变更时能及时发现）", () => {
    expect(commonTs.length).toBeGreaterThan(100);
    expect(commonTs).toContain("src/daemon/daemon.ts");
    expect(commonTs).toContain("src/daemon/launch.ts");
    expect(commonTs).toContain("src/daemon/ledger/workers.ts");
    expect(commonTs).toContain("src/hub/cli.ts");
    expect(srcOutsideAgyVendorDirTs.length).toBeGreaterThan(40);
    // 驱动层、交接复制、守护进程侧登记表的通用部分（P3 后各家的都搬进了 src/vendors/<厂商>/）也受保护
    expect(commonTs).toContain("src/daemon/driver/base-driver.ts");
    expect(commonTs).toContain("src/daemon/handover/runner.ts");
    expect(commonTs).toContain("src/daemon/vendors/index.ts");
    // P4 起：shared、网页（含 .tsx）、名单和加载器、测试零件也受保护；厂商文件夹本身不扫
    expect(commonTs).toContain("src/shared/step-labels.ts");
    expect(commonTs).toContain("src/shared/paths.ts");
    expect(commonTs).toContain("src/web/selectors.ts");
    expect(commonTs).toContain("src/web/components/QuotaPopover.tsx");
    expect(commonTs).toContain("src/vendors/registry.ts");
    expect(commonTs).toContain("src/vendors/daemon-registry.ts");
    expect(commonTs).toContain("test/e2e/harness.ts");
    expect(commonTs).toContain("test/smoke/kit.ts");
    expect(commonTs).not.toContain("src/vendors/claude/spec.ts");
    expect(commonTs).not.toContain("test/fake-claude/fake-claude.ts");
    expect(commonTs).not.toContain("test/fake-devices/main.ts");
    for (const file of TEST_TOOL_FILES) expect(listFiles(dirname(file), (p) => p === file), file).toEqual([file]);
    expect(srcOutsideAgyVendorDirTs).toContain("src/daemon/driver/write-scope.ts");
    expect(srcOutsideAgyVendorDirTs).toContain("src/vendors/claude/driver.ts");
    expect(srcOutsideAgyVendorDirTs).toContain("src/shared/paths.ts");
    expect(srcOutsideAgyVendorDirTs).toContain("src/shared/vendors.ts");
    expect(srcOutsideAgyVendorDirTs).toContain("src/vendors/claude/spec.ts");
    expect(srcOutsideAgyVendorDirTs).toContain("src/vendors/codex/spec.ts");
  });

  it("规则正则能准确识别违例写法", () => {
    expect(VENDOR_BRANCH_PATTERN.test('if (session.vendor === "claude")')).toBe(true);
    expect(VENDOR_BRANCH_PATTERN.test("c.vendor !== 'codex'")).toBe(true);
    expect(VENDOR_BRANCH_PATTERN.test('const q = vendorSpec("agy").quota;')).toBe(true);
    expect(VENDOR_BRANCH_PATTERN.test('vendorSpec(session.vendor).capabilities.readonly === "settings"')).toBe(false);

    expect(VENDOR_LITERAL_PATTERN.test('const v: AgentVendor = "codex";')).toBe(true);
    expect(VENDOR_LITERAL_PATTERN.test("spawn(`claude`, args)")).toBe(true);
    expect(VENDOR_LITERAL_PATTERN.test('if (raw.startsWith("agy_not_found"))')).toBe(true);
    expect(VENDOR_LITERAL_PATTERN.test('const model = "claude-haiku-5-5";')).toBe(false);
    expect(VENDOR_LITERAL_PATTERN.test("for (const spec of VENDOR_LIST) env[spec.cli.envVar] = path;")).toBe(false);

    expect(AGY_DATA_DIR_PATTERN.test("const cli = `${home}/.gemini/antigravity-cli`;")).toBe(true);
    expect(AGY_DATA_DIR_PATTERN.test('join(home, ".gemini", "antigravity-cli")')).toBe(true);
    expect(AGY_DATA_DIR_PATTERN.test("const { cliDir } = agyHomePaths(home);")).toBe(false);

    expect(PROMPT_HARDCODED_VENDOR_PATTERN.test("用 `run_in_background` 跑")).toBe(true);
    expect(PROMPT_HARDCODED_VENDOR_PATTERN.test("禁止调用 `Agent` 或 `spawn_agent`")).toBe(true);
    expect(PROMPT_HARDCODED_VENDOR_PATTERN.test("直接跑 `claude` 命令")).toBe(true);
    expect(PROMPT_HARDCODED_VENDOR_PATTERN.test("用 ${formatSubagentTools()} 等")).toBe(false);
  });

  it("正则从名单生成：名单里每一家都被拦，加一家（acme）不用改守卫", () => {
    for (const id of AGENT_VENDORS) {
      expect(VENDOR_BRANCH_PATTERN.test(`if (s.vendor === "${id}")`), id).toBe(true);
      expect(VENDOR_BRANCH_PATTERN.test(`vendorSpec("${id}").label`), id).toBe(true);
      expect(VENDOR_LITERAL_PATTERN.test(`const v = "${id}";`), id).toBe(true);
      expect(VENDOR_LITERAL_PATTERN.test(`"${id}_not_found: x"`), id).toBe(true);
      expect(PROMPT_HARDCODED_VENDOR_PATTERN.test(`直接跑 \`${vendorSpec(id).cli.command}\``), id).toBe(true);
      for (const tool of vendorSpec(id).prompt.subagentTools) expect(PROMPT_HARDCODED_VENDOR_PATTERN.test(`调 \`${tool}\``), tool).toBe(true);
    }
    const withAcme = vendorBranchPattern([...AGENT_VENDORS, "acme"]);
    expect(withAcme.test('if (s.vendor === "acme")')).toBe(true);
    expect(VENDOR_BRANCH_PATTERN.test('if (s.vendor === "acme")')).toBe(false);
    expect(vendorLiteralPattern([...AGENT_VENDORS, "acme"], ["acme-cli"]).test('run("acme-cli")')).toBe(true);
    const acmeTerms = promptVendorTerms([
      ...VENDOR_LIST,
      { id: "acme", cli: { command: "acme-cli" }, prompt: { subagentTools: ["acme_delegate"], backgroundCommandTool: "`acme_bg`" } },
    ]);
    const acmePrompt = promptHardcodedPattern(acmeTerms);
    for (const text of ["用 acme_delegate 派", "用 acme_bg 跑", "直接跑 `acme-cli`", "`acme`"]) expect(acmePrompt.test(text), text).toBe(true);
    expect(homeDirLiteralPattern(".acme/data").test('join(home, ".acme", "data")')).toBe(true);
  });

  it.each(RULES.map((rule) => [rule.name, rule] as const))("%s", (_name, rule) => {
    const hits = scan(rule);
    expect(hits, "发现违反厂商声明表统一规范的硬编码写法").toEqual([]);
    expect(hits.length).toBe(rule.expected);
  });
});
