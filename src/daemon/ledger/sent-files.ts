// agent 的文字消息入库时，给回复里指向本机文件的链接存副本（daemon/sent-files.ts），算出消息的 meta（AgentTextMeta）。
// 这里只管“这个会话能分享哪些文件夹”：所属项目的全部文件夹、本项目的 worktrees 目录、会话自己的 cwd 和 addDirs、
// uploads、临时目录；数据目录里只认 uploads 和本项目的 worktrees。
import type { AgentTextMeta } from "../../shared/sent-files.ts";
import type { AgentSessionRow } from "../../shared/domain.ts";
import { LOG_PREFIX } from "../../shared/names.ts";
import { projectWorktreesDir } from "../../shared/paths.ts";
import { normalizePathForComparison } from "../platform/index.ts";
import { isShareable, shareLinkedFiles, type ShareScope } from "../sent-files.ts";
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
    };
  };

  /** 回复里有本机文件链接就存副本、返回 { files }；没有返回 null（meta 照旧是 null）。出了意外只记日志，消息照样入库。 */
  const metaFor = (session: AgentSessionRow, text: string): AgentTextMeta | null => {
    if (!text.includes("](") && !text.includes("<")) return null;
    try {
      const files = shareLinkedFiles(text, scopeFor(session));
      return files.length === 0 ? null : { files };
    } catch (error) {
      console.error(`${LOG_PREFIX} sent files:`, error);
      return null;
    }
  };

  /** 这个路径（已 realpath）现在还能不能分享给这个会话的用户（见 Ledger.sentFileAllows）。 */
  const allows = (session: AgentSessionRow, realPath: string): boolean => isShareable(realPath, scopeFor(session));

  return { metaFor, allows };
}
