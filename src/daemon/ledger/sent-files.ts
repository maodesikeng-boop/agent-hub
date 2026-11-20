// agent 的文字消息入库时，给回复里指向本机文件的链接存副本（daemon/sent-files.ts），算出消息的 meta（AgentTextMeta）。
// 这里只管“这个会话能分享哪些文件夹”：所属项目的全部文件夹、本项目的 worktrees 目录、会话自己的 cwd 和 addDirs、
// uploads、临时目录；数据目录里只认 uploads 和本项目的 worktrees。
// 存副本是异步的（大文件分块拷）：调用方先 await 拿到 meta / files，再开写事务入库，事务里不碰文件。
import type { HubFileArg } from "../../shared/deliverables.ts";
import type { AgentTextMeta, SentFile } from "../../shared/sent-files.ts";
import type { AgentSessionRow } from "../../shared/domain.ts";
import { LOG_PREFIX } from "../../shared/names.ts";
import { projectWorktreesDir } from "../../shared/paths.ts";
import { normalizePathForComparison } from "../platform/index.ts";
import {
  createSentFileIoSlots,
  isShareable,
  localLinksIn,
  shareFilePaths,
  shareLinkedFiles,
  type LocalLink,
  type ShareScope,
} from "../sent-files.ts";
import type { Db } from "../store/index.ts";

export interface SentFilesOptions {
  sentFilesDir: string;
  uploadsDir: string;
  worktreesDir: string;
  extraWorktreeRoots?: () => readonly string[];
  dataHome: string;
  userHome: string;
  /** /tmp 和系统临时目录（LedgerOptions.shareTmpDirs 的默认值）。 */
  tmpDirs: string[];
}

export type LedgerSentFiles = ReturnType<typeof createLedgerSentFiles>;

export function createLedgerSentFiles(db: Db, opts: SentFilesOptions) {
  const ioSlots = createSentFileIoSlots();
  /** 会话属于哪个项目：Worker 看 workers 表，项目经理看它进行中的项目；没有项目是 null。 */
  const projectOf = (session: AgentSessionRow): number | null => {
    if (session.workerId !== null) {
      return db.get<{ project_id: number }>("SELECT project_id FROM workers WHERE id = ?", session.workerId)?.project_id ?? null;
    }
    if (session.pmId !== null) {
      return db.get<{ id: number }>("SELECT id FROM projects WHERE pm_id = ? AND status = 'active'", session.pmId)?.id ?? null;
    }
    return null;
  };

  /** 这个会话能分享哪些文件夹（副本放哪、相对路径按什么解析也在里面）。 */
  const scopeFor = (session: AgentSessionRow): ShareScope => {
    const projectId = projectOf(session);
    const folders =
      projectId === null
        ? []
        : db.all<{ path: string }>("SELECT path FROM project_folders WHERE project_id = ? AND removed_at IS NULL", projectId).map((r) => r.path);
    const worktrees: string[] = [];
    if (projectId !== null) {
      const seen = new Set<string>();
      for (const root of [opts.worktreesDir, ...(opts.extraWorktreeRoots?.() ?? [])]) {
        const dir = projectWorktreesDir(root, projectId);
        const key = normalizePathForComparison(dir);
        if (!seen.has(key)) {
          seen.add(key);
          worktrees.push(dir);
        }
      }
    }
    return {
      sentFilesDir: opts.sentFilesDir,
      cwd: session.cwd,
      userHome: opts.userHome,
      roots: [...folders, ...worktrees, session.cwd, ...session.addDirs, opts.uploadsDir, ...opts.tmpDirs],
      dataHome: opts.dataHome,
      dataExceptions: [opts.uploadsDir, ...worktrees],
      io: { slots: ioSlots, owner: session.id },
    };
  };

  /** 回复里写成本机路径的链接（只解析，不碰文件）；空数组表示这条回复不用存副本，可以直接入库。 */
  const localLinks = (text: string): LocalLink[] => localLinksIn(text);

  /** 给这些链接存副本、返回 { files }；一个都不算、signal 取消了返回 null（meta 照旧是 null）。出了意外只记日志，消息照样入库。 */
  const metaFor = async (session: AgentSessionRow, links: readonly LocalLink[], signal: AbortSignal): Promise<AgentTextMeta | null> => {
    if (links.length === 0) return null;
    try {
      const files = await shareLinkedFiles(links, scopeFor(session), signal);
      return files.length === 0 ? null : { files };
    } catch (error) {
      console.error(`${LOG_PREFIX} sent files:`, error);
      return null;
    }
  };

  /** 这个路径（已 realpath）现在还能不能分享给这个会话的用户（见 Ledger.sentFileAllows）。 */
  const allows = (session: AgentSessionRow, realPath: string): boolean => isShareable(realPath, scopeFor(session));

  /**
   * hub ask / router report 的 --file：按这个会话能分享的文件夹存副本，规则和回复里的链接一样（daemon/sent-files.ts）。
   * 后置：返回的 files 和 args 一一对应、顺序相同（没存下的 status 不是 "saved"）；args 为空返回空数组。不抛错，单个文件出错、signal 取消记成 unreadable。
   */
  const filesForArgs = async (session: AgentSessionRow, args: readonly HubFileArg[], signal: AbortSignal): Promise<SentFile[]> => {
    if (args.length === 0) return [];
    return shareFilePaths(
      args.map((a) => a.path),
      scopeFor(session),
      signal,
    );
  };

  return { localLinks, metaFor, allows, filesForArgs };
}
