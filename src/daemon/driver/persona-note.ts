// 性格设定、模式改了不重启（driver.ts 的“两轮之间自动重启”）：三家驱动共用的比较。
// 每个进程记着 agent 已经看到的那一版（personaSeen，进程起来时是 LaunchFiles.personaRevision），写一行之前问一次 personaNote。
import type { DriverOptions, SessionId } from "../../shared/index.ts";

/** 带了说明的一行：没写成（#dropBatch）时 restore，这个进程的版本退回去，说明留给下一行。 */
export interface PersonaNoteTaken {
  note: string;
  restore: () => void;
}

/**
 * 往 proc 写一行之前调：版本变了就把 proc.personaSeen 改成新的；内容也变了返回要加的说明。
 * 没有 personaNote、这个进程没记版本（Worker、老测试）、没变都返回 null。personaNote 抛错当没变，交给 onError 记一笔（驱动层记成 internal_error）。
 */
export function takePersonaNote(
  personaNote: DriverOptions["personaNote"],
  sessionId: SessionId,
  proc: { personaSeen: number | null },
  onError: (error: unknown) => void,
): PersonaNoteTaken | null {
  const since = proc.personaSeen;
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
  proc.personaSeen = revision;
  if (result.note === null) return null;
  return {
    note: result.note,
    // 之后又有一行带上了更新的就不退
    restore: () => {
      if (proc.personaSeen === revision) proc.personaSeen = since;
    },
  };
}
