import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionState } from "../shared/index.ts";

/** 点“停止”之后：发出去了没、服务端接受了没。 */
type StopPhase = "idle" | "sending" | "requested" | "failed";

/** 输入框的“停止”键要的东西：agent 在忙才能停；正在停（或刚点过、服务端还没确认）时按钮不可点；停止失败有提示。 */
export interface StopControl {
  busy: boolean;
  /** 键盘第一次 Esc 是否可触发停止：会话在忙或有排队/发送中的用户消息，且尚未在停止中。 */
  canStop?: boolean;
  stopping: boolean;
  failed: boolean;
  onStop: () => void;
}

/** 一个对话的停止状态；requestStop 调“停止”接口，reject 就是失败。queued 为 true 时表示有排队或待发的用户消息可按 Esc 取消。 */
export function useStop(session: SessionState | null, requestStop: (() => Promise<void>) | null, queued = false): StopControl {
  const [phase, setPhase] = useState<StopPhase>("idle");
  const activity = session?.activity ?? "idle";
  const busy = activity !== "idle";
  const active = busy || queued;
  const requestStopRef = useRef(requestStop);
  requestStopRef.current = requestStop;
  const activeRef = useRef(active);
  activeRef.current = active;
  const seqRef = useRef(0);

  // 这一轮结束且没有排队消息了，下一轮又能点“停止”
  useEffect(() => {
    if (!active) {
      seqRef.current += 1;
      setPhase("idle");
    }
  }, [active]);

  const onStop = useCallback(() => {
    if (requestStopRef.current === null) return;
    const seq = ++seqRef.current;
    setPhase("sending");
    requestStopRef.current().then(
      () => {
        if (seqRef.current === seq && activeRef.current) setPhase("requested");
        else if (seqRef.current === seq) setPhase("idle");
      },
      () => {
        if (seqRef.current === seq) setPhase("failed");
      },
    );
  }, []);

  const stopping = activity === "stopping" || phase === "sending" || phase === "requested";
  const canStop = active && !stopping;
  const failed = phase === "failed";
  return useMemo(() => ({ busy, canStop, stopping, failed, onStop }), [busy, canStop, stopping, failed, onStop]);
}
