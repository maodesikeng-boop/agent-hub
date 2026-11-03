// 账本里的 hub 命令（m2-plan 第 3 节第 4 条，11-03 改过）：按会话认人、分派到各命令、回给 agent 的话、记 hub_calls。
// 整条链：shared/hub.ts（命令表）→ hub/cli.ts（命令行）→ agent-api/server.ts（校验）→ 这里。
import { PM_MODE_LABELS } from "../../shared/domain.ts";
import type { AgentSessionRow, PmId, PmMode, SessionId } from "../../shared/domain.ts";
import type { HubArgs, HubCommand, HubResult, ProjectCard } from "../../shared/hub.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import { getAgentSession } from "../store/index.ts";
import { fail } from "./context.ts";
import type { LedgerContext, Pending } from "./context.ts";
import { summarizeArgs, truncateField } from "./files.ts";
import type { LedgerPersona } from "./persona.ts";
import type { LedgerProjects } from "./projects.ts";

/** status 里的一句“项目和文件夹”。 */
function describeProject(card: ProjectCard | null): string {
  if (card === null) return "还没有项目。用户让你建项目时，用 hub project create --folder <主文件夹> 建。";
  const others = card.otherFolders.length === 0 ? "没有附加文件夹" : `附加文件夹 ${card.otherFolders.join("、")}`;
  return `管着项目“${card.name}”：主文件夹 ${card.mainFolder}，${others}。`;
}

export function createLedgerHubCommands(ctx: LedgerContext, persona: LedgerPersona, projects: LedgerProjects) {
  const { db, now, write } = ctx;
  const { pmRow, pmSession, getPersona, editPersonaChecked } = persona;
  const { activeProjectOf, projectCard, createProjectIn, attachIn, detachIn } = projects;

  const runHub = (p: Pending, caller: AgentSessionRow & { pmId: PmId }, command: HubCommand, args: unknown): HubResult<HubCommand> => {
    switch (command) {
      case "status": {
        const pm = pmRow(caller.pmId)!;
        const row = activeProjectOf(pm.id);
        const project = row === null ? null : projectCard(row);
        return {
          text: `你是项目经理“${pm.name}”（${PM_MODE_LABELS[pm.mode as PmMode]}），${describeProject(project)}`,
          data: {
            role: "pm",
            pm: { id: pm.id, name: pm.name, mode: pm.mode as PmMode },
            sessionId: caller.id,
            conversationId: caller.conversationId ?? -1,
            project,
          },
        };
      }
      case "project.create": {
        const a = args as HubArgs<"project.create">;
        const { project, mainFolder } = createProjectIn(p, {
          pmId: caller.pmId,
          folder: a.folder,
          ...(a.name !== undefined ? { name: a.name } : {}),
          ...(a.description !== undefined ? { description: a.description } : {}),
        });
        return {
          text: `已建好项目“${project.name}”，主文件夹 ${mainFolder.path}。下一条消息起你就在这个文件夹里工作（会自动按新设置重启，聊过的都在）。`,
          data: { project, mainFolder },
        };
      }
      case "project.attach":
        return attachIn(p, caller, args as HubArgs<"project.attach">);
      case "project.detach":
        return detachIn(p, caller, args as HubArgs<"project.detach">);
      case "persona.show": {
        const view = getPersona(caller.pmId);
        return { text: `模式：${PM_MODE_LABELS[view.mode]}\n\n${view.text}`, data: { text: view.text, mode: view.mode } };
      }
      case "persona.edit": {
        const change = editPersonaChecked(p, caller.pmId, args as HubArgs<"persona.edit">, { actor: "pm", session: caller });
        const text =
          change === null ? "性格设定和模式都和现在一样，没有改动。" : "已改好自己的做事习惯，下一条消息起生效；用户可以在资料页撤销。";
        return { text, data: { change } };
      }
      // M3 W0 的占位，W2 实现
      case "worker.start":
      case "worker.send":
      case "worker.end":
      case "worker.list":
        throw fail("invalid", "hub worker 还没做好");
    }
  };

  const recordHubCall = (sessionId: SessionId, command: string, args: unknown, ok: boolean, errorCode: string | null, result: string) => {
    db.run(
      "INSERT INTO hub_calls (session_id, command, args, ok, error_code, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      sessionId,
      command,
      JSON.stringify(summarizeArgs(typeof args === "object" && args !== null ? args : {})),
      ok ? 1 : 0,
      errorCode,
      truncateField(result),
      now(),
    );
  };

  const hubCall = <C extends HubCommand>(sessionId: SessionId, command: C, args: HubArgs<C>): HubResult<C> => {
    const session = getAgentSession(db, sessionId);
    const caller = pmSession(sessionId);
    try {
      if (caller === null) throw fail("forbidden", "这个会话不是项目经理的会话，不能用 hub");
      return write((p) => {
        const result = runHub(p, caller, command, args);
        recordHubCall(sessionId, command, args, true, null, result.text);
        return result as HubResult<C>;
      });
    } catch (error) {
      if (session !== null) {
        const code = error instanceof LedgerRequestError ? error.code : "internal";
        const message = error instanceof Error ? error.message : String(error);
        try {
          write(() => recordHubCall(sessionId, command, args, false, code, message));
        } catch (recordError) {
          console.error("agent-hub: 记 hub_calls 失败:", recordError);
        }
      }
      throw error;
    }
  };

  return { hubCall };
}
