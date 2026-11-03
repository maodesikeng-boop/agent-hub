// 账本（设计第 6.2 节）：业务表的唯一写者。每个命令一个事务，提交之后才推变化、通知新登记的动作。
// 这里只把各部分拼成 Ledger：
// - context.ts：事务（write）、动作登记、健康状态等共用的东西；
// - sessions.ts：会话状态、建会话、换代（nextGeneration）、重启恢复；
// - messages.ts：消息、驱动层事件、系统消息；
// - persona.ts：项目经理、性格设定和性格设定文件；
// - projects.ts：项目（每个项目经理最多一个，挂在它唯一的对话上）、文件夹；
// - hub-commands.ts：hub 命令；
// - launch-context.ts：启动 claude 前给提示词用的上下文。
// 11-03 拿掉了项目群：快照不给老的项目群和归档的项目（数据还在库里，见迁移 0003）。
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { ConversationSnapshot, StateSnapshot } from "../../shared/api.ts";
import type { CreatePmInput, CreatePmResult, Ledger, ResolveFolder } from "../../shared/ledger.ts";
import { MESSAGE_PAGE_SIZE } from "../../shared/limits.ts";
import { toAgentSessionRow } from "../store/index.ts";
import type { AgentSessionDbRow, Db } from "../store/index.ts";
import { createLedgerContext } from "./context.ts";
import type { LedgerFiles } from "./context.ts";
import { createResolveFolder, writeFileAtomic as defaultWriteFileAtomic } from "./files.ts";
import { createLedgerHubCommands } from "./hub-commands.ts";
import { createLedgerLaunchContext } from "./launch-context.ts";
import { createLedgerMessages } from "./messages.ts";
import { createLedgerPersona } from "./persona.ts";
import { createLedgerProjects } from "./projects.ts";
import { toConversation, toHealth, toPm, toProject, toProjectFolder } from "./rows.ts";
import type { ConversationDbRow, HealthDbRow, MessageDbRow, PmDbRow, ProjectDbRow, ProjectFolderDbRow } from "./rows.ts";
import { createLedgerSessions } from "./sessions.ts";

export type SqliteLedger = Ledger;

export interface LedgerOptions {
  now?: () => number;
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
  /** 展开 `~` 用（默认 resolveFolder、detach 退回字面路径时），默认 os.homedir()。 */
  userHome?: string;
  /** 文件夹校验，默认 createResolveFolder({ dataHome, userHome })。 */
  resolveFolder?: ResolveFolder;
  /** 写性格设定文件（临时文件 + 改名）。测试换成会失败的。 */
  writeFileAtomic?: (file: string, content: string) => void;
}

export function createLedger(db: Db, options: LedgerOptions): SqliteLedger {
  const ctx = createLedgerContext(db, options);
  const { log, write, subscribe, reportHealthIn, changeListeners, actionListeners, stopListeners } = ctx;
  const userHome = options.userHome ?? homedir();
  const dataHome = options.dataHome ?? dirname(options.pmHomeRoot);
  const files: LedgerFiles = {
    pmHomeRoot: options.pmHomeRoot,
    personasDir: options.personasDir,
    userHome,
    resolveFolder: options.resolveFolder ?? createResolveFolder({ dataHome, userHome }),
    writeFile: options.writeFileAtomic ?? defaultWriteFileAtomic,
  };
  const sessions = createLedgerSessions(ctx);
  const { sessionState } = sessions;
  const messages = createLedgerMessages(ctx, sessions);
  const { page } = messages;
  const persona = createLedgerPersona(ctx, sessions, messages, files);
  const projects = createLedgerProjects(ctx, sessions, messages, persona, files);
  const hub = createLedgerHubCommands(ctx, persona, projects);
  const launch = createLedgerLaunchContext(persona, projects);

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
      };
    },

    messagesBefore: messages.messagesBefore,

    changesSince: (seq) => log.since(seq),
    onChange: (listener) => subscribe(changeListeners, listener),
    onStopRequested: (listener) => subscribe(stopListeners, listener),
    onActionEnqueued: (listener) => subscribe(actionListeners, listener),

    applyDriverEvent: messages.applyDriverEvent,
    refreshSessionState: sessions.refreshSessionState,
    recoverAfterRestart: sessions.recoverAfterRestart,

    createPm,

    getMessage: messages.getMessage,
    onActionFailed: messages.onActionFailed,
    stopMessage: messages.stopMessage,

    reportHealth(module, error) {
      write((p) => reportHealthIn(p, module, error));
    },

    getPersona: persona.getPersona,

    editPersona: persona.editPersona,

    revertPersonaChange: persona.revertPersonaChange,

    retryMessage: messages.retryMessage,

    hubCall: hub.hubCall,

    getLaunchContext: launch.getLaunchContext,

    syncPersonaFiles: persona.syncPersonaFiles,
  };
}
