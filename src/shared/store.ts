// 驱动层 ↔ 存储：读写 agent_sessions 的一行（W1 实现，只有驱动层调用；W2 测试时用内存假实现）。
import type { AgentSessionRow, SessionId } from "./domain.ts";

/** 驱动层只改这些列。generation 不在里面：开新会话（第几代加一）是账本的事，M1 用不到。 */
/**
 * 驱动层能改的列。不含 model：那一列只表示配置的模型（账本和界面写，驱动层只读），
 * claude 实际报回来的模型只在 session.started 事件里。
 */
export type AgentSessionPatch = Partial<
  Pick<AgentSessionRow, "vendorSessionId" | "pid" | "status" | "hasCompletedTurn" | "lastEventAt" | "rateLimit" | "usage">
>;

export interface SessionStore {
  get(id: SessionId): AgentSessionRow | null;
  /** 改一行并返回改后的样子；同时更新 updatedAt。找不到抛错。 */
  update(id: SessionId, patch: AgentSessionPatch): AgentSessionRow;
  /** 记录里有进程号的会话（重启时找上次在跑的 claude 用）。 */
  listWithProcess(): AgentSessionRow[];
}
