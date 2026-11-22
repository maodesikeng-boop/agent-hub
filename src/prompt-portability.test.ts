import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { afterAll, describe, expect, it } from "vitest";
import { buildLaunchPrompt, buildWorkerFirstMessage, buildWorkerSystemPrompt } from "./daemon/prompt.ts";
import { buildRouterSystemPrompt } from "./daemon/router/prompt.ts";
import { buildCatalogSystemPrompt } from "./daemon/project-catalog/prompt.ts";
import { card, noProjectContext, projectContext, workerContext } from "./daemon/test-helpers.ts";
import { HUB_USAGE } from "./hub/usage.ts";
import { PM_MODES } from "./shared/index.ts";
import { REVIEW_CHECKLIST } from "./shared/review.ts";
import { taskGraphSkillMarkdown } from "./shared/task-graph-skill.ts";
import { AGENT_VENDORS } from "./shared/vendors.ts";
import { WORKER_REPORT_FORMAT } from "./shared/worker.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface PortabilityRule {
  id: string;
  why: string;
  pattern: RegExp;
  /** A condition in the same sentence that names one of these limits the instruction to projects where it holds. */
  scope?: RegExp;
  /** The paragraph passes when it also gives the portable form. */
  alternative?: RegExp;
}

const RULES: readonly PortabilityRule[] = [
  {
    id: "fixed-trunk-or-remote",
    why: "projects name their trunk and remotes freely (trunk, develop, master, a remote other than origin, or none)",
    pattern:
      /\b(?:origin|upstream)\/[\w.-]+|`git [^`]*\b(?:origin|upstream|main|master)\b[^`]*`|\bgit (?:fetch|pull|push|rebase|merge|diff|log|show|checkout|switch|reset|branch)\b[^`\n。；，,;]*?\b(?:origin|upstream|main|master)\b/gu,
    // A path such as src/main.ts names no branch.
    scope: /(?<![\w/.-])(?:main|master|origin|upstream)(?![\w/.-])/u,
  },
  {
    id: "toolchain-command",
    why: "projects use any language and build tool, so this repo's package manager and test runner mean nothing there",
    pattern: /\b(?:pnpm|yarn|npx|vitest|jest)\b|\bnpm (?:install|ci|test|run)\b/gu,
    scope: /pnpm|npm|yarn|Node|JavaScript|TypeScript|vitest|jest/iu,
  },
  {
    id: "github-cli",
    why: "projects may host on GitLab, run another CI, or have no remote, and `gh` may be missing",
    pattern: /\bgh (?:pr|run|issue|api|repo|workflow|release)\b/gu,
    scope: /GitHub|\bgh\b/iu,
  },
  {
    id: "posix-shell-only",
    why: "native Windows agents run PowerShell or cmd, which have no heredoc and no $SHELL",
    pattern: /<<-?\s*['"]?EOF\b|\$SHELL\b/gu,
    scope: /bash|zsh|POSIX|macOS|Linux|Unix/iu,
    alternative: /PowerShell/u,
  },
  {
    id: "posix-temp-path",
    why: "Windows has no /tmp",
    pattern: /(?<![\w.~-])\/tmp\b/gu,
    scope: /macOS|Linux|POSIX|Unix/iu,
  },
  {
    id: "assumed-rules-file",
    why: "a project may keep its rules in CONTRIBUTING.md, a runbook, a ticket, or nowhere",
    pattern: /\b(?:AGENTS|CLAUDE)\.md\b/gu,
    scope: /(?:AGENTS|CLAUDE)\.md/u,
  },
  {
    id: "fixed-reply-language",
    why: "users write in any language, so replies follow the user's language instead of a fixed one",
    pattern:
      /(?:用|以)(?:简洁的?)?(?:中文|英文|汉语)(?=\s*(?:简洁|回复|回答|告诉|说明|写|[，。]))|简洁的?(?:中文|英文)|\b(?:reply|respond|answer)(?: \w+)? in (?:Chinese|English)\b/giu,
    scope: /中文|英文|汉语|Chinese|English/iu,
  },
  {
    id: "bellwood-source-path",
    why: "this repo's own source tree and docs do not exist in the user's project",
    pattern: /\bsrc\/(?:daemon|shared|hub|vendors|web)\/|\bdocs\/[\w-]+\.md\b|\blimits\.ts\b|\.agents\/skills\b/gu,
  },
];

const PARAGRAPH_BREAK = /\n\s*\n/gu;
// An indented line continues the one above it, so an example block under "例如：" stays in one sentence.
const SENTENCE_BREAK = /[。；！？]|[;!?](?=\s)|(?<!\be\.g|\bi\.e)\.(?=\s)|\n(?![ \t])/gu;
const CLAUSE_BREAK = /[。；！？，）]|[;!?)](?=\s)|(?<!\be\.g|\bi\.e)\.(?=\s)|\n(?![ \t])/gu;
// "如" marks an example only as "（如 …" or "如 `…`", never inside 如何, 如实, or 如下.
const EXAMPLE_MARKER = /比如|例如|譬如|诸如|举例|e\.g\.|for example|such as|(?:^|[（(、\s])如(?=[\s`“"'：:])/giu;
const IMPERATIVE = /一律|必须|务必|都要|只能|只许|要用|就用|改用|请用|应当|应该|总是|\bmust\b|\balways\b/iu;
// "只有……才" states a prerequisite every project must meet, so it does not open a scoping condition.
const CONDITION_OPEN = /如果|假如|若|要是|仅当|只在|\bif\b|\bwhen\b/giu;
const CONDITION_CLOSE = /[：:，,]|时|才|就|则|便|那么|的话|\bthen\b/iu;
// Inside an open condition, the name is the project's trait only when it is what the project uses or is.
const NAMES_TRAIT = /(?:用|使用|采用|用的是|是|叫|托管在|跑在|运行在|基于|装了|有)\s*`?$/u;

function tailAfterLast(text: string, breaks: RegExp): string {
  const last = [...text.matchAll(breaks)].at(-1);
  return last === undefined ? text : text.slice(last.index + last[0].length);
}

function headBeforeFirst(text: string, breaks: RegExp): string {
  const at = text.search(breaks);
  return at === -1 ? text : text.slice(0, at);
}

/** "比如 `pnpm install`、`pip install`" shows one option among many; "比如这类改动要用 …" still gives an order. */
function isShownAsExample(before: string): boolean {
  const clause = tailAfterLast(before, CLAUSE_BREAK);
  const marker = [...clause.matchAll(EXAMPLE_MARKER)].at(-1);
  return marker !== undefined && !IMPERATIVE.test(clause.slice(marker.index + marker[0].length));
}

/**
 * "如果项目用 pnpm" names the trait inside the condition itself. "项目托管在 GitHub 的话，用 `gh pr checks`" limits the order
 * to GitHub projects. "如果改了代码必须跑 `pnpm typecheck`" and "只有当用户交代了多个目标，才用 <<'EOF'" limit nothing
 * about the project or platform.
 */
function isScopedByCondition(before: string, rule: PortabilityRule): boolean {
  const sentence = tailAfterLast(before, SENTENCE_BREAK);
  const open = [...sentence.matchAll(CONDITION_OPEN)].at(-1);
  if (open !== undefined) {
    const condition = sentence.slice(open.index);
    const close = condition.slice(open[0].length).search(CONDITION_CLOSE);
    if (close === -1) return !IMPERATIVE.test(condition) && NAMES_TRAIT.test(condition);
    return rule.scope?.test(condition.slice(0, open[0].length + close)) ?? false;
  }
  const ifSo = sentence.indexOf("的话");
  return ifSo !== -1 && (rule.scope?.test(sentence.slice(0, ifSo)) ?? false);
}

function offersAlternative(text: string, at: number, rule: PortabilityRule): boolean {
  if (rule.alternative === undefined) return false;
  const paragraph = tailAfterLast(text.slice(0, at), PARAGRAPH_BREAK) + headBeforeFirst(text.slice(at), PARAGRAPH_BREAK);
  return rule.alternative.test(paragraph);
}

function bindsEveryProject(text: string, at: number, rule: PortabilityRule): boolean {
  const before = text.slice(0, at);
  return !isShownAsExample(before) && !isScopedByCondition(before, rule) && !offersAlternative(text, at, rule);
}

interface Violation {
  rule: PortabilityRule;
  index: number;
}

function violationsIn(text: string): Violation[] {
  const out: Violation[] = [];
  for (const rule of RULES) {
    const binding = [...text.matchAll(rule.pattern)].find((m) => bindsEveryProject(text, m.index, rule));
    if (binding !== undefined) out.push({ rule, index: binding.index });
  }
  return out;
}

function describeViolation(text: string, v: Violation): string {
  const snippet = text.slice(Math.max(0, v.index - 30), v.index + 50).replace(/\s+/gu, " ");
  return `[${v.rule.id}] ${snippet} -- ${v.rule.why}`;
}

const CJK = /[\u3400-\u9fff]/u;

function productSourceFiles(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, "src"), { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = relative(ROOT, join(entry.parentPath, entry.name)).split("\\").join("/");
    const parts = path.split("/");
    if (!/\.tsx?$/u.test(path) || /\.test\.tsx?$/u.test(path)) continue;
    if (path.startsWith("src/web/") || basename(path) === "test-helpers.ts") continue;
    if (parts.some((part) => part === "fixtures" || part.startsWith("fake-"))) continue;
    out.push(path);
  }
  return out.sort();
}

type AstNode = { type: string; start: number; [key: string]: unknown };
const isAstNode = (value: unknown): value is AstNode => typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";

// The daemon's log() writes operator diagnostics that never reach an agent; console output can, so it stays scanned.
function isDaemonLogCall(node: AstNode): boolean {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee as AstNode;
  if (callee.type === "Identifier") return callee.name === "log";
  if (callee.type !== "MemberExpression" || (callee.property as AstNode).name !== "log") return false;
  const object = callee.object as AstNode;
  return !(object.type === "Identifier" && object.name === "console");
}

interface TextLiteral {
  /** Source offset of each template chunk, aligned with the chunk's start in `text`. */
  parts: Array<{ start: number; offset: number }>;
  text: string;
}

const PLACEHOLDER = "${…}";

function lineOf(source: string, literal: TextLiteral, index: number): number {
  const part = literal.parts.findLast((p) => p.offset <= index) ?? literal.parts[0]!;
  return source.slice(0, part.start).split("\n").length + literal.text.slice(part.offset, index).split("\n").length - 1;
}

function textLiterals(file: string, source: string): TextLiteral[] {
  const { program, errors } = parseSync(file, source);
  if (errors.length > 0) throw new Error(`${file}: ${errors[0]!.message}`);
  const out: TextLiteral[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!isAstNode(value) || isDaemonLogCall(value)) return;
    if (value.type === "Literal" && typeof value.value === "string") out.push({ parts: [{ start: value.start, offset: 0 }], text: value.value });
    if (value.type === "TemplateLiteral") {
      const quasis = value.quasis as Array<{ start: number; value: { cooked: string | null; raw: string } }>;
      const parts: TextLiteral["parts"] = [];
      let text = "";
      for (const [i, q] of quasis.entries()) {
        if (i > 0) text += PLACEHOLDER;
        parts.push({ start: q.start, offset: text.length });
        text += q.value.cooked ?? q.value.raw;
      }
      out.push({ parts, text });
    }
    for (const [key, child] of Object.entries(value)) if (key !== "parent") visit(child);
  };
  visit(program);
  return out.filter((literal) => CJK.test(literal.text));
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function renderedTexts(): Array<{ name: string; text: string }> {
  const cwd = mkdtempSync(join(tmpdir(), "prompt-portability-"));
  tempDirs.push(cwd);
  const project = card(1, "ledger-app", "/work/ledger-app");
  const texts: Array<{ name: string; text: string }> = [
    { name: "router system prompt", text: buildRouterSystemPrompt() },
    { name: "project catalog prompt", text: buildCatalogSystemPrompt() },
    { name: "task graph skill", text: taskGraphSkillMarkdown() },
    { name: "review checklist", text: REVIEW_CHECKLIST },
    { name: "hub usage", text: HUB_USAGE },
    { name: "worker report format", text: WORKER_REPORT_FORMAT },
  ];
  for (const vendor of AGENT_VENDORS) {
    for (const mode of PM_MODES) {
      const pm = { ...projectContext().pm, vendor, mode };
      texts.push({ name: `PM prompt (${vendor}, ${mode})`, text: buildLaunchPrompt(projectContext({ pm, project }), cwd) });
      texts.push({ name: `PM prompt without project (${vendor}, ${mode})`, text: buildLaunchPrompt(noProjectContext({ pm }), cwd) });
    }
    texts.push({ name: `Worker prompt (${vendor})`, text: buildWorkerSystemPrompt({ ...workerContext({ readonly: true }), vendor, project }, cwd) });
  }
  const worker = { id: 5, title: "fix login", workspace: "worktree" as const, worktreePath: "/w/5", branch: "hub/5", readonly: false };
  const task = "Fix the login button.";
  texts.push({ name: "Worker first message (fresh worktree)", text: buildWorkerFirstMessage({ project, worker, task }) });
  texts.push({ name: "Worker first message (takeover)", text: buildWorkerFirstMessage({ project, worker: { ...worker, takeoverOf: 4 }, task }) });
  texts.push({ name: "Worker first message (inherited)", text: buildWorkerFirstMessage({ project, worker, task, inheritedFromUpstreamWorkerId: 4 }) });
  texts.push({ name: "Worker first message (review)", text: buildWorkerFirstMessage({ project, worker: { ...worker, review: { branch: "feature/x", snapshot: null } }, task }) });
  texts.push({ name: "Worker first message (main folder)", text: buildWorkerFirstMessage({ project, worker: { ...worker, workspace: "main", worktreePath: null, branch: null }, task }) });
  return texts;
}

const ruleIdsIn = (text: string): string[] => violationsIn(text).map((v) => v.rule.id);

describe("product text holds in any project", () => {
  it("passes a repo-specific name shown as an example or scoped by a condition", () => {
    const legitimate = [
      "没配准备命令时依赖可能要按项目的方式重新装（比如 `pnpm install`、`pip install -r requirements.txt`）。",
      "要留在 PR 上的意见发成评论（如 GitHub 的 `gh pr comment`）。",
      "主干不一定叫 main，例如 `git show origin/main:REVIEW.md` 或 `git show trunk:REVIEW.md`。",
      "截图放在系统临时目录里，比如 macOS、Linux 的 `/tmp`。",
      "Worker 也要遵守的规矩写进项目已有的规矩文件，比如项目的 `AGENTS.md` 或 `CONTRIBUTING.md`。",
      "改动可能碰到别处，诸如 src/shared/limits.ts 这类共享阈值文件。",
      "项目托管在 GitHub 的话，等检查用 `gh pr checks <PR 号> --watch`。",
      "如果项目用 pnpm，依赖用 `pnpm install` 装。",
      "长文本用 --stdin 从标准输入读，例如：\n  hub persona edit --stdin <<'EOF'\n  正文\n  EOF",
      "bash、zsh 用 `--stdin <<'EOF'`；PowerShell 用单引号 here-string 管道传入。",
      "主干叫 main、远端叫 origin 的话，用 `git diff --name-only origin/main...HEAD` 列出改动。",
      "macOS、Linux 用守护进程的 $SHELL -c 跑，Windows 依次找 Git Bash、PowerShell 7、cmd。",
      "传正文一律用 `--stdin <<'EOF'`。\nWindows 上用 PowerShell 的 here-string 管道传入。",
      "如果项目用 `pnpm`，依赖用 `pnpm install` 装。",
      "仅当仓库托管在 GitHub 时，才用 `gh pr checks --watch` 等检查。",
      "如果工作目录里有 `AGENTS.md`，开始前先读它。",
      "跟用户用同一种语言回复。",
      "如果用户说中文，就用中文回复。",
      "别名收集用户实际用过的叫法：代号、产品名、中文叫法。",
    ];
    for (const text of legitimate) expect(ruleIdsIn(text), text).toEqual([]);
  });

  it("rejects a repo-specific name written as an instruction for every project", () => {
    const binding: Array<[string, string]> = [
      ["toolchain-command", "装依赖一律用 `pnpm install`。"],
      ["github-cli", "要留在 PR 上的意见用 `gh pr comment` 发评论。"],
      ["fixed-trunk-or-remote", "先 `git fetch origin main`，再 `git show origin/main:REVIEW.md`。"],
      ["posix-shell-only", "传正文一律用 `--stdin <<'EOF'`（引号不能省）。"],
      ["posix-shell-only", "准备命令用守护进程的 $SHELL -c 跑。"],
      ["posix-temp-path", "截图放在 worktree 或 `/tmp` 里。"],
      ["assumed-rules-file", "合并和发布按项目 `AGENTS.md` 的规矩做。"],
      ["bellwood-source-path", "阈值写进 src/shared/limits.ts。"],
      ["github-cli", "比如改了接口，就用 `gh pr comment` 通知。"],
      ["toolchain-command", "（如 Node 项目）装依赖一律 `pnpm install`。"],
      ["toolchain-command", "比如 `pnpm install`。之后装依赖一律用 `pnpm install`。"],
      ["toolchain-command", "如何装依赖：`pnpm install`。"],
      ["github-cli", "项目托管在 GitHub 的话会更快。等检查一律用 `gh pr checks --watch`。"],
      ["github-cli", "比如这类改动要用 `gh pr comment` 通知。"],
      ["posix-shell-only", "只有当用户交代了多个目标，才用 `--stdin <<'EOF'` 分别投递。"],
      ["fixed-trunk-or-remote", "仅当项目有 `REVIEW.md` 时：先 `git fetch origin main`，再看 `git show origin/main:REVIEW.md`。"],
      ["posix-shell-only", "传正文一律用 `--stdin <<'EOF'`。\n\n# 安装\n\nWindows 上先装 PowerShell 7。"],
      ["toolchain-command", "只有跑完 `pnpm test:related` 才能汇报做完了。"],
      ["toolchain-command", "如果改了代码必须跑 `pnpm typecheck`。"],
      ["github-cli", "只有通过了 `gh pr checks` 才能合并。"],
      ["github-cli", "若要提 PR 请运行 `gh pr create`。"],
      ["fixed-trunk-or-remote", "如果改动了 src/main.ts，请先运行 `git diff origin/main...HEAD`。"],
      ["fixed-trunk-or-remote", "先 git fetch origin main，再看主干。"],
      ["fixed-trunk-or-remote", "改完先 git rebase main 再推送。"],
      ["assumed-rules-file", "写进项目里的 `AGENTS.md`。"],
      ["assumed-rules-file", "按 `AGENTS.md` 的规矩做。"],
      ["assumed-rules-file", "先读 `AGENTS.md` 里的审查清单。"],
      ["fixed-reply-language", "回复用中文，简洁直接。"],
      ["fixed-reply-language", "直接用一两句简洁中文告诉用户原因。"],
      ["fixed-reply-language", "开头说清做成了什么，用中文简洁直接回答。"],
      ["fixed-reply-language", "Always reply in Chinese."],
    ];
    for (const [id, text] of binding) expect(ruleIdsIn(text), text).toContain(id);
  });

  it("Chinese string literals in product source write no repo, toolchain, host, or POSIX-only specifics as instructions", () => {
    const hits: string[] = [];
    for (const file of productSourceFiles()) {
      const source = readFileSync(join(ROOT, file), "utf8");
      for (const literal of textLiterals(file, source)) {
        for (const v of violationsIn(literal.text)) hits.push(`${file}:${lineOf(source, literal, v.index)} ${describeViolation(literal.text, v)}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("rendered prompts, skills, checklists, and hub help write no repo, toolchain, host, or POSIX-only specifics as instructions", () => {
    const surfacesByHit = new Map<string, string[]>();
    for (const { name, text } of renderedTexts()) {
      for (const v of violationsIn(text)) {
        const key = describeViolation(text, v);
        surfacesByHit.set(key, [...(surfacesByHit.get(key) ?? []), name]);
      }
    }
    const hits = [...surfacesByHit].map(([key, names]) => `${names[0]}${names.length > 1 ? ` (+${names.length - 1} more)` : ""} ${key}`);
    expect(hits).toEqual([]);
  });

  it("only hub help lists the command that restarts this product's own daemon", () => {
    const mentions = renderedTexts().filter(({ name, text }) => name !== "hub usage" && text.includes("self-reload"));
    expect(mentions.map(({ name }) => name)).toEqual([]);
  });
});
