// 产品自带技能的文件（docs/orchestration-skill-design.md 第 6.3、6.4 节）：守护进程在项目经理会话自己的启动目录里写唯一一份
// launch/<会话>/skills/fusa-task-graph/SKILL.md，六家都用它——有原生入口的驱动层把 skills/ 这个目录翻译成自己的参数
// （LaunchFiles.skillsDir），没有的（cursor）按提示词里的路径读。不写用户的技能目录（~/.claude/skills、~/.agents/skills……）和仓库。
// 正文在 shared/task-graph-skill.ts。Worker、总助的会话不写、不挂。
// 生命周期跟 prompt.md 一样：每次启动都调；内容没变就不动文件（inode、mtime 不变，agy 的硬链接和各家的缓存都还有效），
// 只有守护进程升级换了正文才重写；项目经理彻底删除时整个启动目录一起删（ledger/persona.ts 的 sessionLaunchDir）。
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { HUB_COMMAND } from "../shared/names.ts";
import { sessionLaunchDir } from "../shared/paths.ts";
import { TASK_GRAPH_SKILL_NAME, taskGraphSkillMarkdown } from "../shared/task-graph-skill.ts";

/** 启动目录里放产品技能的目录名（一个技能一个子目录，Agent Skills 的标准形状）。 */
export const PRODUCT_SKILLS_DIR = "skills";

/** 这个会话启动目录里的技能根目录。 */
export function productSkillsDir(sessionDir: string): string {
  return join(sessionDir, PRODUCT_SKILLS_DIR);
}

/** 任务图技能的 SKILL.md：提示词、hub graph create 回执、hub status、交接开场里写的都是这个路径。 */
export function taskGraphSkillFile(sessionDir: string): string {
  return join(productSkillsDir(sessionDir), TASK_GRAPH_SKILL_NAME, "SKILL.md");
}

/**
 * 写好这个会话的产品技能，返回技能根目录（交给驱动层的 LaunchFiles.skillsDir）。内容和现在的一样就不写。
 * 目录 0700、文件 0600（同 prompt.md）；原子替换：上一个进程可能正在读。
 */
export function writeProductSkills(sessionDir: string): string {
  const file = taskGraphSkillFile(sessionDir);
  const content = taskGraphSkillMarkdown();
  let current: string | null = null;
  try {
    current = readFileSync(file, "utf8");
  } catch {
    current = null;
  }
  if (current !== content) {
    mkdirSync(join(productSkillsDir(sessionDir), TASK_GRAPH_SKILL_NAME), { recursive: true, mode: 0o700 });
    writeFileAtomic.sync(file, content, { mode: 0o600 });
  }
  return productSkillsDir(sessionDir);
}

/**
 * 防漏读的第二、三道（docs/orchestration-skill-design.md 第 7 节）：hub graph create、hub graph patch 的回执（出错的也带）、
 * 有活跃图时的 hub status 和换新会话的开场说明，各带这一行手册路径。不判断加载过没有，每次都带；没加载就建图只提醒、不拦。
 * launchDir 没给（测试）只指 hub help graph。
 */
export function taskGraphManualNote(launchDir: string | undefined, sessionId: number): string {
  const where =
    launchDir === undefined
      ? `运行 \`${HUB_COMMAND} help graph\``
      : `\`${taskGraphSkillFile(sessionLaunchDir(launchDir, sessionId))}\`（也可以 \`${HUB_COMMAND} help graph\`）`;
  return `任务图手册（建图、改图、换人、审查的做法）：${where}`;
}

/** 不该有产品技能的会话（Worker、总助）：启动目录里万一有（老版本、角色对不上），删掉，免得哪家按目录扫到。 */
export function removeProductSkills(sessionDir: string): void {
  const dir = productSkillsDir(sessionDir);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
