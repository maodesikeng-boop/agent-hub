import { useEffect, useState } from "react";
import type { SessionState } from "../shared/index.ts";

/** 点“停止”之后：发出去了没、服务端接受了没。 */
export type StopPhase = "idle" | "sending" | "requested" | "failed";

/** 输入框的“停止”键要的东西：agent 在忙才能停；正在停（或刚点过、服务端还没确认）时按钮不可点；停止失败有提示。 */
export interface StopControl {
  busy: boolean;
  stopping: boolean;
  failed: boolean;
  onStop: () => void;
}

/** 一个对话的停止状态；requestStop 调“停止”接口，reject 就是失败。 */
export function useStop(session: SessionState | null, requestStop: (() => Promise<void>) | null): StopControl {
  const [phase, setPhase] = useState<StopPhase>("idle");
  const activity = session?.activity ?? "idle";

  // 这一轮结束了，下一轮又能点“停止”
  useEffect(() => {
    if (activity === "idle") setPhase("idle");
  }, [activity]);

  return {
    busy: activity !== "idle",
    stopping: activity === "stopping" || phase === "sending" || phase === "requested",
    failed: phase === "failed",
    onStop: () => {
      if (requestStop === null) return;
      setPhase("sending");
      requestStop().then(
        () => setPhase("requested"),
        () => setPhase("failed"),
      );
    },
  };
}
