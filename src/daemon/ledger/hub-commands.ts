// 账本里的 hub 命令（m2-plan 第 3 节第 4 条）：按会话认人、分派到各命令、回给 agent 的话、记 hub_calls。
// 整条链：shared/hub.ts（命令表）→ hub/cli.ts（命令行）→ agent-api/server.ts（校验）→ 这里。
import { PM_MODE_LABELS } from "../../shared/domain.ts";
import type { AgentSessionRow, PmId, PmMode, SessionId } from "../../shared/domain.ts";
import type { HubArgs, HubCommand, HubData, HubResult } from "../../shared/hub.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import { getAgentSession } from "../store/index.ts";
import { fail } from "./context.ts";
import type { LedgerContext, Pending } from "./context.ts";
import { summarizeArgs, truncateField } from "./files.ts";
import type { LedgerPersona } from "./persona.ts";
import type { LedgerProjects } from "./projects.ts";
import type { ConversationDbRow, PmDbRow } from "./rows.ts";


export function createLedgerHubCommands(ctx: LedgerContext, persona: LedgerPersona, projects: LedgerProjects) {
  const { db, now, write } = ctx;
  const { pmRow, pmSession, getPersona, editPersonaChecked } = persona;
  const { projectRow, managedProjects, projectCard, createProjectIn, attachIn, detachIn, assignIn } = projects;

  const runHub = (p: Pending, caller: AgentSessionRow & { pmId: PmId }, command: HubCommand, args: unknown): HubResult<HubCommand> => {
    switch (command) {
      case "status": {
        const pm = pmRow(caller.pmId)!;
        const conversation = db.get<ConversationDbRow>("SELECT * FROM conversations WHERE id = ?", caller.conversationId ?? -1);
        const projects = managedProjects(pm.id).map(projectCard);
        const where =
          conversation === undefined
            ? "不在任何对话里"
            : conversation.kind === "project_group"
              ? `在项目“${projectRow(conversation.project_id!).name}”的群里`
              : "在和用户的私聊里";
        const list = projects.length === 0 ? "现在没有管着项目。" : `管着 ${projects.length} 个项目：${projects.map((x) => x.name).join("、")}。`;
        const data: HubData<"status"> = {
          pm: { id: pm.id, name: pm.name, mode: pm.mode as PmMode },
          sessionId: caller.id,
          conversation: {
            id: conversation?.id ?? -1,
            kind: (conversation?.kind ?? "pm") as HubData<"status">["conversation"]["kind"],
            projectId: conversation?.project_id ?? null,
          },
          projects,
        };
        return { text: `你是项目经理“${pm.name}”（${PM_MODE_LABELS[pm.mode as PmMode]}），现在${where}，${list}`, data };
      }
      case "pm.list": {
        const pms = db.all<PmDbRow>("SELECT * FROM pms ORDER BY id").map((pm) => ({
          id: pm.id,
          name: pm.name,
          mode: pm.mode as PmMode,
          projects: managedProjects(pm.id).map((x) => x.name),
        }));
        const lines = pms.map((pm) => `- ${pm.name}（${PM_MODE_LABELS[pm.mode]}）：${pm.projects.length === 0 ? "没有项目" : pm.projects.join("、")}`);
        return { text: `所有项目经理：\n${lines.join("\n")}`, data: { pms } };
      }
      case "project.create": {
        const a = args as HubArgs<"project.create">;
        const result = createProjectIn(p, { name: a.name, folder: a.folder, pmId: caller.pmId, ...(a.description !== undefined ? { description: a.description } : {}) });
        const { project, mainFolder, conversation } = result;
        return {
          text: `已建好项目“${project.name}”，主文件夹 ${mainFolder.path}；左栏多了群“${conversation.title}”，以后这个项目的事在群里聊。`,
          data: { project, mainFolder, conversation },
        };
      }
      case "project.attach":
        return attachIn(p, caller, args as HubArgs<"project.attach">);
      case "project.detach":
        return detachIn(p, caller, args as HubArgs<"project.detach">);
      case "project.assign":
        return assignIn(p, caller, args as HubArgs<"project.assign">);
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
