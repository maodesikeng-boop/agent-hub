// 启动 claude 前给提示词用的上下文（getLaunchContext）：这个会话是谁、在哪个对话、管哪些项目、群的项目和最近一份交接。
import { readFileSync } from "node:fs";
import { personaOrTemplate } from "../../shared/domain.ts";
import type { PmMode, SessionId } from "../../shared/domain.ts";
import type { LaunchContext } from "../../shared/ledger.ts";
import { fail } from "./context.ts";
import type { LedgerContext } from "./context.ts";
import type { LedgerPersona } from "./persona.ts";
import type { LedgerProjects } from "./projects.ts";
import { toConversation } from "./rows.ts";
import type { ConversationDbRow, HandoffDbRow } from "./rows.ts";


export function createLedgerLaunchContext(ctx: LedgerContext, persona: LedgerPersona, projects: LedgerProjects) {
  const { db } = ctx;
  const { pmRow, pmSession } = persona;
  const { projectRow, managedProjects, projectCard } = projects;

  const getLaunchContext = (sessionId: SessionId): LaunchContext => {
    const session = pmSession(sessionId);
    const conversation =
      session?.conversationId == null ? undefined : db.get<ConversationDbRow>("SELECT * FROM conversations WHERE id = ?", session.conversationId);
    if (session === null || conversation === undefined) throw fail("not_found", `会话 ${sessionId} 不存在或不是项目经理的会话`);
    const pm = pmRow(session.pmId)!;
    const projectDb = conversation.kind === "project_group" && conversation.project_id !== null ? projectRow(conversation.project_id) : null;
    let handoff: LaunchContext["handoff"] = null;
    if (projectDb !== null) {
      const row = db.get<HandoffDbRow & { from_pm_name: string }>(
        `SELECT h.*, p.name AS from_pm_name FROM handoffs h JOIN pms p ON p.id = h.from_pm_id
         WHERE h.project_id = ? ORDER BY h.id DESC LIMIT 1`,
        projectDb.id,
      );
      if (row !== undefined) {
        let text: string;
        try {
          text = readFileSync(row.file, "utf8");
        } catch {
          text = `（交接文件读不了：${row.file}）`;
        }
        handoff = { id: row.id, fromPmName: row.from_pm_name, text, createdAt: row.created_at };
      }
    }
    return {
      sessionId,
      role: session.role,
      conversation: { id: conversation.id, kind: toConversation(conversation).kind },
      pm: { id: pm.id, name: pm.name, mode: pm.mode as PmMode, persona: personaOrTemplate(pm.persona) },
      managedProjects: managedProjects(pm.id).map(projectCard),
      project: projectDb === null ? null : projectCard(projectDb),
      handoff,
    };
  };

  return { getLaunchContext };
}
