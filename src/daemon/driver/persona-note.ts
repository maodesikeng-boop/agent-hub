// 性格设定、模式改了不重启（driver.ts 的“两轮之间自动重启”）：三家驱动共用的比较。
// 每个会话记着 agent 已经看到的那一版（personaSeen），写进会话那一行（personaRevision），守护进程重启也接得上；
// 写一行之前问一次 personaNote，变了就把说明放在前面。
// 新起的进程算不算“按最新的拼过了”看厂商（personaSeenAtStart 的 rebaked）：
// - claude --resume 沿用会话最初的系统提示词（2.1.314 实测：transcript 里存了第一次请求的 shape，换了 --append-system-prompt-file
//   也不用）；codex thread/resume 也沿用最初的 developerInstructions（0.162 实测，冒烟 S30）：恢复的进程不算，接着用之前看到的；
// - 新会话（--session-id、thread/start）、agy 每个新进程（起进程时按最新的 prompt.md 重写规则目录，见 vendors/agy/rules.ts）算。
// 实测记录见 docs/persona-updates.md。
import type { AgentSessionRow, DriverOptions, SessionId } from "../../shared/index.ts";

/** codex thread/resume 时换了 developerInstructions 会不会用新的：0.162 实测不会（冒烟 S30）。codex 升级后重跑 S30，变了改这里。 */
export const CODEX_RESUME_REBAKES = false;

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
 * 进程真起来（claude 第一个 init、codex 线程建好或恢复好、agy 第一个 init）时 agent 看到的是哪一版。不在 spawn 时算：
 * 起不来、参数选错重试（claude 的 --session-id 撞了改 --resume）的那次不能算数。
 * launched：这次拼进提示词的版本（LaunchFiles.personaRevision），Worker 没有，是 null。
 * rebaked：这个进程的系统提示词就是这次拼的（见文件开头），记 launched；否则接着用之前看到的（内存里的，守护进程重启过
 * 就是会话那一行记的），都没有（0012 之前的老会话）按 0 算：第一条带一次全文。
 */
export function personaSeenAtStart(holder: PersonaSeenHolder, row: AgentSessionRow | null, launched: number | null, rebaked: boolean): number | null {
  if (launched === null) return null;
  if (rebaked) return launched;
  return holder.personaSeen ?? row?.personaRevision ?? 0;
}

/**
 * 守护进程重启后第一次拼行、还没起进程时，从会话那一行读 agent 看到的版本。项目经理的老会话（跑过一轮、0012 之前没有记录）按 0 算，
 * 第一条带一次全文；没跑过的、Worker 的不知道（null，等进程起来再定）。
 */
export function personaSeenFromRow(row: AgentSessionRow | null): number | null {
  if (row === null) return null;
  return row.personaRevision ?? (row.role === "pm" && row.hasCompletedTurn ? 0 : null);
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
    // 不管之后又推进到哪一版（别的行带了更新的、只改了模型这类没带说明就推进的），一律退到这一行之前：agent 最多只看到了 since。
    // 多带一次无害，漏了不行
    restore: () => {
      if (holder.personaSeen !== null && holder.personaSeen <= since) return;
      holder.personaSeen = since;
      persist(since);
    },
  };
}
