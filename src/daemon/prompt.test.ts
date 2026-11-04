import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HUB_COMMANDS, PM_PERSONA_TEMPLATE, WORKER_REPORT_FORMAT } from "../shared/index.ts";
import { HUB_COMMAND } from "../shared/names.ts";
import {
  AGENTS_NOTE,
  HUB_USAGE_PROMPT,
  PM_MODE_PROMPTS,
  PM_WORKER_PROMPT,
  WORKER_HUB_USAGE_PROMPT,
  WORKER_READONLY_NOTE,
  WORKER_RULES,
  buildLaunchPrompt,
  buildWorkerPrompt,
  needsAgentsNote,
} from "./prompt.ts";
import { card, noProjectContext, projectContext, workerContext } from "./test-helpers.ts";

/** 命令名（names.ts）：改名只改那一处，这里的断言跟着变。 */
const hub = HUB_COMMAND;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-hub-prompt-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("提示词", () => {
  it("“先读 AGENTS.md”只在 AGENTS.md、CLAUDE.md 都有，而且 CLAUDE.md 没写 @AGENTS.md 时加", () => {
    expect(needsAgentsNote(dir)).toBe(false); // 空目录
    writeFileSync(join(dir, "AGENTS.md"), "# 规矩");
    expect(needsAgentsNote(dir)).toBe(false); // 只有 AGENTS.md：Claude 自己会读
    writeFileSync(join(dir, "CLAUDE.md"), "# 说明");
    expect(needsAgentsNote(dir)).toBe(true);
    writeFileSync(join(dir, "CLAUDE.md"), "@AGENTS.md\n");
    expect(needsAgentsNote(dir)).toBe(false);
    rmSync(join(dir, "AGENTS.md"));
    writeFileSync(join(dir, "CLAUDE.md"), "# 只有 CLAUDE.md");
    expect(needsAgentsNote(dir)).toBe(false);
  });
});

// ---- 11-03 起一个项目经理就是一个会话，最多管一个项目 ----

describe("提示词：有项目", () => {
  it("manage_only：角色、只管一个项目、性格、“只管理”的默认做法（派 Worker）、项目名和全部文件夹、hub 用法", () => {
    const prompt = buildLaunchPrompt(projectContext(), dir);
    expect(prompt).toContain("小林");
    expect(prompt).toContain("一个项目经理只管一个项目，请新建一个项目经理");
    expect(prompt).toContain("- 说话直接。");
    expect(prompt).toContain(PM_MODE_PROMPTS.manage_only);
    expect(PM_MODE_PROMPTS.manage_only).toMatch(/派 Worker/);
    expect(prompt).not.toContain(PM_MODE_PROMPTS.hands_on);
    expect(prompt).toContain("- 项目：foo");
    expect(prompt).toContain("做一个记账小工具");
    expect(prompt).toContain("主文件夹（工作目录）：/work/foo");
    expect(prompt).toContain("  - /work/foo-docs");
    expect(prompt).toContain(HUB_USAGE_PROMPT);
    expect(prompt).not.toContain("群");
    expect(prompt).not.toContain("交接");
  });

  it("hub 用法写明直接敲 hub、不要在命令里写变量；长文本用 --stdin heredoc；只列现在有的子命令", () => {
    expect(HUB_USAGE_PROMPT).toContain("不要在命令里写任何环境变量");
    expect(HUB_USAGE_PROMPT).toContain(`${hub} 会自己读`);
    expect(HUB_USAGE_PROMPT).not.toContain("$HUB_TOKEN");
    expect(HUB_USAGE_PROMPT).not.toContain("$HUB_SOCK");
    expect(HUB_USAGE_PROMPT).toContain("--stdin <<'EOF'");
    expect(HUB_USAGE_PROMPT).toContain(`不要在 \`${hub}\` 命令后面接 \`echo $?\``);
    for (const sub of [`${hub} status`, `${hub} project create --folder`, `${hub} project attach <文件夹路径>`, `${hub} project detach <文件夹路径>`, `${hub} persona show`, `${hub} persona edit`]) {
      expect(HUB_USAGE_PROMPT).toContain(sub);
    }
    for (const gone of [`${hub} pm list`, `${hub} project assign`, "交接", "群"]) expect(HUB_USAGE_PROMPT).not.toContain(gone);
    expect(HUB_USAGE_PROMPT).toContain("一个项目经理只管一个项目");
  });

  it("按 M1 规则加“先读 AGENTS.md”：主文件夹里 AGENTS.md、CLAUDE.md 都有、CLAUDE.md 没引用时才加", () => {
    expect(buildLaunchPrompt(projectContext(), dir)).not.toContain(AGENTS_NOTE);
    writeFileSync(join(dir, "AGENTS.md"), "x");
    writeFileSync(join(dir, "CLAUDE.md"), "y");
    expect(buildLaunchPrompt(projectContext(), dir).trimEnd().endsWith(AGENTS_NOTE)).toBe(true);
  });

  it("没有附加文件夹、没有说明：附加文件夹写“没有”，不出说明那一行", () => {
    const prompt = buildLaunchPrompt(projectContext({ project: card(1, "foo", "/work/foo") }), dir);
    expect(prompt).toMatch(/附加文件夹（也能读写）：没有/);
    expect(prompt).not.toContain("- 说明：");
  });

  it("性格设定是空的（用户清空了）：不出空的一节，其余照常", () => {
    const prompt = buildLaunchPrompt(projectContext({ pm: { id: 1, name: "小林", mode: "manage_only", persona: "  \n" } }), dir);
    expect(prompt).toContain(PM_MODE_PROMPTS.manage_only);
    expect(prompt).not.toMatch(/\n\n\n/);
  });
});

describe("提示词：还没有项目", () => {
  it("hands_on：“自己也干活”的做法、性格设定模板；写明还没有项目、在自己的空文件夹里、怎么建", () => {
    const prompt = buildLaunchPrompt(noProjectContext(), dir);
    expect(prompt).toContain("阿周");
    expect(prompt).toContain(PM_MODE_PROMPTS.hands_on);
    expect(prompt).not.toContain(PM_MODE_PROMPTS.manage_only);
    expect(prompt).toContain(PM_PERSONA_TEMPLATE.trim());
    expect(prompt).toMatch(/还没有项目，工作目录是你自己的空文件夹/);
    expect(prompt).toContain(`${hub} project create --folder <文件夹>`);
    expect(prompt).not.toContain("主文件夹（工作目录）");
  });
});

// ---- M3：Worker ----

describe("提示词：项目经理（M3）", () => {
  it("“只管理”写成派 Worker、验收；两种模式都有派 Worker 的说明和 hub worker 用法", () => {
    expect(PM_MODE_PROMPTS.manage_only).toContain(`${hub} worker start`);
    expect(PM_MODE_PROMPTS.manage_only).toContain("验收");
    for (const ctx of [projectContext(), noProjectContext()]) {
      const prompt = buildLaunchPrompt(ctx, dir);
      expect(prompt).toContain(PM_WORKER_PROMPT);
      expect(prompt).toContain(HUB_USAGE_PROMPT);
    }
  });

  it("派 Worker 说明：worktree、--no-worktree、汇报怎么回来、打回用 hub worker send、收工用 hub worker end、按 AGENTS.md 协作", () => {
    for (const word of ["worktree", "主文件夹", "--no-worktree", "【Worker #", `${hub} worker send`, `${hub} worker end`, "AGENTS.md"]) {
      expect(PM_WORKER_PROMPT).toContain(word);
    }
  });

  it("不写死工作流程（11-04）：没有合并步骤、没有利弊表、没有先问用户清单、没有建议用便宜的模型", () => {
    const prompt = buildLaunchPrompt(projectContext(), dir);
    for (const gone of [
      "先问用户的事",
      "git merge --no-ff",
      "合并和收拾 worktree",
      "只在本地合并，不推送",
      "分支留着",
      "| 好处 |",
      "| 坏处 |",
      "便宜的模型",
      "brew",
      "sudo",
    ]) {
      expect(prompt).not.toContain(gone);
    }
  });

  it("hub 用法有 hub worker 的四个命令，和 shared/hub.ts 的命令表对得上", () => {
    for (const sub of [
      `${hub} worker start --title <标题> [--model <模型>] [--readonly] [--no-worktree] --stdin`,
      `${hub} worker send <编号> --stdin`,
      `${hub} worker end <编号>`,
      `${hub} worker list`,
    ]) {
      expect(HUB_USAGE_PROMPT).toContain(sub);
    }
    // 命令表里的每个命令都写进了用法
    for (const command of HUB_COMMANDS) expect(HUB_USAGE_PROMPT).toContain(`${HUB_COMMAND} ${command.replace(".", " ")}`);
  });
});

describe("提示词：Worker（M3）", () => {
  it("在 worktree 里：任务、标题、派它的项目经理、worktree 路径和分支、汇报格式、只有 hub status；没有性格设定、模式、hub worker", () => {
    const prompt = buildWorkerPrompt(workerContext(), dir);
    expect(prompt).toContain("Worker #5");
    expect(prompt).toContain("修登录按钮");
    expect(prompt).toContain("小林");
    expect(prompt).toContain("登录按钮点了没反应，查原因并修好。验收：pnpm test 全绿。");
    expect(prompt).toContain("/data/worktrees/1/5");
    expect(prompt).toContain("hub/5-修登录按钮");
    expect(prompt).toContain(WORKER_REPORT_FORMAT);
    expect(prompt).toContain(WORKER_HUB_USAGE_PROMPT);
    expect(WORKER_HUB_USAGE_PROMPT).toContain(`${hub} status`);
    for (const gone of [`${hub} worker`, `${hub} persona`, `${hub} project`]) expect(WORKER_HUB_USAGE_PROMPT).not.toContain(gone);
    expect(prompt).not.toContain(`${hub} worker start`);
    expect(prompt).not.toContain("说话直接");
    expect(prompt).not.toContain(PM_MODE_PROMPTS.manage_only);
    expect(prompt).not.toContain(PM_MODE_PROMPTS.hands_on);
    expect(prompt).not.toContain("只读");
  });

  it("不能改记忆文件，要改就写进汇报的问题；问不了用户，有问题写进汇报交给项目经理；没有先问用户的事", () => {
    const prompt = buildWorkerPrompt(workerContext(), dir);
    expect(prompt).toContain(WORKER_RULES);
    for (const word of ["AGENTS.md", "CLAUDE.md", ".claude/", "不能改", "“问题”"]) expect(WORKER_RULES).toContain(word);
    expect(WORKER_RULES).toMatch(/问不了用户/);
    for (const gone of ["先问用户的事", "git push", "brew", "sudo", "合并由项目经理来做"]) {
      expect(prompt).not.toContain(gone);
    }
  });

  it("在主文件夹里：写明主文件夹和附加文件夹，没有分支", () => {
    const prompt = buildWorkerPrompt(workerContext({ workspace: "main", branch: null, worktreePath: null, baseCommit: null }), dir);
    expect(prompt).toContain("/work/foo");
    expect(prompt).toContain("  - /work/foo-docs");
    expect(prompt).not.toContain("/data/worktrees");
    expect(prompt).not.toContain("分支：");
  });

  it("只读：写明这次只看不改", () => {
    const prompt = buildWorkerPrompt(workerContext({ readonly: true }), dir);
    expect(prompt).toContain(WORKER_READONLY_NOTE);
  });

  it("按 M1 规则加“先读 AGENTS.md”（看 Worker 的工作目录）", () => {
    writeFileSync(join(dir, "AGENTS.md"), "x");
    writeFileSync(join(dir, "CLAUDE.md"), "y");
    expect(buildWorkerPrompt(workerContext(), dir).trimEnd().endsWith(AGENTS_NOTE)).toBe(true);
  });

  it("buildLaunchPrompt 按角色分：Worker 的上下文得到 Worker 的提示词", () => {
    expect(buildLaunchPrompt(workerContext(), dir)).toBe(buildWorkerPrompt(workerContext(), dir));
  });
});
