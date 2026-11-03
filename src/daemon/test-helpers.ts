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

export function groupContext(over: Partial<LaunchContext> = {}): LaunchContext {
  const foo = card(1, "foo", "/work/foo", ["/work/foo-docs"], "做一个记账小工具");
  return {
    sessionId: 7,
    role: "pm",
    conversation: { id: 3, kind: "project_group" },
    pm: { id: 1, name: "小林", mode: "manage_only", persona: "# 性格设定\n\n- 说话直接。\n" },
    managedProjects: [foo, card(2, "bar", "/work/bar")],
    project: foo,
    handoff: { id: 5, fromPmName: "阿周", text: "发布日期定在周五。还差登录页。", createdAt: 1_700_000_000_000 },
    ...over,
  };
}

export function privateContext(over: Partial<LaunchContext> = {}): LaunchContext {
  return {
    sessionId: 8,
    role: "pm",
    conversation: { id: 2, kind: "pm" },
    pm: { id: 1, name: "小林", mode: "hands_on", persona: PM_PERSONA_TEMPLATE },
    managedProjects: [card(1, "foo", "/work/foo", ["/work/foo-docs"], "做一个记账小工具"), card(2, "bar", "/work/bar")],
    project: null,
    handoff: null,
    ...over,
  };
}
