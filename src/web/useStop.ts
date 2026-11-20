import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionState } from "../shared/index.ts";

type StopPhase = "idle" | "sending" | "requested" | "failed";

export interface StopControl {
  busy: boolean;
  canStop?: boolean;
  stopping: boolean;
  failed: boolean;
  onStop: () => void;
}

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
