import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PM_PERSONA_TEMPLATE } from "../shared/index.ts";
import { AGENTS_NOTE, HUB_USAGE_PROMPT, PM_MODE_PROMPTS, buildLaunchPrompt, needsAgentsNote } from "./prompt.ts";
import { card, groupContext, privateContext } from "./test-helpers.ts";

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

// ---- M2：m2-plan 第 4 节 W3 的提示词那几条 ----

describe("提示词：群", () => {
  it("manage_only：角色、性格、“只管理”的默认做法（要动手先问用户）、项目名和文件夹、交接正文、hub 用法", () => {
    const prompt = buildLaunchPrompt(groupContext(), dir);
    expect(prompt).toContain("小林");
    expect(prompt).toContain("项目群");
    expect(prompt).toContain("- 说话直接。");
    expect(prompt).toContain(PM_MODE_PROMPTS.manage_only);
    expect(PM_MODE_PROMPTS.manage_only).toMatch(/先问用户/);
    expect(prompt).not.toContain(PM_MODE_PROMPTS.hands_on);
    expect(prompt).toContain("foo");
    expect(prompt).toContain("做一个记账小工具");
    expect(prompt).toContain("/work/foo");
    expect(prompt).toContain("/work/foo-docs");
    expect(prompt).toContain("阿周");
    expect(prompt).toContain("发布日期定在周五。还差登录页。");
    expect(prompt).toContain(HUB_USAGE_PROMPT);
    // 群里只说这个项目：不放它管的别的项目
    expect(prompt).not.toContain("/work/bar");
    expect(prompt).not.toMatch(/\bbar\b/);
  });

  it("hub 用法写明直接敲 hub、不要在命令里写变量；长文本用 --stdin heredoc；列出 M2 的全部子命令", () => {
    expect(HUB_USAGE_PROMPT).toContain("不要在命令里写任何环境变量");
    expect(HUB_USAGE_PROMPT).toContain("hub 会自己读");
    expect(HUB_USAGE_PROMPT).not.toContain("$HUB_TOKEN");
    expect(HUB_USAGE_PROMPT).not.toContain("$HUB_SOCK");
    expect(HUB_USAGE_PROMPT).toContain("--stdin <<'EOF'");
    expect(HUB_USAGE_PROMPT).toContain("不要在 `hub` 命令后面接 `echo $?`");
    for (const sub of [
      "hub status",
      "hub pm list",
      "hub project create --name",
      "hub project attach",
      "hub project detach",
      "hub project assign",
      "hub persona show",
      "hub persona edit",
    ]) {
      expect(HUB_USAGE_PROMPT).toContain(sub);
    }
  });

  it("按 M1 规则加“先读 AGENTS.md”：主文件夹里 AGENTS.md、CLAUDE.md 都有、CLAUDE.md 没引用时才加", () => {
    expect(buildLaunchPrompt(groupContext(), dir)).not.toContain(AGENTS_NOTE);
    writeFileSync(join(dir, "AGENTS.md"), "x");
    writeFileSync(join(dir, "CLAUDE.md"), "y");
    expect(buildLaunchPrompt(groupContext(), dir).trimEnd().endsWith(AGENTS_NOTE)).toBe(true);
  });

  it("没有交接、没有其他文件夹：不出交接那一节，文件夹写“没有”", () => {
    const foo = card(1, "foo", "/work/foo");
    const prompt = buildLaunchPrompt(groupContext({ project: foo, handoff: null }), dir);
    expect(prompt).not.toContain("最近一份交接");
    expect(prompt).toMatch(/其他文件夹：没有/);
  });

  it("性格设定是空的（用户清空了）：不出空的一节，其余照常", () => {
    const prompt = buildLaunchPrompt(groupContext({ pm: { id: 1, name: "小林", mode: "manage_only", persona: "  \n" } }), dir);
    expect(prompt).toContain(PM_MODE_PROMPTS.manage_only);
    expect(prompt).not.toMatch(/\n\n\n/);
  });
});

describe("提示词：私聊", () => {
  it("hands_on、管两个项目：有两个项目的名片和“自己也干活”的做法，没有某个项目的文件夹", () => {
    const prompt = buildLaunchPrompt(privateContext(), dir);
    expect(prompt).toContain("私聊");
    expect(prompt).toContain(PM_MODE_PROMPTS.hands_on);
    expect(prompt).not.toContain(PM_MODE_PROMPTS.manage_only);
    expect(prompt).toContain("foo");
    expect(prompt).toContain("做一个记账小工具");
    expect(prompt).toContain("bar");
    expect(prompt).not.toContain("/work/foo");
    expect(prompt).not.toContain("/work/bar");
    expect(prompt).not.toContain("项目信息");
    expect(prompt).toContain(HUB_USAGE_PROMPT);
    expect(prompt).toContain(PM_PERSONA_TEMPLATE.trim());
  });

  it("还没管项目：写明现在没有项目、怎么建", () => {
    const prompt = buildLaunchPrompt(privateContext({ managedProjects: [] }), dir);
    expect(prompt).toMatch(/还没有项目/);
    expect(prompt).toContain("hub project create");
  });
});
