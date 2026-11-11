// 账本里的 hub 命令（m2-plan 第 3 节第 4 条，11-03 改过）：按会话认人、按角色放行、分派到各命令、回给 agent 的话、记 hub_calls。
// 整条链：shared/hub.ts（命令表、按角色放行的表）→ hub/cli.ts（命令行）→ agent-api/server.ts（校验）→ 这里。
// worker.* 和 Worker 调的 status 在 workers.ts（worker.show、worker.log 在 worker-view.ts）；schedule.* 在 schedules.ts。
import { z } from "zod";
import { PM_MODE_LABELS, validateAskOptions } from "../../shared/domain.ts";
import type { AgentSessionRow, PmId, PmMode, SessionId } from "../../shared/domain.ts";
import { hubCommandAllowed } from "../../shared/hub.ts";
import type { HubArgs, HubCommand, HubResult, HubVendorModels, ProjectCard } from "../../shared/hub.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import { HUB_COMMAND, LOG_PREFIX } from "../../shared/names.ts";
import type { HubCallContext } from "../../shared/ledger.ts";
import { AGENT_VENDORS, bundledModelCatalog, effortsFor, isAgentVendor } from "../../shared/vendors.ts";
import type { AgentVendor, ModelCatalog, VendorAvailability } from "../../shared/vendors.ts";
import { getAgentSession } from "../store/index.ts";
import { fail } from "./context.ts";
import type { LedgerContext, Pending } from "./context.ts";
import { summarizeArgs, truncateField } from "./files.ts";
import type { LedgerMessages } from "./messages.ts";
import type { LedgerPersona } from "./persona.ts";
import type { LedgerProjects } from "./projects.ts";
import type { LedgerRouter } from "./router.ts";
import type { LedgerSchedules } from "./schedules.ts";
import type { LedgerTaskGraphs } from "./task-graphs.ts";
import type { createLedgerWorkerView } from "./worker-view.ts";
import type { LedgerWorkers } from "./workers.ts";

const projectCreateArgsSchema = z.object({
  folder: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
});

const modelsArgsSchema = z.object({
  vendor: z.custom<AgentVendor>(isAgentVendor).optional(),
  refresh: z.boolean().optional(),
});

const askArgsSchema = z.object({
  text: z.string().refine((s) => s.trim() !== ""),
  options: z.custom<string[]>((v) => v !== undefined).optional(),
});

const recordArgsSchema = z.record(z.string(), z.unknown());

/** status 里的一句“项目和文件夹”。 */
function describeProject(card: ProjectCard | null): string {
  if (card === null) return `还没有项目。用户让你建项目时，用 ${HUB_COMMAND} project create --folder <主文件夹> 建。`;
  const others = card.otherFolders.length === 0 ? "没有附加文件夹" : `附加文件夹 ${card.otherFolders.join("、")}`;
  return `管着项目“${card.name}”：主文件夹 ${card.mainFolder}，${others}。`;
}

/** status 里的一句“准备命令”（hub project setup）；没有项目不说。 */
function describeSetup(card: ProjectCard | null, setupCommand: string | null): string {
  if (card === null) return "";
  return setupCommand === null
    ? `\n准备命令：没配（建 worktree 后不跑东西；要配用 ${HUB_COMMAND} project setup --stdin）。`
    : `\n准备命令（建好 worktree 后先跑它，跑完 Worker 再开工）：\n${setupCommand}`;
}

/** 给 agent 看的命令写法：persona.edit → hub persona edit。 */
const commandLine = (command: HubCommand) => `${HUB_COMMAND} ${command.replace(".", " ")}`;

const VENDOR_AVAILABILITY_TEXT: Readonly<Record<VendorAvailability, string>> = {
  available: "可用",
  unknown: "可用",
  signed_out: "未登录",
  not_installed: "未安装",
};

function toHubVendorModels(catalog: ModelCatalog): HubVendorModels {
  return {
    vendor: catalog.vendor,
    label: catalog.label,
    source: catalog.source,
    availability: catalog.availability,
    defaultModel: catalog.defaultModel,
    defaultModelId: catalog.defaultModelId,
    defaultEffort: catalog.defaultEffort ?? null,
    defaultEfforts: [...effortsFor(catalog, null)],
    efforts: [...catalog.efforts],
    models: catalog.models.map((m) => ({
      id: m.id,
      label: m.label,
      efforts: [...effortsFor(catalog, m.id)],
    })),
  };
}

function formatDefaultModelText(entry: HubVendorModels): string {
  if (entry.defaultModelId !== null && entry.defaultModel !== null && entry.defaultModelId !== entry.defaultModel) {
    return `${entry.defaultModelId}（${entry.defaultModel}）`;
  }
  return entry.defaultModelId ?? entry.defaultModel ?? "默认";
}

function formatVendorModelsBlock(entry: HubVendorModels): string {
  const status = VENDOR_AVAILABILITY_TEXT[entry.availability] ?? "可用";
  const defaultModel = formatDefaultModelText(entry);
  const defaultEffort = entry.defaultEffort ?? "默认";
  const header = `${entry.vendor}（${entry.label}）· 状态: ${status} · 默认模型: ${defaultModel} · 默认思考程度: ${defaultEffort}`;
  const modelLines = entry.models.map((m) => {
    const name = m.label && m.label !== m.id ? `${m.id}（${m.label}）` : m.id;
    const effortText = m.efforts.length > 0 ? m.efforts.join(", ") : "不可调";
    return `  - ${name} · 思考程度: ${effortText}`;
  });
  return [header, ...modelLines].join("\n");
}

export function createLedgerHubCommands(
  ctx: LedgerContext,
  persona: LedgerPersona,
  projects: LedgerProjects,
  workers: LedgerWorkers,
  messages: LedgerMessages,
  schedules: LedgerSchedules,
  workerView: ReturnType<typeof createLedgerWorkerView>,
  router: LedgerRouter,
  taskGraphs: LedgerTaskGraphs,
) {
  const { db, now, write } = ctx;
  const { pmRow, pmSession, getPersona, editPersonaChecked, assertPmNotArchived } = persona;
  const { activeProjectOf, projectCard, createProjectIn, attachIn, detachIn, setupIn } = projects;

  const runHub = (
    p: Pending,
    caller: AgentSessionRow & { pmId: PmId },
    command: HubCommand,
    args: unknown,
    context: HubCallContext,
  ): HubResult<HubCommand> => {
    switch (command) {
      case "status": {
        const pm = pmRow(caller.pmId)!;
        const row = activeProjectOf(pm.id);
        const project = row === null ? null : projectCard(row);
        const setupCommand = row?.setup_command ?? null;
        const { summaries, textBlock } = taskGraphs.pmStatusGraphs(pm.id);
        return {
          text: `你是项目经理“${pm.name}”（${PM_MODE_LABELS[pm.mode as PmMode]}），${describeProject(project)}${describeSetup(project, setupCommand)}${textBlock}`,
          data: {
            role: "pm",
            pm: { id: pm.id, name: pm.name, mode: pm.mode as PmMode },
            sessionId: caller.id,
            conversationId: caller.conversationId ?? -1,
            project,
            setupCommand,
            ...(summaries.length > 0 ? { activeTaskGraphs: summaries } : {}),
          },
        };
      }
      case "project.create": {
        const a = projectCreateArgsSchema.parse(args);
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
      case "project.setup":
        return setupIn(caller, args as HubArgs<"project.setup">);
      case "persona.show": {
        const view = getPersona(caller.pmId, p);
        const body = view.text.trim() === "" ? "（还没有性格设定）" : view.text;
        return { text: `模式：${PM_MODE_LABELS[view.mode]}\n\n${body}`, data: { text: view.text, mode: view.mode } };
      }
      case "persona.edit": {
        const change = editPersonaChecked(p, caller.pmId, args as HubArgs<"persona.edit">, { actor: "pm", session: caller });
        const text =
          change === null ? "性格设定和模式都和现在一样，没有改动。" : "已改好自己的做事习惯，马上生效，聊过的不会丢；用户可以在资料页撤销。";
        return { text, data: { change } };
      }
      case "worker.start":
        return workers.startIn(p, caller, args as HubArgs<"worker.start">, context);
      case "worker.send":
        return workers.sendIn(p, caller, args as HubArgs<"worker.send">);
      case "worker.max-time":
        return workers.maxTimeIn(p, caller, args as HubArgs<"worker.max-time">);
      case "worker.end":
        return workers.endIn(p, caller, args as HubArgs<"worker.end">);
      case "worker.list":
        return workers.list(caller);
      case "worker.show":
        return workerView.show(caller, args as HubArgs<"worker.show">, context);
      case "worker.log":
        return workerView.log(caller, args as HubArgs<"worker.log">);
      case "worker.search":
        return workerView.search(caller, args as HubArgs<"worker.search">);
      case "models": {
        const parsed = modelsArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw fail("invalid", `厂商只能是 ${AGENT_VENDORS.join("、")}`);
        }
        const a = parsed.data;
        const targetVendors: readonly AgentVendor[] = a.vendor !== undefined ? [a.vendor] : AGENT_VENDORS;
        const vendors = targetVendors.map((vendor) => {
          const catalog =
            context.modelCatalogs?.find((c) => c.vendor === vendor) ?? ctx.modelCatalog(vendor) ?? bundledModelCatalog(vendor);
          return toHubVendorModels(catalog);
        });
        return {
          text: vendors.map(formatVendorModelsBlock).join("\n\n"),
          data: { vendors },
        };
      }
      case "ask": {
        assertPmNotArchived(caller.pmId);
        const parsed = askArgsSchema.safeParse(args);
        if (!parsed.success) throw fail("invalid", "要问用户的话不能是空的");
        const { text, options } = parsed.data;
        let normalizedOptions: string[] | undefined;
        if (options !== undefined) {
          const checked = validateAskOptions(options);
          if (!checked.ok) throw fail("invalid", checked.error);
          normalizedOptions = checked.options;
        }
        const message = messages.insertAskMessage(p, caller, text, normalizedOptions);
        return { text: "已向用户提问，会单独提醒用户。等用户回复再继续，别替用户拿主意。", data: { messageId: message.id } };
      }
      case "schedule.add":
        return schedules.addIn(p, caller, args as HubArgs<"schedule.add">);
      case "schedule.list":
        return schedules.list(caller);
      case "schedule.pause":
        return schedules.pauseIn(p, caller, args as HubArgs<"schedule.pause">);
      case "schedule.resume":
        return schedules.resumeIn(p, caller, args as HubArgs<"schedule.resume">);
      case "schedule.remove":
        return schedules.removeIn(p, caller, args as HubArgs<"schedule.remove">);
      case "router.ask":
        return router.askIn(p, caller, args as HubArgs<"router.ask">);
      case "router.report":
        return router.reportIn(p, caller, args as HubArgs<"router.report">);
      case "router.note":
        return router.noteIn(p, caller, args as HubArgs<"router.note">);
      case "graph.create":
        return taskGraphs.createIn(p, caller, args as HubArgs<"graph.create">);
      case "graph.show":
        return taskGraphs.show(caller, args as HubArgs<"graph.show">);
      case "graph.list":
        return taskGraphs.list(caller, args as HubArgs<"graph.list">);
      case "graph.ask":
        return taskGraphs.askIn(p, caller, args as HubArgs<"graph.ask">);
      case "graph.patch":
        return taskGraphs.patchIn(p, caller, args as HubArgs<"graph.patch">);
      case "graph.done":
        return taskGraphs.doneIn(p, caller, args as HubArgs<"graph.done">);
      case "graph.decide":
        return taskGraphs.decideIn(p, caller, args as HubArgs<"graph.decide">);
      case "graph.skip":
        return taskGraphs.skipIn(p, caller, args as HubArgs<"graph.skip">);
      case "graph.cancel":
        return taskGraphs.cancelIn(p, caller, args as HubArgs<"graph.cancel">);
    }
  };

  /**
   * 认人、按角色放行（HUB_COMMAND_ROLES），再分派。项目经理的会话要有 pm_id；Worker 的会话要有 worker_id，
   * 而且只能用 status（m3-plan 第 2.1 节）。别的会话（总助、数据不一致的）一律 forbidden。
   */
  const dispatch = (
    p: Pending,
    session: AgentSessionRow | null,
    command: HubCommand,
    args: unknown,
    context: HubCallContext,
  ): HubResult<HubCommand> => {
    if (session === null || (session.role !== "pm" && session.role !== "worker")) {
      throw fail("forbidden", "这个会话不是项目经理或 Worker 的会话，不能用 hub");
    }
    if (!hubCommandAllowed(session.role, command)) {
      throw fail("forbidden", `Worker 只能用 ${commandLine("status")}，不能用 ${commandLine(command)}：要做的事写进汇报，交给项目经理`);
    }
    if (session.role === "worker") {
      if (session.workerId === null) throw fail("forbidden", "这个 Worker 会话没有对应的 Worker，不能用 hub");
      return workers.status(session);
    }
    const caller = pmSession(session.id);
    if (caller === null) throw fail("forbidden", "这个会话不是项目经理的会话，不能用 hub");
    return runHub(p, caller, command, args, context);
  };

  const recordHubCall = (sessionId: SessionId, command: string, args: unknown, ok: boolean, errorCode: string | null, result: string) => {
    const parsedArgs = recordArgsSchema.safeParse(args);
    db.run(
      "INSERT INTO hub_calls (session_id, command, args, ok, error_code, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      sessionId,
      command,
      JSON.stringify(summarizeArgs(parsedArgs.success ? parsedArgs.data : {})),
      ok ? 1 : 0,
      errorCode,
      truncateField(result),
      now(),
    );
  };

  const hubCall = <C extends HubCommand>(sessionId: SessionId, command: C, args: HubArgs<C>, context: HubCallContext = {}): HubResult<C> => {
    const session = getAgentSession(db, sessionId);
    try {
      return write((p) => {
        const result = dispatch(p, session, command, args, context);
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
          console.error(`${LOG_PREFIX} 记 hub_calls 失败:`, recordError);
        }
      }
      throw error;
    }
  };

  return { hubCall };
}
