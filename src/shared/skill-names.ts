// 技能名和 SKILL.md 路径的认法：网页状态行（step-labels.ts）、任务图技能的隐藏判断（task-graph-skill.ts）、
// 换代时记下加载过的技能（skill-loads.ts）都用这一份。不 import 别的模块，hub 命令行、网页都能引。

/** 技能目录下的 `…/skills/<名字>/SKILL.md`（Agent Skills 的标准布局，六家都这样放）；别处叫 SKILL.md 的文件不算技能。 */
const SKILL_FILE_RE = /(?:^|[\\/])skills[\\/]([^\\/]+)[\\/]SKILL\.md$/i;

/** 技能名：去掉命名空间（`fusa:fusa-task-graph`、pi 的 `skill:frontend-rules` 都取最后一段），名字本身照抄。 */
export function skillNameOf(raw: string | undefined): string | null {
  const name = raw?.trim().split(":").findLast((part) => part.trim() !== "")?.trim();
  return name === undefined || name === "" ? null : name;
}

/** 路径是技能目录下的 SKILL.md 就给技能名（目录名），否则 null。 */
export function skillNameOfFile(path: string): string | null {
  return SKILL_FILE_RE.exec(path)?.[1] ?? null;
}
