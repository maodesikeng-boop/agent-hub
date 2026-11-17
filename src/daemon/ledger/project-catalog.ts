// 总助的项目目录在账本里的一半（docs/router-project-catalog-design.md 第 3.5、3.6 节）：存档案（project_catalogs）、算“变化大”、排队、拼写档输入。
// 跑腿的在 daemon/project-catalog/runner.ts，只干活不做判断。
// 不变量：
// - 队列是内存里的项目编号集合，只是缓存，真相在库里：启动时 scanAtStartup 重建，丢了也只是晚一点刷新。
// - 判断“变化大”只用 messages_conversation (conversation_id, id) 索引从切点往后走，不扫全表；队列空时一条 SQL 都不跑。
// - 切点只在写成时前移；失败、超时、重启都不动切点，下次从同一处接着算。
import type { DriverEvent } from "../../shared/driver.ts";
import type { AgentSessionRow, ProjectId } from "../../shared/domain.ts";
import type { LedgerProjectCatalogWork, ProjectCatalogCard, ProjectCatalogDetail } from "../../shared/project-catalog.ts";
import type { LedgerContext, Pending } from "./context.ts";
import type { LedgerProjects } from "./projects.ts";

/** 什么事件要求尽快刷新（不看增量字数，只受最短间隔约束）。 */
export type CatalogForceReason = "project_created" | "graph_finished" | "handover_switched";

export interface LedgerProjectCatalog extends LedgerProjectCatalogWork {
  /**
   * 守护进程启动时调一次：给每个活跃项目算一次是否到期，到期的进队列。
   * 后置：还没有档案的活跃项目（存量老项目、新项目）全部进队列；返回进队列的个数。
   */
  scanAtStartup(nowMs: number): number;
  /**
   * 在 applyDriverEvent 的事务里调。只看项目经理会话的 turn.ended：算这个项目切点之后的加权字数，到期就进队列。
   * 别的角色、别的事件什么都不做。
   */
  afterDriverEvent(p: Pending, session: AgentSessionRow, event: DriverEvent): void;
  /**
   * 在触发事件的同一个事务里调（建项目、hub graph finish、项目经理换代）：记 forced，到期就进队列。
   * 前置：projectId 是活跃项目；不是的静默忽略。
   */
  markForcedIn(p: Pending, projectId: ProjectId, reason: CatalogForceReason): void;
  /** 第一层：这个项目最近一次写成的档案摘要；还没写成过是 null。 */
  cardOf(projectId: ProjectId): ProjectCatalogCard | null;
  /** 第二层：完整档案；还没写成过、项目不存在或已归档是 null。 */
  detailOf(projectId: ProjectId): ProjectCatalogDetail | null;
  /** 队列里有没有项目（跑腿的决定要不要领活；热重启判空闲也看它）。 */
  hasQueued(): boolean;
}

export interface ProjectCatalogLedgerOptions {
  /** 有项目进队列了：守护进程接到跑腿的 wake；不给什么都不做。在事务提交之后调。 */
  onCatalogClaimable?: () => void;
}

export function createLedgerProjectCatalog(
  ctx: LedgerContext,
  projects: LedgerProjects,
  options: ProjectCatalogLedgerOptions,
): LedgerProjectCatalog {
  throw new Error("未实现");
}
