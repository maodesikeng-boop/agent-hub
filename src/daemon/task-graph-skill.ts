import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { HUB_COMMAND } from "../shared/names.ts";
import { sessionLaunchDir } from "../shared/paths.ts";
import { TASK_GRAPH_MANUAL_SUMMARY, TASK_GRAPH_SKILL_NAME, taskGraphSkillMarkdown } from "../shared/task-graph-skill.ts";
import { writeFileAtomicSyncWithRetry } from "./platform/index.ts";

function joinSkillPath(base: string, ...parts: string[]): string {
  return /^[A-Za-z]:/.test(base) || base.startsWith("\\\\") || base.includes("\\")
    ? win32.join(base, ...parts)
    : posix.join(base, ...parts);
}

export const PRODUCT_SKILLS_DIR = "skills";

export function productSkillsDir(sessionDir: string): string {
  return joinSkillPath(sessionDir, PRODUCT_SKILLS_DIR);
}

export function taskGraphSkillFile(sessionDir: string): string {
  return joinSkillPath(productSkillsDir(sessionDir), TASK_GRAPH_SKILL_NAME, "SKILL.md");
}

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
    mkdirSync(joinSkillPath(productSkillsDir(sessionDir), TASK_GRAPH_SKILL_NAME), { recursive: true, mode: 0o700 });
    writeFileAtomicSyncWithRetry(file, content, { mode: 0o600 });
  }
  return productSkillsDir(sessionDir);
}

export function taskGraphManualNote(launchDir: string | undefined, sessionId: number): string {
  const where =
    launchDir === undefined
      ? `运行 \`${HUB_COMMAND} help graph\``
      : `\`${taskGraphSkillFile(sessionLaunchDir(launchDir, sessionId))}\`（也可以 \`${HUB_COMMAND} help graph\`）`;
  return `任务图手册（${TASK_GRAPH_MANUAL_SUMMARY}）：${where}`;
}

export function removeProductSkills(sessionDir: string): void {
  const dir = productSkillsDir(sessionDir);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
