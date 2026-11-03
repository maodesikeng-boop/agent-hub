// 启动 claude 前给提示词用的上下文（getLaunchContext）：这个会话是哪个项目经理的、它的项目和文件夹。
import { personaOrTemplate } from "../../shared/domain.ts";
import type { PmMode, SessionId } from "../../shared/domain.ts";
import type { LaunchContext } from "../../shared/ledger.ts";
import { fail } from "./context.ts";
import type { LedgerPersona } from "./persona.ts";
import type { LedgerProjects } from "./projects.ts";

export function createLedgerLaunchContext(persona: LedgerPersona, projects: LedgerProjects) {
  const { pmRow, pmSession } = persona;
  const { activeProjectOf, projectCard } = projects;

  const getLaunchContext = (sessionId: SessionId): LaunchContext => {
    const session = pmSession(sessionId);
    if (session === null || session.conversationId === null) throw fail("not_found", `会话 ${sessionId} 不存在或不是项目经理的会话`);
    const pm = pmRow(session.pmId)!;
    const project = activeProjectOf(pm.id);
    return {
      sessionId,
      role: session.role,
      conversationId: session.conversationId,
      pm: { id: pm.id, name: pm.name, mode: pm.mode as PmMode, persona: personaOrTemplate(pm.persona) },
      project: project === null ? null : projectCard(project),
      // M3 W0 的占位：Worker 的会话 W2 实现
      ticket: null,
    };
  };

  return { getLaunchContext };
}
