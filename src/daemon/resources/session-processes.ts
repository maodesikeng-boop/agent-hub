// Invariant: automatic reaping only stops a session's descendants that run inside that session's own folders; anything else it started stays running until the user decides in Resources.
import type { SessionId } from "../../shared/domain.ts";
import {
  reapTaggedProcesses,
  runsInsideRoots,
  scanTaggedProcesses,
  type ListTaggedProcessesOptions,
  type ReapTaggedProcessesOptions,
  type TaggedProcessInfo,
} from "../platform/index.ts";
import type { SessionTmpStore } from "../session-tmp.ts";
import type { Db } from "../store/index.ts";

export interface SessionProcess {
  readonly pid: number;
  readonly sessionId: SessionId | null;
  readonly tag: string;
  readonly command: string;
  readonly cwd: string | null;
  readonly sessionPrivate: boolean;
}

export interface SessionProcessReaper {
  /**
   * Precondition: sessionId has ended or is ending and its agent process has exited.
   * Postcondition: stops the session's tagged descendants that run inside its working directory or a temp dir of this daemon; leaves the rest running.
   */
  reapSession(sessionId: SessionId): Promise<number[]>;

  /**
   * Precondition: activeSessionIds holds every live session and runningWatchIds every watch whose command the runner is running.
   * Postcondition: lists processes tagged by this daemon whose session or watch run is over, or null when the process table could not be read.
   */
  listEnded(activeSessionIds: ReadonlySet<number>, runningWatchIds: ReadonlySet<number>): Promise<SessionProcess[] | null>;

  /**
   * Precondition: the user chose to stop pid.
   * Postcondition: stops pid (and the group it leads) only if it still carries tag; returns whether it exited.
   */
  reapOne(pid: number, tag: string): Promise<boolean>;
}

export interface SessionProcessReaperOptions {
  readonly db: Db;
  readonly tagNonce: string;
  readonly ownerTag: (sessionId: SessionId) => string;
  readonly sessionTmp: Pick<SessionTmpStore, "get" | "isSessionTmpPath">;
  readonly platform?: ListTaggedProcessesOptions & ReapTaggedProcessesOptions;
}

function parseIdFromTag(tag: string, pattern: RegExp): number | null {
  const match = pattern.exec(tag);
  if (match === null) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

const parseSessionIdFromTag = (tag: string): SessionId | null => parseIdFromTag(tag, /^s([1-9]\d*):/);
const parseWatchIdFromTag = (tag: string): number | null => parseIdFromTag(tag, /^watch([1-9]\d*):/);

export function createSessionProcessReaper(options: SessionProcessReaperOptions): SessionProcessReaper {
  const { db, tagNonce, ownerTag, sessionTmp } = options;

  const sessionRoots = (sessionId: SessionId): string[] => {
    const cwd = db.get<{ cwd: string }>("SELECT cwd FROM agent_sessions WHERE id = ?", sessionId)?.cwd;
    const tmp = sessionTmp.get(sessionId);
    return [cwd, tmp].filter((p): p is string => typeof p === "string" && p !== "");
  };

  const isSessionPrivate = (proc: Pick<TaggedProcessInfo, "cwd">, roots: readonly string[]): boolean =>
    proc.cwd !== null && (sessionTmp.isSessionTmpPath(proc.cwd) || runsInsideRoots(proc, roots));

  return {
    async reapSession(sessionId) {
      const roots = sessionRoots(sessionId);
      const result = await reapTaggedProcesses(ownerTag(sessionId), { ...options.platform, select: (proc) => isSessionPrivate(proc, roots) });
      return [...result.reapedPids];
    },

    async listEnded(activeSessionIds, runningWatchIds) {
      const found = await scanTaggedProcesses(`:${tagNonce}`, options.platform);
      if (found === null) return null;
      const rootsBySession = new Map<SessionId, string[]>();
      const rootsOf = (sessionId: SessionId) => {
        let roots = rootsBySession.get(sessionId);
        if (roots === undefined) {
          roots = sessionRoots(sessionId);
          rootsBySession.set(sessionId, roots);
        }
        return roots;
      };
      return found.flatMap((proc): SessionProcess[] => {
        const sessionId = parseSessionIdFromTag(proc.tag);
        if (sessionId !== null && activeSessionIds.has(sessionId)) return [];
        const watchId = parseWatchIdFromTag(proc.tag);
        if (watchId !== null && runningWatchIds.has(watchId)) return [];
        const sessionPrivate = isSessionPrivate(proc, sessionId === null ? [] : rootsOf(sessionId));
        return [{ pid: proc.pid, sessionId, tag: proc.tag, command: proc.command, cwd: proc.cwd, sessionPrivate }];
      });
    },

    async reapOne(pid, tag) {
      if (tag === "") return false;
      const result = await reapTaggedProcesses(tag, { ...options.platform, select: (proc) => proc.pid === pid });
      return result.reapedPids.includes(pid);
    },
  };
}
