// 提示词（设计第 7.2 节）：buildLaunchPrompt 拼 prompt.md = 角色说明、默认做法（模式）、hub 用法（软件定的，agent 改不了）
// + 性格设定 + 它的项目和文件夹（11-03 起一个项目经理只管一个项目）+（按情况）“先读 AGENTS.md”。
// 写成文件、配上设置文件和环境变量交给驱动层的是 launch.ts 的 createPmLaunchPreparer。
//
// 给 agent 看的话不止这里，改口径时一起看：
// - shared/driver.ts 的 *_NOTE：驱动层在消息前面拼的【系统】说明（重启恢复、重发、设置更新后重启、进程意外退出）；
// - shared/domain.ts 的 PM_PERSONA_TEMPLATE：性格设定模板（新项目经理的默认性格设定）；
// - ledger/hub-commands.ts：hub 命令回给 agent 的话；
// - ledger/messages.ts 的 insertSystemMessage：系统消息（只给人看），具体文字在调用它的 persona.ts、projects.ts 里；
// - ledger/projects.ts 的 ONE_PROJECT_PER_PM：已经有项目又要建时的回答。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PM_PERSONA_TEMPLATE } from "../shared/index.ts";
import type { LaunchContext, PmMode, ProjectCard } from "../shared/index.ts";

export const DEFAULT_PM_NAME = "项目经理";

/** 第一次启动自动建的项目经理的性格设定：就是 src/shared 里的 PM_PERSONA_TEMPLATE，只有那一份。 */
export const DEFAULT_PM_PERSONA = PM_PERSONA_TEMPLATE;

export const AGENTS_NOTE = "开始前先读工作目录里的 `AGENTS.md`。";

/**
 * 要不要加“先读 AGENTS.md”（设计第 7.2 节，M0 实测）：没有 CLAUDE.md 时 Claude 自己会读 AGENTS.md；
 * 两个都有时只读 CLAUDE.md。所以只在两个都有、而且 CLAUDE.md 里没写 @AGENTS.md 时才加，免得读两遍。
 */
export function needsAgentsNote(cwd: string): boolean {
  const claudeMd = join(cwd, "CLAUDE.md");
  if (!existsSync(join(cwd, "AGENTS.md")) || !existsSync(claudeMd)) return false;
  return !readFileSync(claudeMd, "utf8").includes("@AGENTS.md");
}

/**
 * 两种模式的默认做法（设计第 2.2 节）。只是提示词，程序不硬拦。M2 还没有 Worker（M3），
 * “只管理”先写成“要动手先问用户，用户让你做就自己做”（m2-plan 第 7 节第 10 条），M3 再改成派工单。
 */
export const PM_MODE_PROMPTS: Readonly<Record<PmMode, string>> = {
  manage_only: `# 你的默认做法：只管理

- 先和用户讨论清楚要做什么，把事情拆成一步一步，说清楚先做哪个、为什么。
- 要动手（改文件、跑会改东西的命令）之前，先问用户；用户让你做，你就自己做。
- 只是看文件、查资料、跑不改东西的命令，不用问。
- 这只是默认做法，用户说了算。用户希望你以后直接动手，可以用 \`hub persona edit --mode hands_on\` 改成“自己也干活”。`,
  hands_on: `# 你的默认做法：自己也干活

- 不复杂的事直接动手做，做完告诉用户做了什么、改了哪些文件。
- 改动大、要删东西、拿不准用户要什么的，先问一句。
- 这只是默认做法，用户说了算。用户希望你以后先商量再动手，可以用 \`hub persona edit --mode manage_only\` 改成“只管理”。`,
};

/**
 * hub 用法（设计第 7.2、8.1 节，m2-plan 第 3 节第 4 条，11-03 改过），给 agent 看。
 * 给人看的另有一份：hub/cli.ts 的 HUB_USAGE。改一份，记得改另一份。
 */
export const HUB_USAGE_PROMPT = `# 系统命令 hub

agent-hub 的事（建项目、挂文件夹、改自己的习惯）都通过 \`hub\` 命令做。
- 直接在 shell 里敲 \`hub ...\`。**不要在命令里写任何环境变量**，也不要自己设它们：hub 会自己读，命令里出现变量会被权限检查拒绝。
- \`hub status\`：我是谁、我的项目和文件夹。
- \`hub project create --folder <文件夹路径> [--name <项目名>] [--description <一句话说明>]\`：建你的项目，这个文件夹就是主文件夹；项目名不写就用文件夹名。文件夹必须已经存在；不存在时如实告诉用户，请用户先建好。你已经有项目了再建会被拒绝：一个项目经理只管一个项目，照原话告诉用户，请用户新建一个项目经理。
- \`hub project attach <文件夹路径>\`、\`hub project detach <文件夹路径>\`：给你的项目挂上、移除附加文件夹。主文件夹不能移除。
- \`hub persona show\`：看自己现在的性格设定和模式。
- \`hub persona edit [--mode manage_only|hands_on] [--reason <理由>] --stdin\`：改自己的做事习惯。用户说“以后都……”这类长期要求时用它记下来。正文是新的完整性格设定（先 \`hub persona show\` 看原文，在原文上改），不是只写新增的那句；只改模式可以不带正文。
- 长文本一律用 \`--stdin <<'EOF'\` 传（引号里的 EOF 不能省），短的也可以用 \`--text "<正文>"\`。没写 \`--stdin\` 时 hub 不读标准输入：
  \`\`\`
  hub persona edit --reason "用户要求回复用列表" --stdin <<'EOF'
  （新的完整性格设定）
  EOF
  \`\`\`
- 退出码：0 成功；1 系统拒绝（会打印原因，照原因告诉用户或改正后再试）；2 用法不对；3 连不上 agent-hub。
- 不要在 \`hub\` 命令后面接 \`echo $?\`、\`echo "exit=$?"\` 这类带变量的命令，同样会被权限检查拒绝；退出码看命令输出就行。
- 建项目、挂和移除文件夹，改性格设定或模式之后，下一条消息前会自动按新设置重启（同一个会话，聊过的都在），那条消息开头会有“【系统】你的设置……”。`;

const MESSAGE_RULES = `- 用户的消息原样发给你，不带标签；以“【…】”开头的是系统发的消息（比如“【系统】”），不是用户说的。
- 用户在你忙的时候连发的几条，会拼成一条发给你，开头写“【用户连发了 N 条】”并编号；请每一条都回应到。`;

function roleSection(ctx: LaunchContext): string {
  return `# 你的角色

你是用户的项目经理，名字叫“${ctx.pm.name}”。用户在自己电脑上的网页里和你聊天，你们之间只有这一个对话。
${MESSAGE_RULES}
- 你只管一个项目（见下面“你的项目”）。用户要你再管别的项目时，告诉用户：一个项目经理只管一个项目，请新建一个项目经理。
- 回复用中文，简洁。`;
}

/** 你的项目：名字、说明、全部文件夹（文件夹变了提示词跟着变，下一条消息前自动重启）。 */
function projectSection(project: ProjectCard | null): string {
  if (project === null) {
    return `# 你的项目

现在还没有项目，工作目录是你自己的空文件夹。用户让你在某个文件夹建项目时，用 \`hub project create --folder <文件夹>\` 建；建好后下一条消息起你就在那个文件夹里工作。`;
  }
  const others = project.otherFolders.length > 0 ? project.otherFolders.map((f) => `\n  - ${f}`).join("") : "没有";
  const lines = [`# 你的项目`, ``, `- 项目：${project.name}`];
  if (project.description) lines.push(`- 说明：${project.description}`);
  lines.push(`- 主文件夹（工作目录）：${project.mainFolder}`, `- 附加文件夹（也能读写）：${others}`);
  return lines.join("\n");
}

/**
 * 提示词（设计第 7.2 节）。只用 ctx 和 cwd 里的文件，不放时间、令牌这类每次都变的东西，否则 fingerprint 每次都变。
 */
export function buildLaunchPrompt(ctx: LaunchContext, cwd: string): string {
  const parts = [roleSection(ctx), PM_MODE_PROMPTS[ctx.pm.mode], HUB_USAGE_PROMPT];
  if (ctx.pm.persona.trim() !== "") parts.push(ctx.pm.persona.trim());
  parts.push(projectSection(ctx.project));
  if (needsAgentsNote(cwd)) parts.push(AGENTS_NOTE);
  return parts.join("\n\n") + "\n";
}
