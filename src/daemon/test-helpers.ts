// 提示词、启动文件测试共用的启动上下文（prompt.test.ts、launch.test.ts）：项目经理两种，Worker 一种（M3）。
import { PM_PERSONA_TEMPLATE } from "../shared/index.ts";
import type { LaunchContext, ProjectCard, WorkerRecord } from "../shared/index.ts";

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

/** Worker（M3）的记录：项目 foo 的 Worker #5，在 worktree 里干活。 */
export function workerRecord(over: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    id: 5,
    projectId: 1,
    pmId: 1,
    pmConversationId: 3,
    workerConversationId: 11,
    title: "修登录按钮",
    task: "登录按钮点了没反应，查原因并修好。验收：pnpm test 全绿。",
    model: null,
    readonly: false,
    workspace: "worktree",
    branch: "hub/5-修登录按钮",
    worktreePath: "/data/worktrees/1/5",
    baseCommit: "abc1234",
    status: "open",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** Worker 的会话：派它的是 projectContext 里的项目经理小林，项目 foo。 */
export function workerContext(over: Partial<WorkerRecord> = {}): LaunchContext {
  return {
    sessionId: 9,
    role: "worker",
    conversationId: 11,
    pm: { id: 1, name: "小林", mode: "manage_only", persona: "# 性格设定\n\n- 说话直接。\n" },
    project: card(1, "foo", "/work/foo", ["/work/foo-docs"], "做一个记账小工具"),
    worker: workerRecord(over),
  };
}
