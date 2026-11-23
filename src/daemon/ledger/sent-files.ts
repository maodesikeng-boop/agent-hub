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
  tmpDirs: string[];
}

export function createLedgerSentFiles(db: Db, opts: SentFilesOptions) {
  const ioSlots = createSentFileIoSlots();
  const projectOf = (session: AgentSessionRow): number | null => {
    if (session.workerId !== null) {
      return db.get<{ project_id: number }>("SELECT project_id FROM workers WHERE id = ?", session.workerId)?.project_id ?? null;
    }
    if (session.pmId !== null) {
      return db.get<{ id: number }>("SELECT id FROM projects WHERE pm_id = ? AND status = 'active'", session.pmId)?.id ?? null;
    }
    return null;
  };

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

  const localLinks = (text: string): LocalLink[] => localLinksIn(text);

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

  const allows = (session: AgentSessionRow, realPath: string): boolean => isShareable(realPath, scopeFor(session));

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
