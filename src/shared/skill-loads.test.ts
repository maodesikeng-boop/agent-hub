// 认出“加载了一个技能”（skill-loads.ts，docs/skill-carryover-design.md 的识别规则）：返回原文里出现已知技能的开头才算；
// 返回里没有正文的读文件工具（agy 的 read_file）按路径参数和名单比真实路径；原生技能工具、用户手打按名字。
// 返回原文用各家实时流里的真实形状（行号前缀、元信息头、\r\n）；PR #331 两份 FAIL 评论里的命令都在这里，结论只看返回。
import { describe, expect, it } from "vitest";
import type { AgentVendor } from "./vendors.ts";
import { SKILL_LOAD_SCAN_MAX_CHARS } from "./limits.ts";
import {
  awaitsToolResult,
  createSkillCatalog,
  skillHeads,
  skillNameOfToolCall,
  skillsOfToolResult,
  userSkillCommandOf,
  type KnownSkill,
  type SkillCatalog,
  type ToolCall,
} from "./skill-loads.ts";

const ROOT = "/repo/.agents/skills";
const POTETO = "---\nname: poteto-mode\ndescription: poteto's agent style\n---\n\n# Poteto mode\n\nBundled skills live next to this file.\n\n## Non-negotiables\n\nName each principle.\n";
const FRONTEND = "---\r\nname: frontend-rules\r\ndescription: 前端规范\r\n---\r\n\r\n# 前端规范\r\n渲染截图检查。\r\n";

const known = (name: string, text: string): KnownSkill => {
  const path = `${ROOT}/${name}/SKILL.md`;
  return { name, path, key: path, fileId: path, heads: skillHeads(text) };
};
const SKILLS = [known("poteto-mode", POTETO), known("frontend-rules", FRONTEND)];
/** 名单：.claude/skills 是指到 .agents/skills 的软链，两种写法是同一个文件。 */
const catalog: SkillCatalog = createSkillCatalog(SKILLS, (path) => {
  const real = path.replace("/repo/.claude/skills/", `${ROOT}/`);
  return SKILLS.some((s) => s.key === real) ? real : null;
});

const names = (vendor: string, call: ToolCall, output: string | undefined) => skillsOfToolResult(vendor, call, output, catalog).map((s) => s.name);
/** claude Read 的返回：每行“行号\t正文”（claude -p stream-json 实跑）。 */
const claudeRead = (text: string) =>
  text
    .split("\n")
    .map((line, i) => `${i + 1}\t${line}`)
    .join("\n");

describe("skillHeads：一个技能的开头", () => {
  it("frontmatter 头两行和正文头两行，空行、行尾空白、\\r\\n 不算", () => {
    expect(skillHeads(POTETO)).toEqual(["---\nname: poteto-mode", "# Poteto mode\nBundled skills live next to this file."]);
    expect(skillHeads(FRONTEND)).toEqual(["---\nname: frontend-rules", "# 前端规范\n渲染截图检查。"]);
  });

  it("没有 frontmatter：只有正文的开头", () => {
    expect(skillHeads("# 标题\n\n第一句。\n")).toEqual(["# 标题\n第一句。"]);
  });
});

/** 每家至少一个“用户手打”和一个“模型加载”：返回原文是实时流里驱动拿到的样子。新厂商不填这张表类型检查不过。 */
const SAMPLES: Record<AgentVendor, { user: string; model: { call: ToolCall; output: string }[] }> = {
  claude: {
    user: "/poteto-mode 这个skill更新了",
    model: [
      { call: { name: "Read", input: { file_path: `${ROOT}/poteto-mode/SKILL.md` } }, output: claudeRead(POTETO) },
      { call: { name: "Bash", input: { command: "cat .agents/skills/poteto-mode/SKILL.md" } }, output: POTETO },
    ],
  },
  codex: {
    user: "$poteto-mode 接着干",
    model: [{ call: { name: "commandExecution", input: { command: "/bin/zsh -lc 'cd /repo/.agents/skills && cat poteto-mode/SKILL.md'", cwd: "/repo" } }, output: POTETO }],
  },
  agy: {
    user: "/poteto-mode",
    model: [
      { call: { name: "read_file", input: { Path: `${ROOT}/poteto-mode/SKILL.md` } }, output: "14 lines, 310 bytes" },
      {
        call: { name: "run_command", input: { CommandLine: "cat .agents/skills/poteto-mode/SKILL.md" } },
        output: `Created At: 2026-11-16T15:42:56+08:00\nCompleted At: 2026-11-16T15:42:56+08:00\nCommand exited with code 0.\n\nCommand output:\n${POTETO.replaceAll("\n", "\r\n")}`,
      },
    ],
  },
  pi: {
    user: "/skill:poteto-mode",
    model: [{ call: { name: "read", input: { path: `${ROOT}/poteto-mode/SKILL.md` } }, output: POTETO }],
  },
  deepseek: {
    user: "/poteto-mode",
    model: [
      {
        call: { name: "read", input: { path: `${ROOT}/poteto-mode/SKILL.md` } },
        output: `<path>${ROOT}/poteto-mode/SKILL.md</path>\n<type>file</type>\n<content>\n${POTETO.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n")}\n\n(End of file - total 13 lines)\n</content>`,
      },
    ],
  },
  cursor: {
    user: "/poteto-mode",
    model: [
      { call: { name: "Read", input: { path: `${ROOT}/poteto-mode/SKILL.md` } }, output: POTETO },
      { call: { name: "Shell", input: { command: "cat .agents/skills/poteto-mode/SKILL.md" } }, output: POTETO },
    ],
  },
};

describe("每家：用户手打、模型加载都认得出", () => {
  for (const [vendor, sample] of Object.entries(SAMPLES)) {
    it(vendor, () => {
      expect(userSkillCommandOf(vendor, sample.user)).toBe("poteto-mode");
      for (const { call, output } of sample.model) {
        expect(awaitsToolResult(vendor, call.name)).toBe(true);
        expect(names(vendor, call, output)).toEqual(["poteto-mode"]);
      }
    });
  }

  it("原生技能工具调用那一刻按名字认：claude 的 Skill（插件写法去掉命名空间）、deepseek 的 skill", () => {
    expect(awaitsToolResult("claude", "Skill")).toBe(false);
    expect(skillNameOfToolCall("claude", { name: "Skill", input: { skill: "poteto-mode" } })).toBe("poteto-mode");
    expect(skillNameOfToolCall("claude", { name: "Skill", input: { skill: "fusa:fusa-task-graph" } })).toBe("fusa-task-graph");
    expect(skillNameOfToolCall("deepseek", { name: "skill", input: { name: "frontend-rules" } })).toBe("frontend-rules");
    expect(skillNameOfToolCall("claude", { name: "Read", input: { file_path: "x" } })).toBeNull();
  });

  it("名字穿越不了：`../../..`、`..`、带斜杠的不是技能名，名单里也找不到", () => {
    expect(skillNameOfToolCall("claude", { name: "Skill", input: { skill: "../../.." } })).toBeNull();
    expect(skillNameOfToolCall("claude", { name: "Skill", input: { skill: ".." } })).toBeNull();
    expect(userSkillCommandOf("claude", "/..")).toBeNull();
    expect(catalog.named("..")).toBeNull();
  });

  it("codex 另认 $名字；别家的 $ 不是命令", () => {
    expect(userSkillCommandOf("codex", "/poteto-mode")).toBe("poteto-mode");
    expect(userSkillCommandOf("claude", "$poteto-mode")).toBeNull();
  });

  it("编辑、写文件、搜索这类工具不等返回", () => {
    expect(awaitsToolResult("claude", "Edit")).toBe(false);
    expect(awaitsToolResult("claude", "Grep")).toBe(false);
    expect(awaitsToolResult("nobody", "Read")).toBe(false);
  });
});

describe("按返回内容认", () => {
  const bash = (command: string): ToolCall => ({ name: "Bash", input: { command } });

  it("一条命令读了几个技能，都认", () => {
    expect(names("claude", bash("cd /repo/.agents/skills && cat poteto-mode/SKILL.md frontend-rules/SKILL.md"), `${POTETO}${FRONTEND}`)).toEqual(["poteto-mode", "frontend-rules"]);
  });

  it("跳过 frontmatter 只读正文的也认", () => {
    expect(names("claude", bash("sed -n '5,$p' .agents/skills/poteto-mode/SKILL.md"), POTETO.split("\n").slice(4).join("\n"))).toEqual(["poteto-mode"]);
  });

  it("只读中段、输出被过滤、文件不存在：返回里没有开头，不算", () => {
    expect(names("claude", bash("sed -n '9,11p' .agents/skills/poteto-mode/SKILL.md"), "## Non-negotiables\n\nName each principle.\n")).toEqual([]);
    expect(names("claude", bash("cat .agents/skills/poteto-mode/SKILL.md | grep Name"), "Name each principle.\n")).toEqual([]);
    expect(names("claude", bash("cat .agents/skills/gone/SKILL.md"), "cat: .agents/skills/gone/SKILL.md: No such file or directory")).toEqual([]);
    expect(names("claude", { name: "Read", input: { file_path: "x" } }, "File does not exist.")).toEqual([]);
  });

  it(`开头出现在第 ${SKILL_LOAD_SCAN_MAX_CHARS} 字之后的不认`, () => {
    expect(names("claude", bash("cat big.log .agents/skills/poteto-mode/SKILL.md"), `${"x".repeat(SKILL_LOAD_SCAN_MAX_CHARS)}\n${POTETO}`)).toEqual([]);
  });

  it("没有返回原文（驱动拿不到）：不认", () => {
    expect(names("claude", bash("cat .agents/skills/poteto-mode/SKILL.md"), undefined)).toEqual([]);
  });

  it("名单外的同名文件、碰巧叫 SKILL.md 的文件：开头对不上，不认", () => {
    expect(names("claude", { name: "Read", input: { file_path: "skills/../SKILL.md" } }, claudeRead("不是技能\n"))).toEqual([]);
  });

  it("别家的行号前缀不去掉：claude 的返回里 `1: ---` 不算开头", () => {
    expect(names("claude", bash("x"), POTETO.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n"))).toEqual([]);
  });

  describe("PR #331 FAIL 评论里的命令：结论只看返回，不抛错", () => {
    const cases: [string, string, string[]][] = [
      ['H="abc def"; echo ${H%% *}; cat .agents/skills/poteto-mode/SKILL.md', `abc\n${POTETO}`, ["poteto-mode"]],
      ["echo ${FOO:-hello world}; echo ${}", "hello world\n", []],
      ["node - <<'EOF'\nconsole.log(`${encodeURIComponent(x)}`)\nEOF", "x\n", []],
      ["# 先读技能全文\ncat .agents/skills/poteto-mode/SKILL.md", POTETO, ["poteto-mode"]],
      ["/bin/zsh -lc '# check skill\ncat .agents/skills/poteto-mode/SKILL.md'", POTETO, ["poteto-mode"]],
      ['hub worker start --title "修界面" --stdin <<\'EOF\'\n开工先执行：\ncat .agents/skills/frontend-rules/SKILL.md\nEOF', "已派 Worker #12（修界面）\n", []],
      ["cd /repo/.agents/skills && cat poteto-mode/SKILL.md frontend-rules/SKILL.md; echo ----", `${POTETO}${FRONTEND}----\n`, ["poteto-mode", "frontend-rules"]],
      ["cd /repo/.agents/skills/poteto-mode && head -12 ../frontend-rules/SKILL.md", FRONTEND, ["frontend-rules"]],
      ["cd ~/.claude/skills/frontend-rules && wc -l *.md && cat SKILL.md", `  9 SKILL.md\n${FRONTEND}`, ["frontend-rules"]],
      ["(cd /tmp && ls); cat .agents/skills/poteto-mode/SKILL.md", `a.txt\nb.txt\n${POTETO}`, ["poteto-mode"]],
      ["cat .agents/skills/poteto-mode/\\\nSKILL.md", POTETO, ["poteto-mode"]],
      ["cat >| .agents/skills/poteto-mode/SKILL.md <<'EOF'\nx\nEOF", "", []],
      ["for f in $S/*/SKILL.md; do head -3 $f; done", `${POTETO.split("\n").slice(0, 3).join("\n")}\n${FRONTEND.split("\n").slice(0, 3).join("\n")}`, ["poteto-mode", "frontend-rules"]],
    ];
    for (const [command, output, expected] of cases) {
      it(command.split("\n")[0]!, () => {
        expect(names("claude", bash(command), output)).toEqual(expected);
        expect(names("codex", { name: "commandExecution", input: { command } }, output)).toEqual(expected);
      });
    }
  });
});

describe("agy 的 read_file：返回里没有正文，按路径参数认", () => {
  const read = (input: Record<string, unknown>, output = "14 lines, 310 bytes") => names("agy", { name: "read_file", input }, output);

  it("路径指的是名单里的文件才算；软链 .claude/skills 照常认", () => {
    expect(read({ Path: `${ROOT}/poteto-mode/SKILL.md` })).toEqual(["poteto-mode"]);
    expect(read({ Path: "/repo/.claude/skills/frontend-rules/SKILL.md" })).toEqual(["frontend-rules"]);
    expect(read({ Path: "/repo/skills/../SKILL.md" })).toEqual([]);
    expect(read({ Path: "/elsewhere/skills/poteto-mode/SKILL.md" })).toEqual([]);
  });

  it("读失败（返回不是“N lines, B bytes”）不算", () => {
    expect(read({ Path: `${ROOT}/poteto-mode/SKILL.md` }, "file does not exist")).toEqual([]);
    expect(read({ Path: `${ROOT}/poteto-mode/SKILL.md` }, "")).toEqual([]);
  });

  it("从头读才算：StartLine 不大于 1、ByteOffset 是 0；从中间读的不算", () => {
    expect(read({ Path: `${ROOT}/poteto-mode/SKILL.md`, StartLine: 1, EndLine: 160 })).toEqual(["poteto-mode"]);
    expect(read({ Path: `${ROOT}/poteto-mode/SKILL.md`, ByteOffset: 0 })).toEqual(["poteto-mode"]);
    expect(read({ Path: `${ROOT}/poteto-mode/SKILL.md`, StartLine: 50 })).toEqual([]);
    expect(read({ Path: `${ROOT}/poteto-mode/SKILL.md`, ByteOffset: 4096 })).toEqual([]);
  });

  it("参数不是字符串路径：不认，不抛错", () => {
    expect(read({ Path: 42 })).toEqual([]);
    expect(names("agy", { name: "read_file", input: null }, "1 lines, 1 bytes")).toEqual([]);
  });
});

describe("名单", () => {
  it("同一个开头出现在两个技能里（两处放了同一份）：按名单顺序认第一个", () => {
    const other = "/home/.agents/skills/poteto-mode/SKILL.md";
    const copy = { ...known("poteto-mode", POTETO), path: other, key: other, fileId: other };
    const twice = createSkillCatalog([SKILLS[0]!, copy], () => null);
    expect(skillsOfToolResult("claude", { name: "Bash", input: {} }, POTETO, twice).map((s) => s.path)).toEqual([SKILLS[0]!.path]);
    expect(twice.named("poteto-mode")?.path).toBe(SKILLS[0]!.path);
    expect(twice.byKey(copy.key)?.path).toBe(copy.path);
  });
});
