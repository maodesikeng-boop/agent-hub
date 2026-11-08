// 厂商声明表统一的 CI 守卫测试（docs/vendor-registry-design.md 第 4 节）：
// 防止业务代码回潮写死单家厂商判断、AGY 数据目录字面量或提示词里的厂商工具名/CLI 名。
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

const isTs = (path: string) => path.endsWith(".ts");
const isExcludedTestOrFake = (path: string) => {
  const base = basename(path);
  return (
    path.endsWith(".test.ts") ||
    path.endsWith(".test.tsx") ||
    base === "test-helpers.ts" ||
    base.startsWith("fake-")
  );
};
const isCommentLine = (line: string) => line.startsWith("//") || line.startsWith("*") || line.startsWith("/*");

interface Rule {
  name: string;
  files: string[];
  pattern: RegExp;
  expected: number;
}

const businessDaemonAndHubTs = [
  ...listFiles("src/daemon", isTs),
  ...listFiles("src/hub", isTs),
].filter(
  (path) =>
    !isExcludedTestOrFake(path) &&
    !path.startsWith("src/daemon/driver/") &&
    !path.startsWith("src/daemon/vendors/") &&
    !path.startsWith("src/daemon/handover/"),
);

const srcNonPathDefTs = listFiles("src", isTs).filter(
  (path) =>
    !isExcludedTestOrFake(path) &&
    path !== "src/shared/paths.ts" &&
    path !== "src/shared/vendors.ts",
);

const promptTs = ["src/daemon/prompt.ts"];

const VENDOR_BRANCH_PATTERN = /\bvendor\s*[!=]==?\s*["'](claude|codex|agy)["']|\bVENDOR_SPECS\.(claude|codex|agy)\b/;
const AGY_DATA_DIR_PATTERN = /\.gemini\/antigravity-cli|["']\.gemini["']\s*,\s*["']antigravity-cli["']/;
const PROMPT_HARDCODED_VENDOR_PATTERN =
  /\b(spawn_agent|invoke_subagent|run_in_background|WaitMsBeforeAsync)\b|`(Agent|Task|claude|codex|agy)`/;

const RULES: Rule[] = [
  {
    name: "业务代码不许写死单家厂商分支",
    files: businessDaemonAndHubTs,
    pattern: VENDOR_BRANCH_PATTERN,
    expected: 0,
  },
  {
    name: "AGY 数据目录字面量只许在路径定义处",
    files: srcNonPathDefTs,
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
    expect(businessDaemonAndHubTs.length).toBeGreaterThan(20);
    expect(businessDaemonAndHubTs).toContain("src/daemon/daemon.ts");
    expect(businessDaemonAndHubTs).toContain("src/daemon/launch.ts");
    expect(businessDaemonAndHubTs).toContain("src/daemon/ledger/workers.ts");
    expect(businessDaemonAndHubTs).toContain("src/hub/cli.ts");
    expect(srcNonPathDefTs.length).toBeGreaterThan(40);
    expect(srcNonPathDefTs).toContain("src/daemon/driver/readonly-agy.ts");
    expect(srcNonPathDefTs).toContain("src/daemon/handover/agy.ts");
  });

  it("规则正则能准确识别违例写法", () => {
    expect(VENDOR_BRANCH_PATTERN.test('if (session.vendor === "claude")')).toBe(true);
    expect(VENDOR_BRANCH_PATTERN.test("c.vendor !== 'codex'")).toBe(true);
    expect(VENDOR_BRANCH_PATTERN.test("const q = VENDOR_SPECS.agy.quota;")).toBe(true);
    expect(VENDOR_BRANCH_PATTERN.test('VENDOR_SPECS[session.vendor]?.readonlyMode === "settings"')).toBe(false);

    expect(AGY_DATA_DIR_PATTERN.test("const cli = `${home}/.gemini/antigravity-cli`;")).toBe(true);
    expect(AGY_DATA_DIR_PATTERN.test('join(home, ".gemini", "antigravity-cli")')).toBe(true);
    expect(AGY_DATA_DIR_PATTERN.test("const { cliDir } = agyHomePaths(home);")).toBe(false);

    expect(PROMPT_HARDCODED_VENDOR_PATTERN.test("用 `run_in_background` 跑")).toBe(true);
    expect(PROMPT_HARDCODED_VENDOR_PATTERN.test("禁止调用 `Agent` 或 `spawn_agent`")).toBe(true);
    expect(PROMPT_HARDCODED_VENDOR_PATTERN.test("直接跑 `claude` 命令")).toBe(true);
    expect(PROMPT_HARDCODED_VENDOR_PATTERN.test("用 ${formatSubagentTools()} 等")).toBe(false);
  });

  it.each(RULES.map((rule) => [rule.name, rule] as const))("%s", (_name, rule) => {
    const hits = scan(rule);
    expect(hits, "发现违反厂商声明表统一规范的硬编码写法").toEqual([]);
    expect(hits.length).toBe(rule.expected);
  });
});
