// 提示词、启动文件测试共用的启动上下文（prompt.test.ts、launch.test.ts）。
import { PM_PERSONA_TEMPLATE } from "../shared/index.ts";
import type { LaunchContext, ProjectCard } from "../shared/index.ts";

export const card = (id: number, name: string, mainFolder: string, otherFolders: string[] = [], description: string | null = null): ProjectCard => ({
  id,
  name,
  description,
  mainFolder,
  otherFolders,
});

/** 有项目的项目经理：manage_only，项目 foo（主文件夹 /work/foo，附加 /work/foo-docs）。 */
export function projectContext(over: Partial<LaunchContext> = {}): LaunchContext {
  return {
    sessionId: 7,
    role: "pm",
    conversationId: 3,
    pm: { id: 1, name: "小林", mode: "manage_only", persona: "# 性格设定\n\n- 说话直接。\n" },
    project: card(1, "foo", "/work/foo", ["/work/foo-docs"], "做一个记账小工具"),
    worker: null,
    ...over,
  };
}

/** 还没有项目的项目经理：hands_on。 */
export function noProjectContext(over: Partial<LaunchContext> = {}): LaunchContext {
  return {
    sessionId: 8,
    role: "pm",
    conversationId: 2,
    pm: { id: 2, name: "阿周", mode: "hands_on", persona: PM_PERSONA_TEMPLATE },
    project: null,
    worker: null,
    ...over,
  };
}
