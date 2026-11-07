// 账本（设计第 6.2 节）：业务表的唯一写者。每个命令一个事务，提交之后才推变化、通知新登记的动作。
// 这里只把各部分拼成 Ledger：
// - context.ts：事务（write）、动作登记、健康状态等共用的东西；
// - sessions.ts：会话状态（推给网页的 session.status）、建会话、重启恢复；
// - messages.ts：消息、驱动层事件、系统消息；
// - persona.ts：项目经理、性格设定和性格设定文件；
// - projects.ts：项目（每个项目经理最多一个，挂在它唯一的对话上）、文件夹；
// - hub-commands.ts：hub 命令；
// - handover.ts：换新会话（后台写交接的状态机、换代；跑腿的在 daemon/handover/runner.ts）；
// - workers.ts：Worker（M3）：派活、打回、收工、汇报回到项目经理、建 worktree 的回调；
// - steps.ts、worker-view.ts：会话一步一步干了什么（session_steps）、hub worker show / log 怎么讲给项目经理；
// - schedules.ts：定时任务（M6）：hub schedule 命令、到点往项目经理的对话发消息、这一轮没跑成的记录；
// - launch-context.ts：启动 claude 前给提示词用的上下文。
// 11-03 拿掉了项目群：快照不给老的项目群和归档的项目（数据还在库里，见迁移 0003）。
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ConversationSnapshot, StateSnapshot } from "../../shared/api.ts";
import type { CreatePmInput, CreatePmResult, Ledger, ResolveFolder } from "../../shared/ledger.ts";
import { MESSAGE_PAGE_SIZE } from "../../shared/limits.ts";
import type { AgentVendor, ModelCatalog } from "../../shared/vendors.ts";
import { getAgentSession, toAgentSessionRow } from "../store/index.ts";
import type { AgentSessionDbRow, Db } from "../store/index.ts";
import { createLedgerContext } from "./context.ts";
import type { LedgerContextOptions, LedgerFiles } from "./context.ts";
import { createResolveFolder, writeFileAtomic as defaultWriteFileAtomic } from "./files.ts";
import { createLedgerHandover } from "./handover.ts";
import type { HandoverOptions } from "./handover.ts";
import { createLedgerHubCommands } from "./hub-commands.ts";
import { createLedgerLaunchContext } from "./launch-context.ts";
import { createLedgerMessages } from "./messages.ts";
import { createLedgerPersona } from "./persona.ts";
import { createLedgerProjects } from "./projects.ts";
import { toConversation, toHealth, toPm, toProject, toProjectFolder } from "./rows.ts";
import type { ConversationDbRow, HealthDbRow, MessageDbRow, PmDbRow, ProjectDbRow, ProjectFolderDbRow } from "./rows.ts";
import { createLedgerSchedules } from "./schedules.ts";
import { createLedgerSentFiles } from "./sent-files.ts";
import { createLedgerSessions } from "./sessions.ts";
import { createLedgerSteps } from "./steps.ts";
import { createLedgerWorkerView } from "./worker-view.ts";
import { assertWorkerOpenForUser, createLedgerWorkers, notStarted } from "./workers.ts";

export type SqliteLedger = Ledger;

export interface LedgerOptions {
  now?: () => number;
  /** 现在缓存着的模型名单（ModelCatalogs.current）：系统消息、hub 输出里的模型名用它的显示名。不给用打包的。 */
  modelCatalog?: (vendor: AgentVendor) => ModelCatalog | null;
  /** 缓存着的这个会话的完整命令列表（CommandCatalogs.cached）：手打命令时，列表里这个名字是用户自己的就不拦。没缓存、不给都按名字拦。 */
  knownCommands?: LedgerContextOptions["knownCommands"];
  /** 本次启动的初始 seq，默认启动时刻的毫秒时间戳（比上次运行用过的都大）。 */
  initialSeq?: number;
  changeBufferSize?: number;
  /** pm-home/ 的根目录；还没有项目的项目经理，会话的工作目录是 <pmHomeRoot>/<项目经理编号>/，createPm 负责建。必填。 */
  pmHomeRoot: string;
  /**
   * state/personas/（HubPaths.personasDir）。不给就不写、不同步性格设定文件（只给不碰性格设定的旧测试用），
   * 正文照样以数据库为准。守护进程一定要给。
   */
  personasDir?: string;
  /** 数据目录（HubPaths.home），默认 resolveFolder 用它拒绝数据目录里的文件夹。默认 pmHomeRoot 的上一级（同 HubPaths 的布局）。 */
  dataHome?: string;
  /**
   * worktrees/ 的根目录（HubPaths.worktreesDir，M3）：Worker 的 worktree 是 <worktreesDir>/<项目编号>/<Worker 编号>/，
   * 有项目的项目经理的会话 addDirs 带上 <worktreesDir>/<项目编号>/（见 shared/ledger.ts 的 LaunchContext）。
   * 默认 <dataHome>/worktrees（同 HubPaths 的布局），守护进程（W5）显式传。
   */
  worktreesDir?: string;
  /** agent 发给用户的文件存副本的地方（HubPaths.sentFilesDir），默认 <dataHome>/sent-files。 */
  sentFilesDir?: string;
  /** 聊天框上传的文件（HubPaths.uploadsDir），默认 <dataHome>/uploads：agent 也能把它们发回给用户。 */
  uploadsDir?: string;
  /** agent 能发给用户的临时目录，默认 /tmp 和 os.tmpdir()。测试的临时目录都在 os.tmpdir() 下，测“不在允许的文件夹里”时传空。 */
  shareTmpDirs?: string[];
  /** 展开 `~` 用（默认 resolveFolder、detach 退回字面路径时），默认 os.homedir()。 */
  userHome?: string;
  /** 文件夹校验，默认 createResolveFolder({ dataHome, userHome })。 */
  resolveFolder?: ResolveFolder;
  /** 写性格设定文件（临时文件 + 改名）。测试换成会失败的。 */
  writeFileAtomic?: (file: string, content: string) => void;
  /** 找会话的原始记录（交接提示词里写路径），守护进程传 driver/transcript.ts 的 vendorTranscriptPath；不给都当找不到。 */
  findTranscript?: HandoverOptions["findTranscript"];
  /** 自动换新会话的门槛、空闲多久、写交接最多多久（默认见 limits.ts）；冒烟测试改小。 */
  autoRenew?: HandoverOptions["autoRenew"];
  /** 写守护进程日志（目前只有自动换新会话试满了次数时写一条）；不给不写。 */
  log?: (line: string) => void;
  /** 有交接可以领了（后台写交接）：守护进程接到 daemon/handover/runner.ts 的 wake；不给什么都不做。 */
  onHandoverClaimable?: HandoverOptions["onHandoverClaimable"];
}

export function createLedger(db: Db, options: LedgerOptions): SqliteLedger {
  const ctx = createLedgerContext(db, options);
  const { log, write, subscribe, reportHealthIn, changeListeners, actionListeners, stopListeners } = ctx;
  const userHome = options.userHome ?? homedir();
  const dataHome = options.dataHome ?? dirname(options.pmHomeRoot);
  const files: LedgerFiles = {
    pmHomeRoot: options.pmHomeRoot,
    personasDir: options.personasDir,
    worktreesDir: options.worktreesDir ?? join(dataHome, "worktrees"),
    userHome,
    resolveFolder: options.resolveFolder ?? createResolveFolder({ dataHome, userHome }),
    writeFile: options.writeFileAtomic ?? defaultWriteFileAtomic,
  };
  const sessions = createLedgerSessions(ctx);
  const { sessionState } = sessions;
  const sentFiles = createLedgerSentFiles(db, {
    sentFilesDir: options.sentFilesDir ?? join(dataHome, "sent-files"),
    uploadsDir: options.uploadsDir ?? join(dataHome, "uploads"),
    worktreesDir: files.worktreesDir,
    dataHome,
    userHome,
    tmpDirs: options.shareTmpDirs ?? ["/tmp", tmpdir()],
  });
  // Worker 收工、还没开工时用户不能往它的对话里发（workers.ts）
  // 用户发了消息、项目经理正在本会话写交接：停掉那一轮（handover.ts；handover 在下面建，这里只在调用时用）
  const messages = createLedgerMessages(ctx, sessions, sentFiles, {
    assertUserCanPost: (id) => assertWorkerOpenForUser(db, id),
    afterUserPost: (p, id) => handover.userPostedIn(p, id),
  });
  const { page } = messages;
  const persona = createLedgerPersona(ctx, sessions, messages, files);
  const projects = createLedgerProjects(ctx, sessions, messages, persona, files);
  const workers = createLedgerWorkers(ctx, sessions, messages, persona, projects, { worktreesDir: files.worktreesDir });
  const handover = createLedgerHandover(ctx, sessions, messages, persona, { findTranscript: options.findTranscript, autoRenew: options.autoRenew, log: options.log, onHandoverClaimable: options.onHandoverClaimable });
  const schedules = createLedgerSchedules(ctx, sessions, messages, persona);
  const steps = createLedgerSteps(ctx);
  const workerView = createLedgerWorkerView(ctx, steps, {
    ownWorker: workers.ownWorker,
    workerSession: workers.workerSession,
    notStarted,
    liveOf: sessions.liveOf,
  });
  const hub = createLedgerHubCommands(ctx, persona, projects, workers, messages, schedules, workerView);
  const launch = createLedgerLaunchContext(db, persona, projects, workers);

  /** 建项目经理；给了主文件夹就在同一个事务里给它建项目（同 hub project create）。 */
  const createPm = (input: CreatePmInput): CreatePmResult =>
    write((p) => {
      const created = persona.createPmIn(p, input);
      const project = input.folder === undefined ? null : projects.createProjectIn(p, { pmId: created.pm.id, folder: input.folder }).project;
      return { ...created, project };
    });

  return {
    postUserMessage: messages.postUserMessage,
    requestStop: messages.requestStop,
    composerTarget: (conversationId) => messages.composerTarget(conversationId, files.worktreesDir),

    snapshot(): StateSnapshot {
      const conversations: ConversationSnapshot[] = db
        .all<ConversationDbRow>("SELECT * FROM conversations WHERE kind != 'project_group' ORDER BY id")
        .map((row) => {
          const { messages, hasMore } = page(
            db.all<MessageDbRow>("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?", row.id, MESSAGE_PAGE_SIZE + 1),
          );
          return { conversation: toConversation(row), messages, hasMore };
        });
      return {
        seq: log.seq,
        pms: db.all<PmDbRow>("SELECT * FROM pms ORDER BY id").map(toPm),
        projects: db.all<ProjectDbRow>("SELECT * FROM projects WHERE status = 'active' ORDER BY id").map(toProject),
        folders: db
          .all<ProjectFolderDbRow>(
            `SELECT f.* FROM project_folders f JOIN projects p ON p.id = f.project_id
             WHERE f.removed_at IS NULL AND p.status = 'active' ORDER BY f.id`,
          )
          .map(toProjectFolder),
        conversations,
        sessions: db
          .all<AgentSessionDbRow>(
            `SELECT s.* FROM agent_sessions s LEFT JOIN conversations c ON c.id = s.conversation_id
             WHERE c.kind IS NULL OR c.kind != 'project_group' ORDER BY s.id`,
          )
          .map((r) => sessionState(toAgentSessionRow(r))),
        health: db.all<HealthDbRow>("SELECT * FROM health ORDER BY module").map(toHealth),
        schedules: schedules.all(),
      };
    },

    messagesBefore: messages.messagesBefore,

    changesSince: (seq) => log.since(seq),
    onChange: (listener) => subscribe(changeListeners, listener),
    onStopRequested: (listener) => subscribe(stopListeners, listener),
    onActionEnqueued: (listener) => subscribe(actionListeners, listener),

    // Worker 的会话这一轮结束：同一个事务里给项目经理发那一行（workers.ts）；项目经理写完交接：同一个事务里换代（handover.ts）
    applyDriverEvent(sessionId, event) {
      const session = getAgentSession(db, sessionId);
      if (session === null) return;
      write((p) => {
        messages.applyEvent(p, session, event);
        steps.afterDriverEvent(session, event);
        workers.afterDriverEvent(p, session, event);
        handover.afterDriverEvent(p, session, event);
        schedules.afterDriverEvent(p, event);
      });
    },
    refreshSessionState: sessions.refreshSessionState,
    // 消息的重发（sessions.ts），再把还没开工的 worktree Worker 重新登记建 worktree（workers.ts：准备命令被关机打断的从头再跑），
    // 上次还在复制、写的交接记失败重新排队（handover.ts）
    recoverAfterRestart() {
      const recovered = sessions.recoverAfterRestart();
      workers.recoverWorktrees();
      handover.recoverAfterRestart();
      return recovered;
    },

    createPm,

    getMessage: messages.getMessage,
    sentFileAllows(sessionId, realPath) {
      const session = getAgentSession(db, sessionId);
      return session !== null && sentFiles.allows(session, realPath);
    },
    // 消息标 failed（messages.ts），Worker 的再给项目经理发一行（workers.ts），同一个事务
    onActionFailed(action, error) {
      write((p) => {
        messages.actionFailedIn(p, action, error);
        workers.actionFailedIn(p, action, error);
        handover.actionFailedIn(p, action);
        schedules.actionFailedIn(p, action);
      });
    },
    stopMessage: messages.stopMessage,

    reportHealth(module, error) {
      write((p) => reportHealthIn(p, module, error));
    },

    getPersona: persona.getPersona,

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
    workerStartFolder: (sessionId) => workers.workerStartFolder(getAgentSession(db, sessionId)),
    workerPrTarget: (sessionId, workerId) => workers.workerPrTarget(getAgentSession(db, sessionId), workerId),
    workerTranscriptTarget: (sessionId, workerId) => workers.workerTranscriptTarget(getAgentSession(db, sessionId), workerId),

    runDueSchedules: schedules.runDueSchedules,
    addSchedule: schedules.addForUser,
    setScheduleEnabled: schedules.setEnabledForUser,
    removeSchedule: schedules.removeForUser,

    getLaunchContext: launch.getLaunchContext,
    personaUpdate: persona.personaUpdate,
    getWorktreeTask: workers.getWorktreeTask,
    onSetupStarted: workers.onSetupStarted,
    waitsForFirstTurn: workers.waitsForFirstTurn,
    onWorktreeCreated: workers.onWorktreeCreated,

    syncPersonaFiles: persona.syncPersonaFiles,
  };
}
