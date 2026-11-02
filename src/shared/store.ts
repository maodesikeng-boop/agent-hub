// 驱动层 ↔ 存储：读写 agent_sessions 的一行（W1 实现，只有驱动层调用；W2 测试时用内存假实现）。
import type { AgentSessionRow, SessionId } from "./domain.ts";

/** 驱动层只改这些列。 */
export type AgentSessionPatch = Partial<
  Pick<AgentSessionRow, "pid" | "status" | "hasCompletedTurn" | "lastEventAt" | "rateLimit" | "model" | "generation">
>;

export interface SessionStore {
  get(id: SessionId): AgentSessionRow | null;
  /** 改一行并返回改后的样子；同时更新 updatedAt。找不到抛错。 */
  update(id: SessionId, patch: AgentSessionPatch): AgentSessionRow;
  /** 记录里有进程号的会话（重启时找上次在跑的 claude 用）。 */
  listWithProcess(): AgentSessionRow[];
}
