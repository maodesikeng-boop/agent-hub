// 启动 claude 前给提示词用的上下文（getLaunchContext）：这个会话是哪个项目经理的、它的项目和文件夹；Worker 的会话见 workers.ts。
import type { PmMode, SessionId } from "../../shared/domain.ts";
import type { LaunchContext } from "../../shared/ledger.ts";
import type { AgentVendor } from "../../shared/vendors.ts";
import { getAgentSession } from "../store/index.ts";
import type { Db } from "../store/index.ts";
import { fail } from "./context.ts";
import type { LedgerPersona } from "./persona.ts";
import type { LedgerProjects } from "./projects.ts";
import type { LedgerWorkers } from "./workers.ts";

export function createLedgerLaunchContext(db: Db, persona: LedgerPersona, projects: LedgerProjects, workers: LedgerWorkers) {
  const { pmRow, pmSession, personaRevision } = persona;
  const { activeProjectOf, projectCard } = projects;

  const getLaunchContext = (sessionId: SessionId): LaunchContext => {
    const row = getAgentSession(db, sessionId);
    const worker = row === null ? null : workers.launchContextFor(row);
    if (worker !== null) return worker;
    const session = pmSession(sessionId);
    if (session === null || session.conversationId === null) throw fail("not_found", `会话 ${sessionId} 不存在，或不是项目经理、Worker 的会话`);
    const pm = pmRow(session.pmId)!;
    const project = activeProjectOf(pm.id);
    return {
      sessionId,
      role: session.role,
      conversationId: session.conversationId,
      pm: { id: pm.id, name: pm.name, mode: pm.mode as PmMode, vendor: pm.vendor as AgentVendor, persona: pm.persona ?? "", personaRevision: personaRevision(pm.id) },
      project: project === null ? null : projectCard(project),
      worker: null,
    };
  };

  return { getLaunchContext };
}
