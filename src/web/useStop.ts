import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionState } from "../shared/index.ts";

/** 点“停止”之后：发出去了没、服务端接受了没。 */
type StopPhase = "idle" | "sending" | "requested" | "failed";

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
  const requestStopRef = useRef(requestStop);
  requestStopRef.current = requestStop;

  // 这一轮结束了，下一轮又能点“停止”
  useEffect(() => {
    if (activity === "idle") setPhase("idle");
  }, [activity]);

  const onStop = useCallback(() => {
    if (requestStopRef.current === null) return;
    setPhase("sending");
    requestStopRef.current().then(
      () => setPhase("requested"),
      () => setPhase("failed"),
    );
  }, []);

  const busy = activity !== "idle";
  const stopping = activity === "stopping" || phase === "sending" || phase === "requested";
  const failed = phase === "failed";
  return useMemo(() => ({ busy, stopping, failed, onStop }), [busy, stopping, failed, onStop]);
}
