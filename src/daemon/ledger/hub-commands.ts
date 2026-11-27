import { formatPmAgenda } from "../../shared/pm-agenda.ts";
import { pmAgendaOf } from "./pm-agenda.ts";
import { formatVendorQuotaStatus } from "../quota/observed-quota.ts";
import { z } from "zod";
import { PM_MODE_LABELS, validateAskOptions } from "../../shared/domain.ts";
import type { AgentSessionRow, PmId, PmMode, SessionId } from "../../shared/domain.ts";
import { feishuGuestTurnBlockReason, feishuOriginOf } from "../../shared/feishu.ts";
import { ASK_CARD_TELL_USER, ASK_CARD_WHERE, hubCommandAllowed } from "../../shared/hub.ts";
import { HUB_CHECKLIST_COMMAND, HUB_CHECKLIST_USAGE, hubChecklistRequestSchema } from "../../shared/hub-checklist.ts";
import type { HubArgs, HubCommand, HubResult, HubVendorModels, ProjectCard, WorkerStartQueuedResult } from "../../shared/hub.ts";
import { LedgerRequestError } from "../../shared/ledger.ts";
import { HUB_CALL_RESULT_MAX_BYTES } from "../../shared/limits.ts";
import type { HubFileArg } from "../../shared/deliverables.ts";
import type { SentFile } from "../../shared/sent-files.ts";
import { deliverablesOfFileArgs, fileArgsProblem } from "../deliverables.ts";
import { HUB_COMMAND, LOG_PREFIX } from "../../shared/names.ts";
import type { HubCallContext } from "../../shared/ledger.ts";
import { AGENT_VENDORS, bundledModelCatalog, effortLabel, effortsFor, isAgentVendor } from "../../shared/vendors.ts";
import type { AgentVendor, ModelCatalog } from "../../shared/vendors.ts";
import { getAgentSession } from "../store/index.ts";
import { assertHubLimit, fail } from "./context.ts";
import type { LedgerContext, Pending } from "./context.ts";
import { summarizeArgs, truncateField } from "./files.ts";
import type { LedgerMessages } from "./messages.ts";
import { askListIn, askShowIn } from "./pending-asks.ts";
import type { LedgerPersona } from "./persona.ts";
import type { LedgerProjects } from "./projects.ts";
import type { LedgerRouter } from "./router.ts";
import { scheduleShowIn } from "./schedule-runs.ts";
import type { LedgerSchedules } from "./schedules.ts";
import type { LedgerTaskGraphs } from "./task-graphs.ts";
import type { createLedgerWorkerView } from "./worker-view.ts";
import type { LedgerWorkers } from "./workers.ts";
import { formatHubCapabilities } from "../../shared/hub-caps.ts";
import { CAPABILITY_KINDS, type CapabilityKind } from "../../shared/pm-capabilities.ts";
import { readPmCapabilityPolicy } from "./pm-capabilities.ts";
import { describeSelfReload } from "../self-reload.ts";

const projectCreateArgsSchema = z.object({
  folder: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
});

const modelsArgsSchema = z.object({
  vendor: z.custom<AgentVendor>(isAgentVendor).optional(),
  refresh: z.boolean().optional(),
});

const capsArgsSchema = z.object({
  kind: z.enum(CAPABILITY_KINDS).optional(),
  vendor: z.custom<AgentVendor>(isAgentVendor).optional(),
});

const askArgsSchema = z.object({
  text: z.string().refine((s) => s.trim() !== ""),
  options: z.custom<string[]>((v) => v !== undefined).optional(),
  recommended: z.string().optional(),
  node: z.string().optional(),
  graphId: z.number().int().positive().optional(),
  replaceItemId: z.number().int().positive().optional(),
});

const fileArgsSchema = z.array(z.object({ label: z.string().nullable(), path: z.string() })).optional();

const recordArgsSchema = z.record(z.string(), z.unknown());

function describeProject(card: ProjectCard | null): string {
  if (card === null) return `还没有项目。用户让你建项目时，用 ${HUB_COMMAND} project create --folder <主文件夹> 建。`;
  const others = card.otherFolders.length === 0 ? "没有附加文件夹" : `附加文件夹 ${card.otherFolders.join("、")}`;
  return `管着项目“${card.name}”：主文件夹 ${card.mainFolder}，${others}。`;
}

function describeSetup(card: ProjectCard | null, setupCommand: string | null): string {
  if (card === null) return "";
  return setupCommand === null
    ? `\n准备命令：没配（建 worktree 后不跑东西；要配用 ${HUB_COMMAND} project setup --stdin）。`
    : `\n准备命令（建好 worktree 后先跑它，跑完 Worker 再开工）：\n${setupCommand}`;
}

const commandLine = (command: HubCommand) => `${HUB_COMMAND} ${command.replace(".", " ")}`;

function toHubVendorModels(catalog: ModelCatalog, quota: HubVendorModels["quota"]): HubVendorModels {
  const keys = new Set<string>([
    ...catalog.efforts,
    ...(catalog.defaultEfforts ?? []),
    ...(catalog.defaultEffort ? [catalog.defaultEffort] : []),
    ...catalog.models.flatMap((m) => m.efforts ?? []),
  ]);
  return {
    vendor: catalog.vendor,
    label: catalog.label,
    source: catalog.source,
    availability: catalog.availability,
    ...(quota === undefined ? {} : { quota }),
    defaultModel: catalog.defaultModel,
    defaultModelId: catalog.defaultModelId,
    defaultEffort: catalog.defaultEffort ?? null,
    defaultEfforts: [...effortsFor(catalog, null)],
    efforts: [...catalog.efforts],
    effortLabels: Object.fromEntries([...keys].map((e) => [e, effortLabel(e, catalog.vendor, catalog)])),
    models: catalog.models.map((m) => ({
      id: m.id,
      label: m.label,
      efforts: [...effortsFor(catalog, m.id)],
    })),
  };
}

function formatVendorEffort(vendor: AgentVendor, effort: string, labels?: Readonly<Record<string, string>>): string {
  const label = labels?.[effort] ?? effortLabel(effort, vendor);
  return label !== effort ? `${effort}（${label}）` : effort;
}

function formatDefaultModelText(entry: HubVendorModels): string {
  if (entry.defaultModelId !== null && entry.defaultModel !== null && entry.defaultModelId !== entry.defaultModel) {
    return `${entry.defaultModelId}（${entry.defaultModel}）`;
  }
  return entry.defaultModelId ?? entry.defaultModel ?? "默认";
}

function formatVendorModelsBlock(entry: HubVendorModels, now: number): string {
  const status = formatVendorQuotaStatus(entry.availability, entry.quota, now);
  const defaultModel = formatDefaultModelText(entry);
  const defaultEffort = entry.defaultEffort === null ? "默认" : formatVendorEffort(entry.vendor, entry.defaultEffort, entry.effortLabels);
  const header = `${entry.vendor}（${entry.label}）· 状态: ${status} · 默认模型: ${defaultModel} · 默认思考程度: ${defaultEffort}`;
  const modelLines = entry.models.map((m) => {
    const name = m.label && m.label !== m.id ? `${m.id}（${m.label}）` : m.id;
    const effortText = m.efforts.length > 0 ? m.efforts.map((e) => formatVendorEffort(entry.vendor, e, entry.effortLabels)).join(", ") : "不可调";
    return `  - ${name} · 思考程度: ${effortText}`;
  });
  return [header, ...modelLines].join("\n");
}

interface PmStatusDeps {
  persona: Pick<LedgerPersona, "pmRow">;
  projects: Pick<LedgerProjects, "activeProjectOf" | "projectCard">;
  db: LedgerContext["db"];
  now: number;
  taskGraphManual: (sessionId: SessionId) => string;
}

function pmStatusIn(deps: PmStatusDeps, caller: AgentSessionRow & { pmId: PmId }, context: HubCallContext): HubResult<"status"> {
  const pm = deps.persona.pmRow(caller.pmId)!;
  const row = deps.projects.activeProjectOf(pm.id);
  const project = row === null ? null : deps.projects.projectCard(row);
  const setupCommand = row?.setup_command ?? null;
  const agenda = pmAgendaOf(deps.db, pm.id, deps.now);
  const summaries = agenda.graphs.map((graph) => ({
    id: graph.graphId, title: graph.title, totalNodes: graph.stepCount, doneCount: graph.doneCount,
    runningCount: graph.steps.filter((step) => step.state.kind === "running").length,
    waitingPmCount: graph.steps.filter((step) => step.state.kind === "waiting_pm").length,
    waitingUserCount: graph.steps.filter((step) => step.state.kind === "waiting_user").length,
    readyToFinish: graph.readyToFinish,
  }));
  const manual = summaries.length > 0 ? deps.taskGraphManual(caller.id) : "";
  const selfReload = context.selfReload !== undefined && describeSelfReload(context.selfReload) !== "" ? context.selfReload : undefined;
  const reloadNote = selfReload === undefined ? "" : `\n${describeSelfReload(selfReload)}`;
  return {
    text: `${formatPmAgenda(agenda, deps.now)}\n\n你是项目经理“${pm.name}”（${PM_MODE_LABELS[pm.mode as PmMode]}），${describeProject(project)}${describeSetup(project, setupCommand)}${manual === "" ? "" : `\n${manual}`}${reloadNote}`,
    data: {
      role: "pm",
      pm: { id: pm.id, name: pm.name, mode: pm.mode as PmMode },
      sessionId: caller.id,
      conversationId: caller.conversationId ?? -1,
      project,
      setupCommand,
      ...(summaries.length > 0 ? { activeTaskGraphs: summaries } : {}),
      ...(selfReload !== undefined ? { selfReload } : {}),
    },
  };
}

function capsIn(
  db: LedgerContext["db"],
  pmId: PmId,
  nowMs: number,
  args: unknown,
  context: HubCallContext,
  workerPlatform: string,
): HubResult<"caps"> {
  const parsed = capsArgsSchema.safeParse(args);
  if (!parsed.success) {
    throw fail("invalid", `--kind 只能是 ${CAPABILITY_KINDS.join("、")}，--vendor 只能是 ${AGENT_VENDORS.join("、")}`);
  }
  const policy = readPmCapabilityPolicy(db, pmId);
  const inventory = context.capabilityInventory ?? { scannedAt: nowMs, items: [], groups: [], truncated: false };
  return formatHubCapabilities(
    policy,
    inventory,
    {
      ...(parsed.data.kind !== undefined ? { kind: parsed.data.kind as CapabilityKind } : {}),
      ...(parsed.data.vendor !== undefined ? { vendor: parsed.data.vendor } : {}),
    },
    workerPlatform,
  );
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
  taskGraphManual: (sessionId: SessionId) => string = () => "",
  workerPlatform: string = process.platform,
) {
  const { db, now, write } = ctx;
  const withManual = <T extends { text: string }>(sessionId: SessionId, run: () => T): T => {
    const note = taskGraphManual(sessionId);
    try {
      const result = run();
      return note === "" ? result : { ...result, text: `${result.text}\n\n${note}` };
    } catch (error) {
      if (note !== "" && error instanceof LedgerRequestError) throw new LedgerRequestError(error.code, `${error.message}\n${note}`);
      throw error;
    }
  };
  /** Attachments are copied by the agent API outside the transaction; if any copy is missing the whole command is rejected. */
  const sharedFileArgs = (raw: unknown, context: HubCallContext): { args: HubFileArg[]; files: SentFile[] } | undefined => {
    const parsed = fileArgsSchema.safeParse(raw);
    if (!parsed.success) throw fail("invalid", "--file 要写成 [标签=]路径");
    const args = parsed.data ?? [];
    if (args.length === 0) return undefined;
    assertHubLimit("files", args);
    for (const arg of args) {
      if (arg.label !== null) assertHubLimit("fileLabel", arg.label.trim());
    }
    const files = context.sharedFiles;
    if (files === undefined || files.length !== args.length || files.some((f, i) => f.href !== args[i]!.path)) {
      throw new Error("--file 的副本要在进事务之前存好（agent 接口先调 shareHubFiles，结果放进 HubCallContext.sharedFiles）");
    }
    const problem = fileArgsProblem(files);
    if (problem !== null) throw fail("invalid", problem);
    return { args, files: [...files] };
  };
  const { pmSession, getPersona, editPersonaChecked, assertPmNotArchived } = persona;
  const { createProjectIn, attachIn, detachIn, setupIn } = projects;

  const runHub = (
    p: Pending,
    caller: AgentSessionRow & { pmId: PmId },
    command: Exclude<HubCommand, "checklist">,
    args: unknown,
    context: HubCallContext,
  ): HubResult<HubCommand> | WorkerStartQueuedResult => {
    switch (command) {
      case "status":
        return pmStatusIn({ persona, projects, db, now: now(), taskGraphManual }, caller, context);
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
        return setupIn(p, caller, args as HubArgs<"project.setup">);
      case "persona.show": {
        const { text, mode } = getPersona(caller.pmId, p);
        return { text, data: { text, mode } };
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
        return workers.sendIn(p, caller, args as HubArgs<"worker.send">, context.routerDeliveryId);
      case "worker.max-time":
        return workers.maxTimeIn(p, caller, args as HubArgs<"worker.max-time">);
      case "worker.end":
        return workers.endIn(p, caller, args as HubArgs<"worker.end">);
      case "worker.list":
        return workers.list(caller, args as HubArgs<"worker.list">);
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
          return toHubVendorModels(catalog, context.vendorQuotas?.[vendor]);
        });
        return {
          text: vendors.map((entry) => formatVendorModelsBlock(entry, ctx.now())).join("\n\n"),
          data: { vendors },
        };
      }
      case "caps":
        return capsIn(db, caller.pmId, now(), args, context, workerPlatform);
      case "ask": {
        assertPmNotArchived(caller.pmId);
        const parsed = askArgsSchema.safeParse(args);
        if (!parsed.success) throw fail("invalid", "要问用户的话不能是空的");
        const { text, options, recommended, node, graphId, replaceItemId } = parsed.data;
        const fileArgs = sharedFileArgs((args as HubArgs<"ask">).files, context);
        if (graphId !== undefined && (node === undefined || node.trim() === "")) {
          throw fail("invalid", "--graph 要配合 --node <步骤> 一起用");
        }
        if (node !== undefined && node.trim() !== "") {
          if (replaceItemId !== undefined) throw fail("invalid", "--replace 不能和 --node 一起用");
          return taskGraphs.askOnStepIn(p, caller, {
            text,
            node: node.trim(),
            ...(graphId !== undefined ? { graphId } : {}),
            ...(options !== undefined ? { options } : {}),
            ...(recommended !== undefined ? { recommended } : {}),
            ...(fileArgs !== undefined ? { fileArgs } : {}),
          });
        }
        let normalizedOptions: string[] | undefined;
        if (options !== undefined) {
          const checked = validateAskOptions(options);
          if (!checked.ok) throw fail("invalid", checked.error);
          normalizedOptions = checked.options;
        }
        let resolvedRecommended: string | undefined;
        if (recommended !== undefined && recommended.trim() !== "") {
          const rec = recommended.trim();
          if (normalizedOptions === undefined) {
            throw fail("invalid", "--recommended 要配合 --option <选项>... 一起用");
          }
          let matched = normalizedOptions.find((o) => o === rec);
          if (matched === undefined && /^[1-9][0-9]*$/.test(rec)) {
            const idx = Number(rec) - 1;
            if (idx >= 0 && idx < normalizedOptions.length) matched = normalizedOptions[idx];
          }
          if (matched === undefined) {
            throw fail("invalid", `推荐项「${rec}」必须是选项之一`);
          }
          resolvedRecommended = matched;
        }
        router.prepareIndependentAskIn(p, caller.pmId, replaceItemId);
        const message = messages.insertAskMessage(p, caller, text, normalizedOptions, {
          ...(resolvedRecommended !== undefined ? { recommended: resolvedRecommended } : {}),
          ...(fileArgs !== undefined ? { fileArgs } : {}),
          skipRouterBridge: true,
        });
        const item = router.bridgeAskIn(p, caller, message, normalizedOptions, { replaceItemId });
        return {
          text: `已向用户提问${item === null ? "" : `，卡 #${item.id}`}：${ASK_CARD_WHERE}。${ASK_CARD_TELL_USER}。等用户回复再继续，别替用户拿主意。`,
          data: { messageId: message.id, ...(item !== null ? { item } : {}) },
        };
      }
      case "ask.close": {
        const a = args as HubArgs<"ask.close">;
        return "messageId" in a ? taskGraphs.closeStepAskIn(p, caller, a.messageId) : router.closeAskIn(p, caller, a);
      }
      case "ask.list":
        return askListIn(db, caller, now());
      case "ask.show":
        return askShowIn(db, caller, args as HubArgs<"ask.show">, now());
      case "schedule.add":
        return schedules.addIn(p, caller, args as HubArgs<"schedule.add">);
      case "schedule.list":
        return schedules.list(caller);
      case "schedule.show":
        return scheduleShowIn(db, caller, args as HubArgs<"schedule.show">, now());
      case "schedule.pause":
        return schedules.pauseIn(p, caller, args as HubArgs<"schedule.pause">);
      case "schedule.resume":
        return schedules.resumeIn(p, caller, args as HubArgs<"schedule.resume">);
      case "schedule.remove":
        return schedules.removeIn(p, caller, args as HubArgs<"schedule.remove">);
      case "router.report": {
        const { files: rawFiles, ...rest } = args as HubArgs<"router.report">;
        const fileArgs = sharedFileArgs(rawFiles, context);
        return router.reportIn(p, caller, rest, fileArgs === undefined ? [] : deliverablesOfFileArgs(fileArgs.args, fileArgs.files, null));
      }
      case "graph.create":
        return withManual(caller.id, () => taskGraphs.createIn(p, caller, args as HubArgs<"graph.create">, context));
      case "graph.show":
        return taskGraphs.show(caller, args as HubArgs<"graph.show">);
      case "graph.list":
        return taskGraphs.list(caller, args as HubArgs<"graph.list">);
      case "graph.patch":
        return withManual(caller.id, () => taskGraphs.patchIn(p, caller, args as HubArgs<"graph.patch">, context));
      case "graph.done":
        return taskGraphs.doneIn(p, caller, args as HubArgs<"graph.done">, context);
      case "graph.decide":
        return taskGraphs.decideIn(p, caller, args as HubArgs<"graph.decide">, context);
      case "graph.skip":
        return taskGraphs.skipIn(p, caller, args as HubArgs<"graph.skip">, context);
      case "graph.cancel":
        return taskGraphs.cancelIn(p, caller, args as HubArgs<"graph.cancel">);
      case "graph.finish":
        return taskGraphs.finishIn(p, caller, args as HubArgs<"graph.finish">, context);
    }
  };

  const guestTurnBlockReason = (session: AgentSessionRow, command: HubCommand): string | null => {
    const rows = db.all<{ meta: string | null }>(
      "SELECT meta FROM messages INDEXED BY messages_in_flight WHERE session_id = ? AND status IN ('delivered', 'processing') AND sender = 'user' AND meta IS NOT NULL",
      session.id,
    );
    for (const row of rows) {
      const reason = feishuGuestTurnBlockReason(command, feishuOriginOf({ meta: JSON.parse(row.meta!) as Record<string, unknown> }));
      if (reason !== null) return reason;
    }
    return null;
  };

  const dispatch = (
    p: Pending,
    session: AgentSessionRow | null,
    command: HubCommand,
    args: unknown,
    context: HubCallContext,
  ): HubResult<HubCommand> | WorkerStartQueuedResult => {
    if (session === null || (session.role !== "pm" && session.role !== "worker")) {
      throw fail("forbidden", "这个会话不是项目经理或 Worker 的会话，不能用 hub");
    }
    if (!hubCommandAllowed(session.role, command)) {
      throw fail("forbidden", `Worker 只能用 ${commandLine("status")} 和 ${HUB_CHECKLIST_COMMAND}，不能用 ${commandLine(command)}：要做的事写进汇报，交给项目经理`);
    }
    if (session.role === "worker" && session.workerId === null) {
      throw fail("forbidden", "这个 Worker 会话没有对应的 Worker，不能用 hub");
    }
    if (command === "checklist") {
      const request = hubChecklistRequestSchema.safeParse(args);
      if (!request.success) throw fail("invalid", `进度清单参数不对。\n用法：\n${HUB_CHECKLIST_USAGE}`);
      messages.checklistFromHub(p, session, request.data);
      return { text: "已更新进度清单", data: null };
    }
    if (session.role === "worker") {
      return workers.status(session);
    }
    const caller = pmSession(session.id);
    if (caller === null) throw fail("forbidden", "这个会话不是项目经理的会话，不能用 hub");
    const guestBlock = guestTurnBlockReason(session, command);
    if (guestBlock !== null) throw fail("forbidden", guestBlock);
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
      truncateField(result, HUB_CALL_RESULT_MAX_BYTES),
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
