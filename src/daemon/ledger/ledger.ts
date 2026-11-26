import { createLedgerTakenInputs } from "./taken-inputs.ts";
import { isChecklistToolCall } from "./checklist.ts";
import { createChecklistReminders } from "./checklist-reminders.ts";
import type { WorktreeBranchProbe } from "../git/worktree-branch.ts";
import { createLedgerBranchSync } from "./workers/branch-sync.ts";
import { isSystemMessageCurrent } from "./notice-currency.ts";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LedgerSnapshot } from "../../shared/api.ts";
import { agentMessageDedupeKey } from "../../shared/domain.ts";
import type { Message, MessageId, Pm, PmId, SessionId, WorkerId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import type { CreatePmInput, CreatePmResult, Ledger, ResolveFolder } from "../../shared/ledger.ts";
import { deliveryParts } from "../../shared/worker.ts";
import { pendingAsksNote } from "../../shared/pending-asks.ts";
import { pendingAsksOfPm } from "./pending-asks.ts";
import { WORKER_PURGE_BATCH_ROWS } from "../../shared/limits.ts";
import { LOG_PREFIX } from "../../shared/names.ts";
import type { AgentTextMeta } from "../../shared/sent-files.ts";
import type { LocalLink } from "../sent-files.ts";
import { getAgentSession } from "../store/index.ts";
import type { Db } from "../store/index.ts";
import { createLedgerContext } from "./context.ts";
import { fail } from "./context.ts";
import type { LedgerContextOptions, LedgerFiles } from "./context.ts";
import { createResolveFolder, writeFileAtomic as defaultWriteFileAtomic } from "./files.ts";
import { createLedgerHandover } from "./handover.ts";
import type { HandoverOptions } from "./handover.ts";
import { createLedgerHubCommands } from "./hub-commands.ts";
import { createLedgerLaunchContext } from "./launch-context.ts";
import { createLedgerLoadedSkills } from "./loaded-skills.ts";
import { createLedgerMessages } from "./messages.ts";
import { createLedgerTurnReplies } from "./turn-replies.ts";
import { createDriverEventDrain } from "./driver-events.ts";
import { createTurnCompletionLedger, type TurnEndedEvent } from "./turn-completions.ts";
import { createLedgerPersona } from "./persona.ts";
import { createLedgerPmCapabilities } from "./pm-capabilities.ts";
import { createLedgerPmPins } from "./pm-pins.ts";
import { createLedgerProjectCatalog } from "./project-catalog.ts";
import type { LedgerProjectCatalog, ProjectCatalogLedgerOptions } from "./project-catalog.ts";
import { createLedgerProjects } from "./projects.ts";
import { PM_SELECT, toHealth, toPm, toProject, toProjectFolder } from "./rows.ts";
import type { HealthDbRow, PmDbRow, ProjectDbRow, ProjectFolderDbRow } from "./rows.ts";
import { createLedgerRouter } from "./router.ts";
import type { LedgerRouter } from "./router.ts";
import { createLedgerSchedules } from "./schedules.ts";
import { createLedgerSentFiles } from "./sent-files.ts";
import { createLedgerSessions, idle } from "./sessions.ts";
import { completedWorkPage } from "./completed-work.ts";
import { createLedgerSnapshotQueries } from "./snapshot.ts";
import { createLedgerSteps } from "./steps.ts";
import { createLedgerTaskGraphs } from "./task-graphs.ts";
import { createLedgerTakeover } from "./takeover.ts";
import { createSkillFiles, type SkillFiles } from "../skill-files.ts";
import { createLedgerUserBlockers } from "./user-blockers.ts";
import { taskGraphManualNote } from "../task-graph-skill.ts";
import { createLedgerWorkerRetention, type WorkerPurgeBatch } from "./worker-retention.ts";
import { createDbTableRetention, type TableRetentionBatch } from "./db-table-retention.ts";
import { createLedgerWorkerView } from "./worker-view.ts";
import { assertWorkerOpenForUser, createLedgerWorkers, notStarted } from "./workers.ts";
import type { EndedWorktreeCandidate } from "./workers.ts";

export interface SqliteLedger extends Ledger {
  readonly appApprovals: ReturnType<typeof createLedgerWorkers>["appApprovals"];
  archivePm(pmId: PmId): Pm;
  unarchivePm(pmId: PmId): Pm;
  purgeExpiredArchivedPms(nowMs?: number): PmId[];
  purgeExpiredWorkerConversations(nowMs?: number, maxRows?: number): WorkerPurgeBatch;
  purgeExpiredRouterAndGraphRecords(nowMs?: number, maxRows?: number): { rows: number; more: boolean };
  purgeGrowingTables(nowMs?: number, maxRows?: number): TableRetentionBatch;
  trimEndedWorkerSteps(sessionId: SessionId): number;
  listEndedWorktreeWorkers(): EndedWorktreeCandidate[];
  isWorkerCleanable(workerId: WorkerId): boolean;
  getRouterSettings: LedgerRouter["getSettings"];
  createRouterCommand: LedgerRouter["createCommand"];
  updateRouterCommand: LedgerRouter["updateCommand"];
  claimRouterCommandRetry: LedgerRouter["claimCommandRetry"];
  routerCommandDeliveries: LedgerRouter["commandDeliveries"];
  postedUserMessageId: ReturnType<typeof createLedgerMessages>["postedUserMessageId"];
  getRouterCommand: LedgerRouter["getCommand"];
  getRouterItem: LedgerRouter["getItem"];
  resolveRouterItem: LedgerRouter["resolveItem"];
  answerAsk: LedgerRouter["answerAsk"];
  decideTaskNode: ReturnType<typeof createLedgerTaskGraphs>["decideNode"];
  listRouterCommands: LedgerRouter["listCommands"];
  createRouterAssistantSession: LedgerRouter["createAssistantSession"];
  endRouterAssistantSession: LedgerRouter["endAssistantSession"];
  recordRouterWorkerOrigin: LedgerRouter["recordWorkerOrigin"];
  resolveRouterLocalPmOrProject: LedgerRouter["resolveLocalPmOrProject"];
  projectCatalog: Omit<LedgerProjectCatalog, "afterDriverEvent" | "markForcedIn">;
  resolveRouterLocalWorker: LedgerRouter["resolveLocalWorker"];
  listRouterLocalWorkers: LedgerRouter["listLocalWorkers"];
  /** Call before closing the database. Pending driver events are flushed in order without attachments, and later events are dropped. */
  close(): void;
}

export interface LedgerOptions {
  worktreeBranchProbe?: WorktreeBranchProbe;
  now?: () => number;
  deviceName?: () => string;
  models?: LedgerContextOptions["models"];
  knownCommands?: LedgerContextOptions["knownCommands"];
  /** Fixture override for the first seq; production starts each boot at 0 and clients scope seq by the UI server boot ID. */
  initialSeq?: number;
  changeBufferSize?: number;
  osSandboxed?: LedgerContextOptions["osSandboxed"];
  workerPlatform?: NodeJS.Platform;
  pmHomeRoot: string;
  personasDir?: string;
  pmMemoryDir?: string;
  dataHome?: string;
  worktreesDir?: string;
  extraWorktreeRoots?: () => readonly string[];
  launchDir?: string;
  setupLogsDir?: string;
  sentFilesDir?: string;
  uploadsDir?: string;
  shareTmpDirs?: string[];
  userHome?: string;
  resolveFolder?: ResolveFolder;
  writeFileAtomic?: (file: string, content: string) => void;
  findTranscript?: HandoverOptions["findTranscript"];
  autoRenew?: HandoverOptions["autoRenew"];
  log?: (line: string) => void;
  skillFiles?: SkillFiles;
  onHandoverClaimable?: HandoverOptions["onHandoverClaimable"];
  onCatalogClaimable?: ProjectCatalogLedgerOptions["onCatalogClaimable"];
  isSessionBusy?: HandoverOptions["isSessionBusy"];
}

function buildLedgerFiles(options: LedgerOptions, userHome: string, dataHome: string): LedgerFiles {
  return {
    pmHomeRoot: options.pmHomeRoot,
    personasDir: options.personasDir,
    pmMemoryDir: options.pmMemoryDir ?? (options.dataHome !== undefined ? join(options.dataHome, "state", "pm-memory") : undefined),
    pmMemoryFallbackDir: join(options.pmHomeRoot, ".pm-memory"),
    worktreesDir: options.worktreesDir ?? join(dataHome, "worktrees"),
    extraWorktreeRoots: options.extraWorktreeRoots,
    launchDir: options.launchDir,
    setupLogsDir: options.setupLogsDir,
    userHome,
    resolveFolder: options.resolveFolder ?? createResolveFolder({ dataHome, userHome }),
    writeFile: options.writeFileAtomic ?? defaultWriteFileAtomic,
  };
}

function scopeDriverEvent(
  sessionId: SessionId,
  event: Exclude<DriverEvent, TurnEndedEvent>,
  getMessage: (id: MessageId) => Message | null,
): Exclude<DriverEvent, TurnEndedEvent> | null {
  switch (event.type) {
    case "message.delivered":
    case "message.processing":
    case "message.cancelled":
    case "message.requeued": {
      if (event.messageIds.length === 0) return event;
      const owned = event.messageIds.filter((id) => getMessage(id)?.sessionId === sessionId);
      return owned.length === 0 ? null : { ...event, messageIds: owned };
    }
    case "session.exited":
      return { ...event, messageIds: event.messageIds.filter((id) => getMessage(id)?.sessionId === sessionId) };
    case "driver.error":
      return event.messageIds === undefined
        ? event
        : { ...event, messageIds: event.messageIds.filter((id) => getMessage(id)?.sessionId === sessionId) };
    default:
      return event;
  }
}

function reconcileTurnWorktree(
  db: Db, id: SessionId, probe: WorktreeBranchProbe | undefined, branches: ReturnType<typeof createLedgerBranchSync>, signal: AbortSignal,
) {
  if (probe === undefined) return null;
  const workerId = getAgentSession(db, id)?.workerId;
  return workerId == null ? null : branches.reconcileWorkerGraph(workerId, signal);
}

function sessionRoleOf(db: Db, sessionId: SessionId): SqliteLedger["sessionRole"] extends (id: SessionId) => infer R ? R : never {
  const s = getAgentSession(db, sessionId);
  if (s === null) return null;
  if (s.role === "pm" && s.pmId === null) return null;
  if (s.role === "worker" && s.workerId === null) return null;
  return s.role;
}

function recordsTurnCompletion(db: Db, sessionId: SessionId): boolean {
  try {
    const session = getAgentSession(db, sessionId);
    return session !== null && session.role !== "assistant" && session.conversationId !== null;
  } catch (error) {
    // Settlement checks the session again once SQLite answers.
    console.error(`${LOG_PREFIX} turn.ended (session ${sessionId}): session lookup failed, recording the outcome anyway:`, error);
    return true;
  }
}

async function driverTextMeta(
  db: Db, sentFiles: ReturnType<typeof createLedgerSentFiles>, sessionId: SessionId, event: DriverEvent, links: readonly LocalLink[], signal: AbortSignal,
) {
  if (event.type !== "agent.text" || links.length === 0) return null;
  const session = getAgentSession(db, sessionId);
  if (session === null || session.role === "assistant" || session.conversationId === null) return null;
  if (db.get("SELECT 1 AS x FROM messages WHERE dedupe_key = ?", agentMessageDedupeKey(sessionId, event.uuid)) !== undefined) return null;
  return sentFiles.metaFor(session, links, signal);
}

export function createLedger(db: Db, options: LedgerOptions): SqliteLedger {
  const ctx = createLedgerContext(db, options);
  const { log, write, subscribe, reportHealthIn, changeListeners, actionListeners, stopListeners } = ctx;
  const userHome = options.userHome ?? homedir();
  const dataHome = options.dataHome ?? dirname(options.pmHomeRoot);
  const files = buildLedgerFiles(options, userHome, dataHome);
  const taskGraphManual = (sessionId: SessionId) => taskGraphManualNote(files.launchDir, sessionId);
  const reminders = createChecklistReminders(ctx);
  const sessions = createLedgerSessions(ctx, reminders.forget);
  const { sessionState } = sessions;
  const snapshotQueries = createLedgerSnapshotQueries(db, { sessionState });
  const sentFiles = createLedgerSentFiles(db, {
    sentFilesDir: options.sentFilesDir ?? join(dataHome, "sent-files"),
    uploadsDir: options.uploadsDir ?? join(dataHome, "uploads"),
    worktreesDir: files.worktreesDir,
    ...(files.extraWorktreeRoots ? { extraWorktreeRoots: files.extraWorktreeRoots } : {}),
    dataHome,
    userHome,
    tmpDirs: options.shareTmpDirs ?? ["/tmp", tmpdir()],
  });
  const messages = createLedgerMessages(ctx, sessions, {
    assertUserCanPost: (id) => {
      persona.assertConversationNotArchived(id);
      assertWorkerOpenForUser(db, id);
    },
    afterUserPost: (p, id) => handover.userPostedIn(p, id),
    onIndependentAskCreated: (p, session, message, askOptions) => router.bridgeAskIn(p, session, message, askOptions),
    onHubChecklist: reminders.observe,
  });
  const turnReplies = createLedgerTurnReplies(ctx);
  const takenInputs = createLedgerTakenInputs(ctx);
  const persona = createLedgerPersona(ctx, sessions, messages, files, {
    switchVendorIn: (p, conversationId, agent) => handover.switchVendorIn(p, conversationId, agent),
    clearVendorSwitchIn: (conversationId) => handover.clearVendorSwitchIn(conversationId),
    cancelHandoverIn: (p, conversationId) => handover.cancelHandoverIn(p, conversationId),
    endOpenWorkersIn: (p, pmId) => workers.endOpenWorkersIn(p, pmId),
    pauseSchedulesIn: (p, pmId) => schedules.pauseAllForPmIn(p, pmId),
  });
  const projects = createLedgerProjects(ctx, sessions, messages, persona, files, (p, projectId) =>
    projectCatalog.markForcedIn(p, projectId, "project_created"),
  );
  const projectCatalog = createLedgerProjectCatalog(ctx, projects, { onCatalogClaimable: options.onCatalogClaimable });
  const router = createLedgerRouter(ctx, sessions, messages, persona, projects, projectCatalog.cardOf);
  const effectiveLaunchDir = files.launchDir ?? join(dataHome, "state", "launch");
  const userBlockers = createLedgerUserBlockers(ctx, sessions, messages, () => ({
    releaseStepsIn: taskGraphs.releaseUserBlockedStepsIn,
    notifyStepsIn: taskGraphs.notifyUserBlockedStepsIn,
    resumeWorkerIn: workers.resumeUserBlockedWorkerIn,
  }));
  const taskGraphs = createLedgerTaskGraphs(ctx, sessions, messages, persona, projects, router, {
    launchDir: effectiveLaunchDir, workerPlatform: options.workerPlatform,
    workers: () => workers,
    userBlockers,
    onGraphFinishedIn: (p, projectId) => projectCatalog.markForcedIn(p, projectId, "graph_finished"),
  });
  const steps = createLedgerSteps(ctx);
  const workers = createLedgerWorkers(ctx, sessions, messages, persona, projects, {
    worktreesDir: files.worktreesDir, platform: options.workerPlatform,
    ...(files.extraWorktreeRoots ? { extraWorktreeRoots: files.extraWorktreeRoots } : {}),
    taskGraphs,
    userBlockers,
    takeover: createLedgerTakeover(ctx, steps, { findTranscript: options.findTranscript }),
  });
  const loadedSkills = createLedgerLoadedSkills(ctx, options.skillFiles ?? createSkillFiles({ launchDir: files.launchDir, userHome }));
  const handover = createLedgerHandover(ctx, sessions, messages, persona, loadedSkills, {
    findTranscript: options.findTranscript,
    autoRenew: options.autoRenew,
    log: options.log,
    onHandoverClaimable: options.onHandoverClaimable,
    isSessionBusy: options.isSessionBusy,
    hasPendingDriverEvents: (sessionId) => driverEvents.hasPending(sessionId),
    hasPendingTurnCompletions: (sessionId) => completions.blocksSend(sessionId),
    liveActiveGraphsSection: (pmId) => taskGraphs.liveHandoverSection(pmId),
    onRenewedIn: (p, conversationId) => {
      const project = db.get<{ id: number }>("SELECT id FROM projects WHERE conversation_id = ? AND status = 'active'", conversationId);
      if (project !== undefined) projectCatalog.markForcedIn(p, project.id, "handover_switched");
    },
  });
  const schedules = createLedgerSchedules(ctx, sessions, messages, persona);
  const workerRetention = createLedgerWorkerRetention(ctx, files);
  const tableRetention = createDbTableRetention(ctx);
  const workerView = createLedgerWorkerView(ctx, steps, {
    ownWorker: workers.ownWorker,
    workerSession: workers.workerSession,
    notStarted,
    liveOf: sessions.liveOf,
    turnMaxTimeOf: workers.turnMaxTimeOf,
    isWorktreeCleaned: workers.isWorktreeCleaned,
  });
  const hub = createLedgerHubCommands(ctx, persona, projects, workers, messages, schedules, workerView, router, taskGraphs, taskGraphManual);
  const launch = createLedgerLaunchContext(db, persona, projects, workers);
  const { assertStart, init, ...capabilities } = createLedgerPmCapabilities(ctx);

  const createPm = (input: CreatePmInput): CreatePmResult =>
    write((p) => {
      if (input.capabilities !== undefined) assertStart(input.capabilities);
      const created = persona.createPmIn(p, input);
      const project = input.folder === undefined ? null : projects.createProjectIn(p, { pmId: created.pm.id, folder: input.folder }).project;
      if (input.capabilities !== undefined) init(created.pm.id, input.capabilities);
      return { ...created, project };
    });

  const closing = new AbortController();
  const branches = createLedgerBranchSync(ctx, taskGraphs.publishBranchChange, closing.signal, options.worktreeBranchProbe);
  const applyDriverEventNow = (sessionId: SessionId, event: Exclude<DriverEvent, TurnEndedEvent>, textMeta: AgentTextMeta | null) => {
    if (event.type === "agent.text_delta" || event.type === "agent.tool_preview") {
      if (event.parentToolUseId !== undefined) return;
      if (event.type === "agent.tool_preview" && isChecklistToolCall(event.name)) return;
      const session = getAgentSession(db, sessionId);
      if (session === null) return;
      if (event.type === "agent.tool_preview") sessions.applyToolPreview(session, event);
      else if (session.role !== "assistant") sessions.applyStreamingDelta(session, event);
      return;
    }
    const session = getAgentSession(db, sessionId);
    if (session === null || session.role === "assistant") return;
    write((p) => {
      const scoped = scopeDriverEvent(session.id, event, messages.getMessage);
      if (scoped === null) return;
      if (scoped.type === "agent.tool" && isChecklistToolCall(scoped.name)) {
        reminders.observe(p, session, scoped);
        return;
      }
      const openTools = scoped.type === "agent.tool_result" ? sessions.liveOf(session.id).openTools : undefined;
      takenInputs.beforeDriverEvent(session, scoped);
      const result = messages.applyEvent(p, session, scoped, textMeta);
      turnReplies.afterDriverEvent(p, session, scoped);
      steps.afterDriverEvent(session, scoped, openTools);
      if (result !== "duplicate_tool") reminders.observe(p, session, scoped);
      loadedSkills.afterDriverEvent(session, scoped);
      workers.afterDriverEvent(p, session, scoped);
      handover.afterDriverEvent(p, session, scoped);
      schedules.afterDriverEvent(p, session, scoped);
      projectCatalog.afterDriverEvent(p, session, scoped);
    });
  };

  const onOverflow = (sessionId: SessionId) => {
    const error = `Turn completion queue is full for session ${sessionId}`;
    console.error(`${LOG_PREFIX} ${error}`);
    try {
      write((p) => {
        reportHealthIn(p, "store", error);
        const session = getAgentSession(db, sessionId);
        if (session?.conversationId != null) p.stops.push({ sessionId, conversationId: session.conversationId });
      });
    } catch (failure) {
      console.error(`${LOG_PREFIX} ${error}:`, failure);
    }
  };
  const completions = createTurnCompletionLedger(ctx, {
    apply(p, receipt, facts, previousRun) {
      const session = getAgentSession(db, receipt.sessionId);
      if (session === null || session.role === "assistant" || session.conversationId === null) return;
      const event = {
        ...receipt.event,
        messageIds: [...new Set(receipt.event.messageIds)].filter((id) => {
          const msg = messages.getMessage(id);
          return msg?.sessionId === session.id && (msg.status === "delivered" || msg.status === "processing");
        }),
      };
      messages.settleTurn(p, session, event, facts);
      turnReplies.settle(p, session, receipt.event.messageIds, facts.reply);
      steps.afterDriverEvent(session, event);
      reminders.observe(p, session, event);
      if (receipt.event.messageIds.length === 0 || event.messageIds.length > 0) workers.settleTurn(p, session, event, facts.worker, previousRun);
      handover.afterDriverEvent(p, session, event);
      schedules.afterDriverEvent(p, session, event);
      projectCatalog.afterDriverEvent(p, session, event);
    },
    onSettled: (receipt) => driverEvents.onSettled(receipt),
    onOverflow,
  });
  const driverEvents = createDriverEventDrain({
    completions,
    beforeTurn: (id, signal) => reconcileTurnWorktree(db, id, options.worktreeBranchProbe, branches, signal),
    factsFor(sessionId, event) {
      const session = getAgentSession(db, sessionId)!;
      return { ...turnReplies.factsOf(session, event.messageIds), worker: workers.turnFactsOf(session, event) };
    },
    apply: applyDriverEventNow,
    localLinks: sentFiles.localLinks,
    textMetaFor: (id, event, links, signal) => driverTextMeta(db, sentFiles, id, event, links, signal),
    onOverflow,
    onSessionDrained: (sessionId) => {
      if (!closing.signal.aborted) handover.onSessionQuiescent(sessionId);
    },
  });
  return {
    postUserMessage: messages.postUserMessage,
    postedUserMessageId: messages.postedUserMessageId,
    requestStop(conversationId) {
      workers.clearMaxTime(conversationId);
      messages.requestStop(conversationId);
    },
    endWorkerConversation(conversationId) {
      write((p) => workers.endWorkerConversationIn(p, conversationId));
    },
    rewindLastUserMessage(conversationId) {
      const rewound = messages.rewindLastUserMessage(conversationId);
      if (rewound !== null) workers.clearMaxTime(conversationId);
      return rewound;
    },
    composerTarget: (conversationId) =>
      messages.composerTarget(conversationId, files.worktreesDir, files.extraWorktreeRoots?.()),

    snapshot(): LedgerSnapshot {
      const activeTaskGraphs = taskGraphs.activeSnapshotGraphs();
      const { conversations, sessions } = snapshotQueries.snapshotConversations(activeTaskGraphs);
      return {
        seq: log.seq,
        pms: db.all<PmDbRow>(`${PM_SELECT} ORDER BY p.id`).map(toPm),
        projects: db.all<ProjectDbRow>("SELECT * FROM projects WHERE status = 'active' ORDER BY id").map(toProject),
        folders: db
          .all<ProjectFolderDbRow>(
            `SELECT f.* FROM project_folders f JOIN projects p ON p.id = f.project_id
             WHERE f.removed_at IS NULL AND p.status = 'active' ORDER BY f.id`,
          )
          .map(toProjectFolder),
        conversations,
        sessions,
        health: db.all<HealthDbRow>("SELECT * FROM health ORDER BY module").map(toHealth),
        schedules: schedules.all(),
        router: router.snapshotSlice(),
        activeTaskGraphs,
        ...workers.approvalSnapshot(),
      };
    },

    messagesBefore: messages.messagesBefore,
    messagesAfter: messages.messagesAfter,
    lookupConversations: snapshotQueries.lookupConversations,
    completedWork: (pmId, cursor, limit) => completedWorkPage(db, pmId, cursor, limit),

    changesSince: (seq) => log.since(seq),
    onChange: (listener) => subscribe(changeListeners, listener),
    onStopRequested: (listener) => subscribe(stopListeners, listener),
    onActionEnqueued: (listener) => subscribe(actionListeners, listener),

    applyDriverEvent(sessionId, event) {
      if (closing.signal.aborted) {
        console.error(`${LOG_PREFIX} driver event ${event.type} (session ${sessionId}) after ledger close: dropped`);
        return;
      }
      if (event.type === "turn.ended" && !recordsTurnCompletion(db, sessionId)) return;
      driverEvents.push(sessionId, event);
    },
    settleDriverEvents: driverEvents.wait,
    async shareHubFiles(sessionId, args, signal) {
      const session = getAgentSession(db, sessionId);
      return session === null ? [] : sentFiles.filesForArgs(session, args, signal === undefined ? closing.signal : AbortSignal.any([closing.signal, signal]));
    },
    refreshSessionState: (id) => write((p) => {
      if (getAgentSession(db, id)?.status === "ended") {
        messages.stopChecklistReminderIn(p, id);
        p.after.push(() => reminders.forget(id));
      }
      sessions.updateLive(p, id, idle);
    }),
    recoverAfterRestart() {
      completions.recover();
      const recovered = sessions.recoverAfterRestart(workers.noticeUnresentShutdownTurnsIn);
      workers.recoverLifecycles();
      handover.recoverAfterRestart();
      router.recoverAfterRestart();
      return recovered;
    },

    createPm,
    archivePm: persona.archivePm,
    unarchivePm: persona.unarchivePm,
    purgeExpiredArchivedPms: persona.purgeExpiredArchivedPms,
    purgeExpiredWorkerConversations: workerRetention.purgeBatch,
    purgeGrowingTables: (nowMs = ctx.now(), maxRows = WORKER_PURGE_BATCH_ROWS) => tableRetention.purgeAllBatch(nowMs, maxRows),
    trimEndedWorkerSteps: tableRetention.trimEndedWorkerSteps,
    purgeExpiredRouterAndGraphRecords(nowMs = ctx.now(), maxRows = WORKER_PURGE_BATCH_ROWS) {
      let rows = router.purgeExpiredBatch(nowMs, maxRows);
      if (rows < maxRows) rows += taskGraphs.purgeExpiredBatch(nowMs, maxRows - rows);
      return { rows, more: rows >= maxRows };
    },

    getMessage: messages.getMessage,
    turnReplyOf: turnReplies.turnReplyOf,
    sentFileAllows(sessionId, realPath) {
      const session = getAgentSession(db, sessionId);
      return session !== null && sentFiles.allows(session, realPath);
    },
    onActionFailed(action, error) {
      write((p) => {
        const failedSession = messages.actionFailedIn(p, action, error);
        if (failedSession !== null) steps.recordFailedStart(failedSession, error);
        workers.actionFailedIn(p, action, error);
        handover.actionFailedIn(p, action);
        schedules.actionFailedIn(p, action);
      });
    },
    onSessionQuiescent(sessionId) {
      if (!closing.signal.aborted) handover.onSessionQuiescent(sessionId);
    },
    stopMessage: messages.stopMessage,
    turnsLostOnShutdown: messages.turnsLostOnShutdown,

    reportHealth(module, error) {
      write((p) => reportHealthIn(p, module, error));
    },

    getPersona: (pmId) => persona.getPersona(pmId),
    listPmMemoryFiles: persona.listPmMemoryFiles,
    getPmMemoryFile: persona.getPmMemoryFile,
    putPmMemoryFile: persona.putPmMemoryFile,
    deletePmMemoryFile: persona.deletePmMemoryFile,
    ...capabilities,
    setProjectSetupCommand: (projectId, command) => write((p) => projects.setSetupCommandIn(p, projectId, command)),
    setPmLook: persona.setPmLook,
    ...createLedgerPmPins(ctx, persona),
    pmProjectMainFolder(pmId) {
      persona.requirePm(pmId);
      const proj = projects.activeProjectOf(pmId);
      if (proj === null) return null;
      const main = projects.projectCard(proj).mainFolder;
      return main === "" ? null : main;
    },

    editPersona: persona.editPersona,

    revertPersonaChange: persona.revertPersonaChange,

    retryMessage: messages.retryMessage,
    renewSession: handover.renewSession,
    waitsForHandover: handover.waitsForHandover,
    runAutoRenew: handover.runAutoRenew,
    sessionPreamble: handover.sessionPreamble,
    claimHandover: handover.claimHandover,
    handoverForked: handover.handoverForked,
    handoverWritten: handover.handoverWritten,
    handoverFailed: handover.handoverFailed,
    handoverCleaned: handover.handoverCleaned,
    uncleanedHandovers: handover.uncleanedHandovers,

    hubCall: hub.hubCall,
    sessionRole: (sessionId) => sessionRoleOf(db, sessionId),
    workerStartFolder: (sessionId) => workers.workerStartFolder(getAgentSession(db, sessionId)),
    workerPrTarget: (sessionId, workerId) => workers.workerPrTarget(getAgentSession(db, sessionId), workerId),
    workerTranscriptTarget: (sessionId, workerId) => workers.workerTranscriptTarget(getAgentSession(db, sessionId), workerId),
    ...branches,
    isSystemMessageCurrent: (id) => isSystemMessageCurrent(db, id, ctx.now(), workers.isWorkerInFlight),
    retireStaleSystemMessage: messages.retireStaleSystemMessage,
    graphPrTargets: (sessionId, graphId) => taskGraphs.graphPrTargets(getAgentSession(db, sessionId), graphId),
    graphAutoDispatchVendors: (sessionId, command, body) =>
      taskGraphs.graphAutoDispatchVendors(getAgentSession(db, sessionId), command, body),
    graphDeliveryProbeTarget: taskGraphs.graphDeliveryProbeTarget,
    enrichDeliveryNoteMessage: taskGraphs.enrichDeliveryNoteMessage,

    runDueSchedules: schedules.runDueSchedules,
    addSchedule: schedules.addForUser,
    setScheduleEnabled: schedules.setEnabledForUser,
    removeSchedule: schedules.removeForUser,

    getLaunchContext: launch.getLaunchContext,
    personaUpdate: persona.personaUpdate,
    getWorktreeTask: workers.getWorktreeTask,
    onSetupStarted: workers.onSetupStarted,
    waitsForTurnCompletion: completions.blocksSend,
    waitsForFirstTurn: workers.waitsForFirstTurn,
    onWorktreeCreated: workers.onWorktreeCreated,
    recordReviewSnapshot: workers.recordReviewSnapshot,
    getReviewVerifyTask: workers.getReviewVerifyTask,
    onReviewVerified: workers.onReviewVerified,

    syncPersonaFiles: persona.syncPersonaFiles,
    listEndedWorktreeWorkers: workers.listEndedWorktreeWorkers,
    isWorkerCleanable: workers.isWorkerCleanable,
    getRouterDigest: router.getDigest,
    getRouterSettings: router.getSettings,
    listRouterItems: router.listItems,
    resolveRouterItem: router.resolveItem,
    answerAsk: router.answerAsk,
    recheckUserBlocker: userBlockers.recheck, decideSandboxApproval: workers.decide, getSandboxApproval: workers.getById,
    appApprovals: workers.appApprovals, decideAppApproval: workers.decideAppApproval, userBlockerVendor: userBlockers.vendorOf,
    deliveryOf: (message) => {
      const parts = deliveryParts(message);
      if (message.sender !== "user" || message.workerId !== null) return parts;
      const pmId = db.get<{ pm_id: PmId | null }>("SELECT pm_id FROM conversations WHERE id = ? AND kind = 'pm'", message.conversationId)?.pm_id;
      if (pmId == null) return parts;
      const note = pendingAsksNote(pendingAsksOfPm(db, pmId), ctx.now());
      return note === null ? parts : { ...parts, prefixes: [...parts.prefixes, note] };
    },
    archiveAllRouterReports: router.archiveAllReports,
    updateRouterSettings: router.updateSettings,
    createRouterCommand: router.createCommand,
    updateRouterCommand: router.updateCommand,
    claimRouterCommandRetry: router.claimCommandRetry,
    routerCommandDeliveries: router.commandDeliveries,
    getRouterCommand: router.getCommand,
    getRouterItem: router.getItem,
    listRouterCommands: router.listCommands,
    createRouterAssistantSession: router.createAssistantSession,
    endRouterAssistantSession: router.endAssistantSession,
    recordRouterWorkerOrigin: router.recordWorkerOrigin,
    resolveRouterLocalPmOrProject: router.resolveLocalPmOrProject,
    resolveRouterLocalWorker: router.resolveLocalWorker,
    listRouterLocalWorkers: router.listLocalWorkers,
    projectCatalog: {
      scanAtStartup: projectCatalog.scanAtStartup,
      claimCatalog: projectCatalog.claimCatalog,
      catalogWritten: projectCatalog.catalogWritten,
      catalogFailed: projectCatalog.catalogFailed,
      cardOf: projectCatalog.cardOf,
      detailOf: projectCatalog.detailOf,
      hasQueued: projectCatalog.hasQueued,
    },
    decideTaskNode: taskGraphs.decideNode,
    skipTaskNode: taskGraphs.skipNode,
    cancelTaskGraph: taskGraphs.cancelGraph,
    close(): void {
      closing.abort();
      driverEvents.close();
      completions.close();
      reminders.close();
      workers.closeLifecycles();
    },
  };
}
