// 提示词和启动文件（设计第 7.2 节）：每次启动 claude 前生成 launch/<会话>/prompt.md 和空的 MCP 配置。
// prompt.md = 角色说明（软件定的，agent 改不了）+ 性格设定 +（按情况）“先读 AGENTS.md”。M1 不写 hub 用法。
// 不生成 --settings 文件：M1 没有权限钩子，用户全局 ~/.claude 的设置照常生效（m1-plan 第 6 节第 1 条）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PM_PERSONA_TEMPLATE } from "../shared/index.ts";
import type { AgentSessionRow, LaunchFiles } from "../shared/index.ts";
import { personaFilePath } from "../shared/paths.ts";
import type { Db } from "./store/index.ts";

export const DEFAULT_PM_NAME = "项目经理";

/** 第一次启动自动建的项目经理的性格设定：就是 src/shared 里的 PM_PERSONA_TEMPLATE，只有那一份。 */
export const DEFAULT_PM_PERSONA = PM_PERSONA_TEMPLATE;

export const PM_ROLE_PROMPT = `# 你的角色

你是用户的项目经理，用户在自己电脑上的网页里和你聊天。
- 用户的消息原样发给你，不带标签；以“【…】”开头的是系统发的消息（比如“【系统】”），不是用户说的。
- 用户在你忙的时候连发的几条，会拼成一条发给你，开头写“【用户连发了 N 条】”并编号；请每一条都回应到。
- 现在是你和用户的私聊，工作目录是你自己的空文件夹，不在任何项目里。
- 回复用中文，简洁。`;

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

export function buildPmPrompt(input: { persona: string; cwd: string }): string {
  const parts = [PM_ROLE_PROMPT, input.persona.trim()];
  if (needsAgentsNote(input.cwd)) parts.push(AGENTS_NOTE);
  return parts.join("\n\n") + "\n";
}

/** 写默认性格设定；文件已经有了就不动（用户可能改过）。 */
export function writeDefaultPersona(personasDir: string, pmId: number): string {
  const file = personaFilePath(personasDir, pmId);
  mkdirSync(personasDir, { recursive: true, mode: 0o700 });
  if (!existsSync(file)) writeFileSync(file, DEFAULT_PM_PERSONA, { mode: 0o600 });
  return file;
}

export interface LaunchPreparerOptions {
  db: Db;
  launchDir: string;
  personasDir: string;
}

/**
 * 给驱动层的 prepareLaunch。性格设定的位置：pms.persona_file，没有就 personas/pm-<编号>.md，
 * 都没有就用默认的。只读库，不写业务表。
 */
export function createLaunchPreparer(options: LaunchPreparerOptions): (session: AgentSessionRow) => Promise<LaunchFiles> {
  const { db, launchDir, personasDir } = options;
  const readPersona = (session: AgentSessionRow): string => {
    if (session.conversationId === null) return DEFAULT_PM_PERSONA;
    const pm = db.get<{ id: number; persona_file: string | null }>(
      "SELECT p.id, p.persona_file FROM conversations c JOIN pms p ON p.id = c.pm_id WHERE c.id = ?",
      session.conversationId,
    );
    if (pm === undefined) return DEFAULT_PM_PERSONA;
    const file = pm.persona_file ?? personaFilePath(personasDir, pm.id);
    return existsSync(file) ? readFileSync(file, "utf8") : DEFAULT_PM_PERSONA;
  };
  return async (session) => {
    const dir = join(launchDir, String(session.id));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const promptFile = join(dir, "prompt.md");
    const mcpConfigFile = join(dir, "mcp.json");
    writeFileSync(promptFile, buildPmPrompt({ persona: readPersona(session), cwd: session.cwd }));
    writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: {} }) + "\n");
    // M2 W0 占位：每次启动的环境变量和指纹由 M2 W3、W6 填；指纹不变 = 和 M1 一样不在两轮之间重启
    return { promptFile, mcpConfigFile, env: {}, fingerprint: "" };
  };
}
