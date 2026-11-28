import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionState } from "../shared/index.ts";

type StopPhase = "idle" | "sending" | "requested" | "failed";

interface StopState {
  phase: StopPhase;
  sessionKey: string | null;
  turnId: number | null;
  sawServerStopping: boolean;
}

const IDLE_STATE: StopState = {
  phase: "idle",
  sessionKey: null,
  turnId: null,
  sawServerStopping: false,
};

export interface StopControl {
  busy: boolean;
  canStop?: boolean;
  stopping: boolean;
  failed: boolean;
  onStop: () => void;
}

export function useStop(session: SessionState | null, requestStop: (() => Promise<void>) | null, queued = false): StopControl {
  const [state, setState] = useState<StopState>(IDLE_STATE);
  const activity = session?.activity ?? "idle";
  const busy = activity !== "idle";
  const active = busy || queued;
  const sessionKey = session === null ? null : `${session.conversationId ?? ""}:${session.sessionId}`;
  const turnId = session?.activeTurnId ?? null;

  const requestStopRef = useRef(requestStop);
  requestStopRef.current = requestStop;
  const activeRef = useRef(active);
  activeRef.current = active;
  const activityRef = useRef(activity);
  activityRef.current = activity;
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;
  const turnIdRef = useRef(turnId);
  turnIdRef.current = turnId;
  const seqRef = useRef(0);

  const identityChanged = state.sessionKey !== sessionKey || state.turnId !== turnId;
  const exitedStopping = state.sawServerStopping && activity !== "stopping";
  const effectivePhase: StopPhase = !active || identityChanged || exitedStopping ? "idle" : state.phase;

  useEffect(() => {
    if (state.phase === "idle") return;
    if (!active || identityChanged || exitedStopping) {
      seqRef.current += 1;
      setState(IDLE_STATE);
      return;
    }
    if (activity === "stopping" && !state.sawServerStopping) {
      setState((prev) => (prev.phase === "idle" ? prev : { ...prev, sawServerStopping: true }));
    }
  }, [active, activity, exitedStopping, identityChanged, state.phase, state.sawServerStopping]);

  const onStop = useCallback(() => {
    if (requestStopRef.current === null) return;
    const seq = ++seqRef.current;
    const key = sessionKeyRef.current;
    const turn = turnIdRef.current;
    setState({ phase: "sending", sessionKey: key, turnId: turn, sawServerStopping: activityRef.current === "stopping" });
    requestStopRef.current().then(
      () => {
        if (seqRef.current !== seq || sessionKeyRef.current !== key || turnIdRef.current !== turn) return;
        if (!activeRef.current) {
          setState(IDLE_STATE);
          return;
        }
        setState((prev) =>
          prev.sessionKey === key && prev.turnId === turn
            ? { ...prev, phase: "requested", sawServerStopping: prev.sawServerStopping || activityRef.current === "stopping" }
            : IDLE_STATE,
        );
      },
      () => {
        if (seqRef.current === seq && sessionKeyRef.current === key && turnIdRef.current === turn) {
          setState({ phase: "failed", sessionKey: key, turnId: turn, sawServerStopping: false });
        }
      },
    );
  }, []);

  const stopping = activity === "stopping" || effectivePhase === "sending" || effectivePhase === "requested";
  const canStop = active && !stopping;
  const failed = effectivePhase === "failed";
  return useMemo(() => ({ busy, canStop, stopping, failed, onStop }), [busy, canStop, stopping, failed, onStop]);
}
