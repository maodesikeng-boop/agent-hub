import type { AgentSessionRow, SessionId } from "./domain.ts";

export type AgentSessionPatch = Partial<
  Pick<AgentSessionRow, "vendorSessionId" | "pid" | "status" | "hasCompletedTurn" | "lastEventAt" | "rateLimit" | "usage" | "personaRevision">
>;

export interface SessionStore {
  get(id: SessionId): AgentSessionRow | null;
  update(id: SessionId, patch: AgentSessionPatch): AgentSessionRow;
  listWithProcess(): AgentSessionRow[];
}
