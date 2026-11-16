// 认出加载技能（skill-loads.ts）：每家至少一个“用户手打”、一个“模型加载”的样例，参数形状照账本里的真实记录
// （docs/skill-carryover-design.md 的表）；SAMPLES 按 AgentVendor 写全，加一家新厂商不补样例类型检查就不过。
import { describe, expect, it } from "vitest";
import { toolSkillLoads, userSkillCommandOf, type SkillLoad } from "./skill-loads.ts";
import { AGENT_VENDORS, type AgentVendor } from "./vendors.ts";

interface ToolSample {
  tool: string;
  input: unknown;
  loads: SkillLoad[];
}

const HOME = "/Users/u";
const file = (name: string, path: string, cwd: readonly string[] = []): SkillLoad => ({ by: "file", name, path, cwd });

const SAMPLES: Record<AgentVendor, { user: [string, string][]; model: ToolSample[] }> = {
  claude: {
    user: [
      ["/poteto-mode 这个skill更新了", "poteto-mode"],
      ["/fusa:fusa-task-graph", "fusa-task-graph"],
    ],
    model: [
      { tool: "Skill", input: { skill: "frontend-rules" }, loads: [{ by: "name", name: "frontend-rules" }] },
      { tool: "Skill", input: { skill: "fusa:fusa-task-graph" }, loads: [{ by: "name", name: "fusa-task-graph" }] },
      {
        tool: "Read",
        input: { file_path: `${HOME}/agent-hub/.agents/skills/poteto-mode/SKILL.md` },
        loads: [file("poteto-mode", `${HOME}/agent-hub/.agents/skills/poteto-mode/SKILL.md`)],
      },
      { tool: "Bash", input: { command: "cat .agents/skills/poteto-mode/SKILL.md" }, loads: [file("poteto-mode", ".agents/skills/poteto-mode/SKILL.md")] },
      {
        tool: "Bash",
        input: {
          command: `cd ${HOME}/dramabreak/data-agent; grep -niE "pdate|days" .agent/guardrails.md | head -25; sed -n 1,20p docs/plans/data_agent.md; sed -n 25,40p agent_home/.claude/skills/data-traps/SKILL.md`,
        },
        loads: [file("data-traps", "agent_home/.claude/skills/data-traps/SKILL.md", [`${HOME}/dramabreak/data-agent`])],
      },
    ],
  },
  agy: {
    user: [["/unslop", "unslop"]],
    model: [
      { tool: "read_file", input: { Path: `${HOME}/.claude/skills/frontend-rules/SKILL.md` }, loads: [file("frontend-rules", `${HOME}/.claude/skills/frontend-rules/SKILL.md`)] },
      { tool: "view_file", input: { AbsolutePath: `${HOME}/.gemini/config/skills/unslop/SKILL.md` }, loads: [file("unslop", `${HOME}/.gemini/config/skills/unslop/SKILL.md`)] },
      { tool: "run_command", input: { CommandLine: `cat ${HOME}/a/.agents/skills/unslop/SKILL.md` }, loads: [file("unslop", `${HOME}/a/.agents/skills/unslop/SKILL.md`)] },
    ],
  },
  codex: {
    user: [
      ["/poteto-mode", "poteto-mode"],
      ["$poteto-mode 看一下", "poteto-mode"],
    ],
    model: [
      {
        tool: "commandExecution",
        input: {
          command: `/bin/zsh -lc 'pwd; cat AGENTS.md; cat ${HOME}/agent-hub/.agents/skills/blast-radius/SKILL.md; cat .agents/skills/typescript-best-practices/SKILL.md; git status --short'`,
          cwd: `${HOME}/wt`,
        },
        loads: [
          file("blast-radius", `${HOME}/agent-hub/.agents/skills/blast-radius/SKILL.md`, [`${HOME}/wt`]),
          file("typescript-best-practices", ".agents/skills/typescript-best-practices/SKILL.md", [`${HOME}/wt`]),
        ],
      },
      {
        // 多行脚本：codex 自己的 parsed_cmd 认成 unknown 的那种
        tool: "commandExecution",
        input: { command: `/bin/zsh -lc 'set -e\nsed -n "1,200p" .agents/skills/poteto-mode/SKILL.md\necho done'`, cwd: "/w" },
        loads: [file("poteto-mode", ".agents/skills/poteto-mode/SKILL.md", ["/w"])],
      },
    ],
  },
  pi: {
    user: [["/skill:frontend-rules", "frontend-rules"]],
    model: [
      { tool: "read", input: { path: `${HOME}/.agents/skills/frontend-rules/SKILL.md` }, loads: [file("frontend-rules", `${HOME}/.agents/skills/frontend-rules/SKILL.md`)] },
      { tool: "bash", input: { command: "head -50 ~/.agents/skills/unslop/SKILL.md" }, loads: [file("unslop", "~/.agents/skills/unslop/SKILL.md")] },
    ],
  },
  deepseek: {
    user: [["/frontend-rules 做个页面", "frontend-rules"]],
    model: [
      { tool: "skill", input: { name: "frontend-rules" }, loads: [{ by: "name", name: "frontend-rules" }] },
      { tool: "read", input: { path: "/r/.agents/skills/unslop/SKILL.md" }, loads: [file("unslop", "/r/.agents/skills/unslop/SKILL.md")] },
    ],
  },
  cursor: {
    user: [["/frontend-rules", "frontend-rules"]],
    model: [
      { tool: "Read", input: { path: "/r/.agents/skills/unslop/SKILL.md" }, loads: [file("unslop", "/r/.agents/skills/unslop/SKILL.md")] },
      { tool: "Shell", input: { command: "cat .agents/skills/unslop/SKILL.md" }, loads: [file("unslop", ".agents/skills/unslop/SKILL.md")] },
    ],
  },
};

describe("每家都认得出用户手打和模型加载", () => {
  for (const vendor of AGENT_VENDORS) {
    const { user, model } = SAMPLES[vendor];
    it(`${vendor}：至少一个用户手打、一个模型加载的样例`, () => {
      expect(user.length).toBeGreaterThan(0);
      expect(model.length).toBeGreaterThan(0);
    });
    for (const [text, name] of user) {
      it(`${vendor} 用户手打：${text}`, () => {
        expect(userSkillCommandOf(vendor, text)).toBe(name);
      });
    }
    for (const sample of model) {
      it(`${vendor} 模型加载：${sample.tool} ${JSON.stringify(sample.input).slice(0, 80)}`, () => {
        expect(toolSkillLoads(vendor, sample.tool, sample.input)).toEqual(sample.loads);
      });
    }
  }
});

describe("不算加载", () => {
  const bash = (command: string) => toolSkillLoads("claude", "Bash", { command });

  it("不读正文的命令：ls、wc、grep、find、stat、cp", () => {
    for (const cmd of ["ls a/skills/x/SKILL.md", "wc -l a/skills/x/SKILL.md", "grep foo a/skills/x/SKILL.md", "find . -name SKILL.md", "stat a/skills/x/SKILL.md", "cp a/skills/x/SKILL.md /tmp/x.md"]) {
      expect(bash(cmd), cmd).toEqual([]);
    }
  });

  it("在写：cat > 、sed -i；输出重定向到别处的不进上下文", () => {
    expect(bash("cat > a/skills/x/SKILL.md <<'EOF'\nhi\nEOF")).toEqual([]);
    expect(bash("sed -i '' 's/a/b/' a/skills/x/SKILL.md")).toEqual([]);
    expect(bash("cat a/skills/x/SKILL.md > /tmp/copy.md")).toEqual([]);
  });

  it("只把错误输出丢掉的照样算读", () => {
    expect(bash("cat a/skills/x/SKILL.md 2>/dev/null")).toEqual([file("x", "a/skills/x/SKILL.md")]);
  });

  it("没展开的变量认不出", () => {
    expect(toolSkillLoads("agy", "run_command", { CommandLine: "cat $S/poteto-mode/SKILL.md" })).toEqual([]);
  });

  it("不在 skills/<名字>/ 下的 SKILL.md 不是技能", () => {
    expect(toolSkillLoads("claude", "Read", { file_path: "/repo/docs/SKILL.md" })).toEqual([]);
    expect(toolSkillLoads("claude", "Read", { file_path: "/repo/node_modules/pkg/SKILL.md" })).toEqual([]);
    expect(bash("cat docs/SKILL.md")).toEqual([]);
  });

  it("改、写 SKILL.md 不算加载；没列的工具、参数不对的不算", () => {
    expect(toolSkillLoads("claude", "Edit", { file_path: "/r/.agents/skills/x/SKILL.md", old_string: "a", new_string: "b" })).toEqual([]);
    expect(toolSkillLoads("claude", "Write", { file_path: "/r/.agents/skills/x/SKILL.md", content: "" })).toEqual([]);
    expect(toolSkillLoads("claude", "Monitor", { file_path: "/r/.agents/skills/x/SKILL.md" })).toEqual([]);
    expect(toolSkillLoads("claude", "Skill", { skill: 3 })).toEqual([]);
    expect(toolSkillLoads("claude", "Skill", null)).toEqual([]);
  });

  it("没有原生技能工具参数键的厂商不按名字认", () => {
    expect(toolSkillLoads("agy", "Skill", { skill: "x" })).toEqual([]);
  });

  it("用户原文不是命令：中间的斜杠、前面有空格、文件路径", () => {
    expect(userSkillCommandOf("claude", "看一下 /poteto-mode")).toBeNull();
    expect(userSkillCommandOf("claude", " /poteto-mode")).toBeNull();
    expect(userSkillCommandOf("claude", "/tmp/a.txt 看看")).toBeNull();
    expect(userSkillCommandOf("claude", "$poteto-mode")).toBeNull();
  });
});
