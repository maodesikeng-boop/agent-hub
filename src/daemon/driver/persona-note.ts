// 性格设定、模式改了不重启（driver.ts 的“两轮之间自动重启”）：三家驱动共用的比较。
// 每个会话记着 agent 已经看到的那一版（personaSeen），写进会话那一行（personaRevision），守护进程重启也接得上；
// 写一行之前问一次 personaNote，变了就把说明放在前面。
// 新起的进程算不算“按最新的拼过了”看厂商（personaSeenAtSpawn 的 rebaked）：
// - claude --resume 沿用会话最初的系统提示词（2.1.314 实测：transcript 里存了第一次请求的 shape，换了 --append-system-prompt-file
//   也不用），codex thread/resume 没实测、按一样算：恢复的进程不算，接着用之前看到的；
// - 新会话（--session-id、thread/start）、agy 每个新进程（第一条消息前面重新带系统指令）算。
import type { AgentSessionRow, DriverOptions, LaunchFiles, SessionId } from "../../shared/index.ts";

/** 驱动层会话状态里的那一格：null = 不知道（Worker、还没起过进程又没记过）。 */
export interface PersonaSeenHolder {
  personaSeen: number | null;
}

/** 带了说明的一行：没写成、agent 没读到（#dropBatch、停止、进程没了要重写）时 restore，版本退回去，说明留给下一行。 */
export interface PersonaNoteTaken {
  note: string;
  restore: () => void;
}

/**
 * 进程起来时 agent 看到的是哪一版。rebaked：这个进程的系统提示词就是这次拼的（见文件开头）；否则接着用之前看到的
 * （内存里的，守护进程重启过就是会话那一行记的），都没有（0012 之前的老会话）按这次拼的算。Worker（没有 personaRevision）是 null。
 */
export function personaSeenAtSpawn(holder: PersonaSeenHolder, row: AgentSessionRow, files: LaunchFiles, rebaked: boolean): number | null {
  const launched = files.personaRevision ?? null;
  if (launched === null) return null;
  if (rebaked) return launched;
  return holder.personaSeen ?? row.personaRevision ?? launched;
}

/**
 * 写一行之前调：版本变了就改 holder.personaSeen（并 persist 写库）；内容也变了返回要加的说明。
 * 没有 personaNote、不知道看到的是哪一版、没变都返回 null。personaNote 抛错当没变，交给 onError 记一笔（驱动层记成 internal_error）。
 */
export function takePersonaNote(
  personaNote: DriverOptions["personaNote"],
  sessionId: SessionId,
  holder: PersonaSeenHolder,
  persist: (revision: number) => void,
  onError: (error: unknown) => void,
): PersonaNoteTaken | null {
  const since = holder.personaSeen;
  if (!personaNote || since === null) return null;
  let result: ReturnType<NonNullable<DriverOptions["personaNote"]>>;
  try {
    result = personaNote(sessionId, since);
  } catch (error) {
    onError(error);
    return null;
  }
  if (result === null) return null;
  const revision = result.revision;
  holder.personaSeen = revision;
  persist(revision);
  if (result.note === null) return null;
  return {
    note: result.note,
    // 之后又有一行带上了更新的、或者新起的进程已经按最新的拼了，就不退
    restore: () => {
      if (holder.personaSeen !== revision) return;
      holder.personaSeen = since;
      persist(since);
    },
  };
}
