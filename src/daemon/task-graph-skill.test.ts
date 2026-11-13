// 任务图技能 fusa-task-graph（docs/orchestration-skill-design.md 第 5、6、9.4 节）的守卫：
// - 正文：从基础提示词搬过来的建图规矩一条不少，全部 hub graph 命令和 JSON 契约都在；大小、说明长度有上限；
// - 一份文件覆盖六家：各家驱动挂上的都是守护进程写的那一个 SKILL.md（claude 软链、agy 硬链接、codex/pi/deepseek 直接指目录），
//   cursor 没有原生入口只读文件；只挂给项目经理；
// - hub help graph 打印同一份正文；回执、hub status、交接开场那一行手册路径。
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HUB_COMMAND_SPECS, runHub } from "../hub/cli.ts";
import {
  AGENT_VENDORS,
  HUB_COMMANDS,
  isInternalSkillCommand,
  PM_REVIEW_REDLINES,
  PM_REVIEW_REDLINES_BRIEF,
  TASK_GRAPH_CREATE_JSON_HINT,
  TASK_GRAPH_PATCH_JSON_HINT,
  TASK_GRAPH_SKILL_DESCRIPTION,
  TASK_GRAPH_SKILL_DESCRIPTION_MAX_CHARS,
  TASK_GRAPH_SKILL_MAX_BYTES,
  TAKEOVER_PREDECESSORS_MAX,
  TASK_GRAPH_SKILL_NAME,
  taskGraphSkillBody,
  taskGraphSkillMarkdown,
  vendorSpec,
  type AgentSessionRow,
  type LaunchFiles,
} from "../shared/index.ts";
import { HUB_COMMAND } from "../shared/names.ts";
import { sessionLaunchDir } from "../shared/paths.ts";
import { buildAgyArgs } from "../vendors/agy/protocol.ts";
import { writeAgyPromptRules } from "../vendors/agy/rules.ts";
import { buildClaudeArgs } from "../vendors/claude/protocol.ts";
import { claudePluginDirOf, ensureClaudeSkillPlugin } from "../vendors/claude/skills.ts";
import { buildSkillsExtraRootsRequest, readCodexLaunchConfig } from "../vendors/codex/protocol.ts";
import { buildDeepSeekSkillsPatch } from "../vendors/deepseek/driver.ts";
import { buildPiArgs } from "../vendors/pi/protocol.ts";
import { removeProductSkills, taskGraphManualNote, taskGraphSkillFile, writeProductSkills } from "./task-graph-skill.ts";

const hub = HUB_COMMAND;

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-hub-skill-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const row = (cwd: string): AgentSessionRow => ({
  id: 7,
  role: "pm",
  conversationId: 7,
  pmId: 1,
  workerId: null,
  vendor: "claude",
  vendorSessionId: "v-7",
  cwd,
  addDirs: [],
  generation: 1,
  model: null,
  effort: null,
  pid: null,
  status: "idle",
  hasCompletedTurn: false,
  lastEventAt: null,
  rateLimit: null,
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, context: 0 },
  createdAt: 0,
  updatedAt: 0,
});

describe("任务图技能正文", () => {
  it("建图规矩匹配第 5 步自动开工与交棒终稿：goal + steps、一图一事、按步骤拆、默认一条线共用 worktree、多路合流落盘 upstream/、用户检查点、四条红线加 review 步骤", () => {
    const body = taskGraphSkillBody();
    // 编排简化第 4 步：节点类型只剩一种、状态只剩四个，手册里不再出现 gate 节点、kind 和旧状态
    expect(taskGraphSkillMarkdown()).not.toMatch(/\bgate\b|\bkind\b|\bready\b|attention|waiting_user|门禁/u);
    for (const word of [
      "一件事有两段以上、每段各要一个独立会话时才建图。一段就能做完的活不建图，直接派一个 Worker。",
      `用 \`${hub} graph create\` 一次写下整张图的 \`goal\`（总目标）和 \`steps\`（步骤数组），带 \`brief\` 的就绪步骤建好即自动开工。`,
      "**总目标（`goal`）要写全**",
      "**一张图只装一件事**：互不相干的几件事各建一张图。",
      "**按先后步骤拆，不按模块拆**：不要把一个需求切成前端、后端各一个 Worker。",
      "写测试、改代码、截图、提 PR 是同一步，一个 Worker 一口气做完。",
      "只在三种时候另起一步：用户明说要先看、要换一个模型独立审查、一步的上下文装不下。",
      "**默认一条线，同线共用工作目录和分支**：`steps` 里不写 `deps` 默认按书写顺序串成一条线",
      "同一个 git worktree 和同一条分支",
      "`upstream/<stepKey>.md`",
      "`vendor`、`model`、`effort`、`readonly`、`maxTime`",
      "`review: true`、`base: \"main\"`",
      "**用户明说要先看的地方**（比如“先给我看方案”）单独加一步（不写 `brief`），带上 `question`、`options` 和你的推荐 `recommended`",
      "步骤只有四个状态：没轮到（`pending`）、在干（`running`）、等人（`waiting`，等你处理或等用户拍板）、完了（`done`，跳过也算完了）。",
      `别的拍板不预先挂卡，撞上了用 \`${hub} ask\` 问。`,
      "**碰到下面任意一条，就在实现后面加一个审查步骤**（设 `\"review\": true` 并指定另一家 `vendor`",
      ...PM_REVIEW_REDLINES.map((line) => `  - ${line}`),
      "纯文案、纯展示、局部纯函数、薄胶水层不用审查，靠测试和截图兜底。",
    ]) {
      expect(body, word).toContain(word);
    }
    // 基础提示词里那句压缩版和这里的四条说的是同一回事
    expect(PM_REVIEW_REDLINES).toHaveLength(4);
    expect(PM_REVIEW_REDLINES_BRIEF.split("；")).toHaveLength(4);
  });

  it("图里怎么跟进：顺利完成自动收工交棒不叫醒 PM、报偏离或异常停在 waiting、换人一条 --node 命令、计划变了 patch（addSteps/updateSteps/removeSteps/skipSteps）、待交付发交付单并用 finish 结束", () => {
    const body = taskGraphSkillBody();
    for (const word of [
      `进度以 \`${hub} graph show\` 为准。`,
      "**顺利完成自动收工交棒，不叫醒你**",
      "**报“偏离”或异常停在 `waiting` 等你处理**",
      `${hub} worker send <编号> --stdin`,
      `${hub} graph done <步骤> [--stdin]`,
      `**换人接手**（出错、额度用完、对话太长、厂商不可用或该换一家）：直接 \`${hub} worker start --node <步骤> [--vendor …] [--model …] [--effort …] [--stdin]\``,
      "还挂着的旧 Worker 自动收工且步骤不标完成",
      "前任的工作目录与分支",
      `最近 ${TAKEOVER_PREDECESSORS_MAX} 个前任的汇报、最后的文字、最后几步操作和原始记录路径`,
      "**计划变了**：随时 `" + `${hub} graph patch` + "`（用 `addSteps`、`updateSteps`、`removeSteps`、`skipSteps` 或更新 `goal`",
      "原本没建图、做着发现要分段或加审查的，随时补建一张图。",
      "**全部步骤完成后待交付**：最后一步完成时图不会自动结束，你会收到交付单",
      `用 \`${hub} graph finish\` 收尾（交付摘要自动同步给总助）。`,
    ]) {
      expect(body, word).toContain(word);
    }
    expect(body).not.toContain("所有节点都完成后整张图自动结束，不能再改");
    expect(body).not.toContain("--incomplete");
    expect(body).not.toContain(`${hub} ask --node`);
    // 规矩在命令前面（claude 压缩后只重新挂每个技能的前 5,000 个 token）
    expect(body.indexOf("## 建图")).toBeLessThan(body.indexOf("## 跟进"));
    expect(body.indexOf("## 跟进")).toBeLessThan(body.indexOf("## 命令"));
  });

  it("命令：每个 hub graph 子命令都有（按 HUB_COMMANDS 查，加命令漏写会红），JSON 契约同 hub help，--node、--graph 与 worker end 无 --incomplete 写清", () => {
    const body = taskGraphSkillBody();
    const commands = body.slice(body.indexOf("## 命令"));
    for (const command of HUB_COMMANDS.filter((c) => c.startsWith("graph."))) {
      expect(commands, command).toContain(`\`${hub} ${command.replace(".", " ")}`);
    }
    for (const spec of HUB_COMMAND_SPECS.filter((s) => s.group === "graph")) expect(commands, spec.cli).toContain(`${hub} ${spec.cli}`);
    expect(commands).toContain(TASK_GRAPH_CREATE_JSON_HINT);
    expect(commands).toContain(TASK_GRAPH_PATCH_JSON_HINT);
    expect(commands).toContain("`<步骤>` 是步骤的 key，它在几张活跃的图里重名时加 `--graph <图编号>`。");
    expect(commands).toContain(`\`${hub} worker start --node <步骤> …\`：给等你处理的步骤换人或手动派人`);
    expect(commands).toContain(`\`${hub} worker end <编号>\`：只停掉这个 Worker，不会把步骤标完成；未完成的步骤会停在 \`waiting\` 等你处理`);
    expect(commands).toContain("自动停掉图里所有在跑的 Worker");
    expect(commands).not.toContain("--incomplete");
  });

  it("SKILL.md：Agent Skills 的 frontmatter（name 和目录名一致、description 先说什么时候加载再说什么时候不用）；全文、说明都在上限内", () => {
    const md = taskGraphSkillMarkdown();
    const frontmatter = /^---\nname: (.+)\ndescription: (.+)\n---\n\n/.exec(md);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter![1]).toBe(TASK_GRAPH_SKILL_NAME);
    expect(frontmatter![2]).toBe(TASK_GRAPH_SKILL_DESCRIPTION);
    expect(md.slice(frontmatter![0].length)).toBe(taskGraphSkillBody());
    // 名字不叫 orchestration：本机已有别家的同名技能
    expect(TASK_GRAPH_SKILL_NAME).toBe("fusa-task-graph");
    expect(TASK_GRAPH_SKILL_NAME).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(TASK_GRAPH_SKILL_DESCRIPTION.indexOf("先加载")).toBeLessThan(TASK_GRAPH_SKILL_DESCRIPTION.indexOf("不用加载"));
    expect(TASK_GRAPH_SKILL_DESCRIPTION).not.toContain("\n");
    expect([...TASK_GRAPH_SKILL_DESCRIPTION].length).toBeLessThanOrEqual(TASK_GRAPH_SKILL_DESCRIPTION_MAX_CHARS);
    expect(Buffer.byteLength(md, "utf8")).toBeLessThanOrEqual(TASK_GRAPH_SKILL_MAX_BYTES);
    // 内容只随版本变：不带时间、会话号、路径（各会话、各次启动逐字节一样，缓存稳定）
    expect(taskGraphSkillMarkdown()).toBe(md);
    expect(md).not.toMatch(/\/Users\/|\/launch\/|\d{4}-\d{2}-\d{2}/);
    // 网页 `/` 菜单隐藏三种命令名形式，不误伤普通技能
    expect(isInternalSkillCommand("fusa-task-graph")).toBe(true);
    expect(isInternalSkillCommand("fusa:fusa-task-graph")).toBe(true);
    expect(isInternalSkillCommand("skill:fusa-task-graph")).toBe(true);
    expect(isInternalSkillCommand("/fusa:fusa-task-graph")).toBe(true);
    expect(isInternalSkillCommand("fusa-other")).toBe(false);
    expect(isInternalSkillCommand("skill:review")).toBe(false);
  });

  it("hub help graph 打印同一份正文（读不到文件时的入口）；hub help 里列了这一条", async () => {
    let out = "";
    const io = { argv: ["help", "graph"], env: {}, cwd: "/", stdout: { write: (s: string) => ((out += s), true) }, stderr: { write: () => true }, stdin: process.stdin };
    expect(await runHub(io as never)).toBe(0);
    expect(out).toBe(taskGraphSkillBody());
  });
});

describe("技能文件：只在项目经理的启动目录里写一份", () => {
  it("writeProductSkills 写 <启动目录>/skills/fusa-task-graph/SKILL.md，返回 skills/；只动启动目录", () => {
    const sessionDir = sessionLaunchDir(join(dir, "launch"), 7);
    const skillsDir = writeProductSkills(sessionDir);
    expect(skillsDir).toBe(join(sessionDir, "skills"));
    expect(readFileSync(taskGraphSkillFile(sessionDir), "utf8")).toBe(taskGraphSkillMarkdown());
    expect(statSync(taskGraphSkillFile(sessionDir)).mode & 0o777).toBe(0o600);
    removeProductSkills(sessionDir);
    expect(() => statSync(skillsDir)).toThrow();
  });

  it("手册那一行（graph create/patch 回执、hub status、交接开场）：有启动目录写这个会话的绝对路径，没有只指 hub help graph", () => {
    const launchDir = join(dir, "launch");
    expect(taskGraphManualNote(launchDir, 12)).toBe(
      `任务图手册（建图、改图、换人、审查的做法）：\`${taskGraphSkillFile(sessionLaunchDir(launchDir, 12))}\`（也可以 \`${hub} help graph\`）`,
    );
    expect(taskGraphManualNote(undefined, 12)).toBe(`任务图手册（建图、改图、换人、审查的做法）：运行 \`${hub} help graph\``);
  });
});

describe("六家怎么挂（spec 的 capabilities.skills）：挂上的都是同一个文件", () => {
  const prepare = () => {
    const sessionDir = sessionLaunchDir(join(dir, "launch"), 7);
    const skillsDir = writeProductSkills(sessionDir);
    const promptFile = join(sessionDir, "prompt.md");
    writeFileSync(promptFile, "你是项目经理。");
    const files: LaunchFiles = { promptFile, skillsDir, env: {}, fingerprint: "fp" };
    return { sessionDir, skillsDir, promptFile, files, real: taskGraphSkillFile(sessionDir) };
  };

  it("五家有原生入口，cursor 只读文件（2026-11-12 本机实测，见 docs/orchestration-skill-design.md 附 B）", () => {
    expect(Object.fromEntries(AGENT_VENDORS.map((v) => [v, vendorSpec(v).capabilities.skills]))).toEqual({
      claude: "native",
      agy: "native",
      codex: "native",
      pi: "native",
      deepseek: "native",
      cursor: "read_file",
    });
    expect(vendorSpec("claude").prompt.skillNamePrefix).toBe("fusa:");
  });

  it("claude：--plugin-dir <启动目录>/claude-plugin，插件里的 skills 是指向 ../skills 的软链；没有 skillsDir（Worker）不带", () => {
    const { skillsDir, files, real } = prepare();
    const pluginDir = ensureClaudeSkillPlugin(skillsDir);
    expect(pluginDir).toBe(claudePluginDirOf(skillsDir));
    expect(JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"))).toMatchObject({ name: "fusa" });
    expect(lstatSync(join(pluginDir, "skills")).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(pluginDir, "skills", TASK_GRAPH_SKILL_NAME, "SKILL.md"))).toBe(realpathSync(real));
    // 再调一次不出错、不变
    expect(ensureClaudeSkillPlugin(skillsDir)).toBe(pluginDir);
    const args = buildClaudeArgs(row(dir), files, false);
    expect(args[args.indexOf("--plugin-dir") + 1]).toBe(pluginDir);
    const { skillsDir: _omit, ...workerFiles } = files;
    expect(buildClaudeArgs(row(dir), workerFiles, false)).not.toContain("--plugin-dir");
  });

  it("codex：握手后 skills/extraRoots/set 这一个目录（驱动层握手顺序见 codex/driver.test.ts）", () => {
    const { skillsDir, files } = prepare();
    expect(readCodexLaunchConfig(files).skillRoots).toEqual([skillsDir]);
    expect(JSON.parse(buildSkillsExtraRootsRequest(3, [skillsDir]))).toEqual({ jsonrpc: "2.0", id: 3, method: "skills/extraRoots/set", params: { extraRoots: [skillsDir] } });
    const { skillsDir: _omit, ...workerFiles } = files;
    expect(readCodexLaunchConfig(workerFiles).skillRoots).toEqual([]);
  });

  it("agy：放进已经 --add-dir 的规则目录 agy-rules/.agents/skills/（硬链接，同一个 inode；agy 不跟软链），不多加参数", () => {
    const { skillsDir, promptFile, files, real } = prepare();
    const workspace = writeAgyPromptRules(promptFile, skillsDir)!;
    const linked = join(workspace, ".agents", "skills", TASK_GRAPH_SKILL_NAME, "SKILL.md");
    expect(lstatSync(linked).isSymbolicLink()).toBe(false);
    expect(statSync(linked).ino).toBe(statSync(real).ino);
    const args = buildAgyArgs(row(dir), files, false, undefined, workspace);
    expect(args.filter((a) => a === "--add-dir")).toHaveLength(1);
    expect(args[args.indexOf("--add-dir") + 1]).toBe(workspace);
    // 守护进程升级换了正文（原子替换成新 inode）：下次起进程重新链上
    rmSync(real);
    writeFileSync(real, "新正文");
    writeAgyPromptRules(promptFile, skillsDir);
    expect(readFileSync(linked, "utf8")).toBe("新正文");
    expect(statSync(linked).ino).toBe(statSync(real).ino);
    // 没有 skillsDir（Worker）：规则目录里不留技能
    writeAgyPromptRules(promptFile);
    expect(() => statSync(join(workspace, ".agents", "skills", TASK_GRAPH_SKILL_NAME))).toThrow();
  });

  it("agy：规则目录里同名位置被别的文件占着（不同 inode）：换成链到守护进程写的那份", () => {
    const { skillsDir, promptFile } = prepare();
    const workspace = writeAgyPromptRules(promptFile, skillsDir)!;
    const linked = join(workspace, ".agents", "skills", TASK_GRAPH_SKILL_NAME, "SKILL.md");
    rmSync(linked);
    mkdirSync(join(dir, "other"), { recursive: true });
    writeFileSync(join(dir, "other", "x"), "x");
    linkSync(join(dir, "other", "x"), linked);
    writeAgyPromptRules(promptFile, skillsDir);
    expect(readFileSync(linked, "utf8")).toBe(taskGraphSkillMarkdown());
  });

  it("pi：--skill <启动目录>/skills；deepseek：--patch 给 skill-filesystem 设 customSkillDirs（驱动层见 deepseek.test.ts）", () => {
    const { skillsDir, files } = prepare();
    const piArgs = buildPiArgs({ row: { cwd: dir, addDirs: [], model: null, effort: null }, files, sessionId: "s1" });
    expect(piArgs.join(" ")).toContain(`--skill ${skillsDir}`);
    const { skillsDir: _omit, ...workerFiles } = files;
    expect(buildPiArgs({ row: { cwd: dir, addDirs: [], model: null, effort: null }, files: workerFiles, sessionId: "s1" })).not.toContain(skillsDir);
    expect(buildDeepSeekSkillsPatch(skillsDir)).toEqual([{ id: "skill-filesystem", config: { customSkillDirs: [skillsDir] } }]);
  });
});
