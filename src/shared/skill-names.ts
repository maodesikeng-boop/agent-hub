// 技能名和 SKILL.md 路径的认法：网页状态行（step-labels.ts）、任务图技能的隐藏判断（task-graph-skill.ts）、
// 换代时记下加载过的技能（skill-loads.ts）都用这一份。不 import 别的模块，hub 命令行、网页都能引。

/** 技能名是技能目录下的一段目录名：不是 `.`、`..`，不带路径分隔符。名字要拼进路径，别的都不认。 */
const SKILL_NAME_RE = /^(?!\.{1,2}$)[^\\/\0]+$/u;

/** 技能目录下的 `…/skills/<名字>/SKILL.md`（Agent Skills 的标准布局，六家都这样放）；别处叫 SKILL.md 的文件不算技能。 */
const SKILL_FILE_RE = /(?:^|[\\/])skills[\\/]([^\\/]+)[\\/]SKILL\.md$/iu;

/** 能当技能名：一段目录名。 */
export const isSkillName = (name: string): boolean => SKILL_NAME_RE.test(name);

const validName = (name: string | undefined): string | null => (name !== undefined && isSkillName(name) ? name : null);

/** 技能名：去掉命名空间（`fusa:fusa-task-graph`、pi 的 `skill:frontend-rules` 都取最后一段），名字本身照抄。 */
export function skillNameOf(raw: string | undefined): string | null {
  return validName(raw?.trim().split(":").findLast((part) => part.trim() !== "")?.trim());
}

/** 路径是技能目录下的 SKILL.md 就给技能名（目录名），否则 null。 */
export function skillNameOfFile(path: string): string | null {
  return validName(SKILL_FILE_RE.exec(path)?.[1]);
}
