import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionState, StopConversationResponse, StopId } from "../shared/index.ts";

type StopPhase = "idle" | "sending" | "requested" | "failed";

export type StopRequestResult = StopConversationResponse | void;

interface StopState {
  phase: StopPhase;
  sessionKey: string | null;
  turnId: number | null;
  stopId: StopId | null;
  sawServerStopping: boolean;
}

const IDLE_STATE: StopState = {
  phase: "idle",
  sessionKey: null,
  turnId: null,
  stopId: null,
  sawServerStopping: false,
};

export interface StopControl {
  busy: boolean;
  canStop?: boolean;
  stopping: boolean;
  failed: boolean;
  onStop: () => void;
}

export function useStop(
  session: SessionState | null,
  requestStop: (() => Promise<StopRequestResult>) | null,
  queued = false,
): StopControl {
  const [state, setState] = useState<StopState>(IDLE_STATE);
  const activity = session?.activity ?? "idle";
  const busy = activity !== "idle";
  const active = busy || queued;
  const sessionKey = session === null ? null : `${session.conversationId ?? ""}:${session.sessionId}`;
  const turnId = session?.activeTurnId ?? null;
  const serverStopId = session?.stopId ?? null;
  const settledStopId = session?.settledStopId ?? null;

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
  const serverStopIdRef = useRef(serverStopId);
  serverStopIdRef.current = serverStopId;
  const settledStopIdRef = useRef(settledStopId);
  settledStopIdRef.current = settledStopId;
  const seqRef = useRef(0);

  const sessionChanged = state.sessionKey !== null && state.sessionKey !== sessionKey;
  // Progressing activeTurnId from null -> turnId is the same turn entering processing, not a new turn.
  const turnChanged = state.turnId !== null && state.turnId !== turnId;
  const stopSettledById = state.stopId !== null && settledStopId !== null && settledStopId >= state.stopId;
  const exitedStopping = state.sawServerStopping && activity !== "stopping";
  const shouldReset = !active || sessionChanged || turnChanged || stopSettledById || exitedStopping;
  const effectivePhase: StopPhase = shouldReset ? "idle" : state.phase;
  const serverMatchesStop =
    activity === "stopping" && (state.stopId === null || serverStopId === null || serverStopId >= state.stopId);

  useEffect(() => {
    if (state.phase === "idle") return;
    if (shouldReset) {
      seqRef.current += 1;
      setState(IDLE_STATE);
      return;
    }
    if (serverMatchesStop && !state.sawServerStopping) {
      setState((prev) => (prev.phase === "idle" ? prev : { ...prev, sawServerStopping: true }));
    }
  }, [serverMatchesStop, shouldReset, state.phase, state.sawServerStopping]);

  const onStop = useCallback(() => {
    if (requestStopRef.current === null) return;
    const seq = ++seqRef.current;
    const key = sessionKeyRef.current;
    const turn = turnIdRef.current;
    setState({
      phase: "sending",
      sessionKey: key,
      turnId: turn,
      stopId: null,
      sawServerStopping: activityRef.current === "stopping",
    });
    requestStopRef.current().then(
      (res) => {
        const currentKey = sessionKeyRef.current;
        const currentTurn = turnIdRef.current;
        if (seqRef.current !== seq) return;
        if (key !== null && currentKey !== key) return;
        if (turn !== null && currentTurn !== turn) return;
        if (!activeRef.current) {
          setState(IDLE_STATE);
          return;
        }
        if (res !== undefined) {
          if (res.stopId === null) {
            setState(IDLE_STATE);
            return;
          }
          const settled = settledStopIdRef.current;
          if (settled !== null && settled >= res.stopId) {
            setState(IDLE_STATE);
            return;
          }
          const matchedServerStopping =
            activityRef.current === "stopping" &&
            (serverStopIdRef.current === null || serverStopIdRef.current >= res.stopId);
          setState((prev) =>
            prev.phase === "idle"
              ? IDLE_STATE
              : {
                  phase: "requested",
                  sessionKey: currentKey,
                  turnId: currentTurn,
                  stopId: res.stopId,
                  sawServerStopping: matchedServerStopping,
                },
          );
          return;
        }
        setState((prev) =>
          prev.phase === "idle"
            ? IDLE_STATE
            : {
                phase: "requested",
                sessionKey: currentKey,
                turnId: currentTurn,
                stopId: null,
                sawServerStopping: prev.sawServerStopping || activityRef.current === "stopping",
              },
        );
      },
      () => {
        const currentKey = sessionKeyRef.current;
        const currentTurn = turnIdRef.current;
        if (seqRef.current !== seq) return;
        if (key !== null && currentKey !== key) return;
        if (turn !== null && currentTurn !== turn) return;
        setState({
          phase: "failed",
          sessionKey: currentKey,
          turnId: currentTurn,
          stopId: null,
          sawServerStopping: false,
        });
      },
    );
  }, []);

  const stopping = activity === "stopping" || effectivePhase === "sending" || effectivePhase === "requested";
  const canStop = active && !stopping;
  const failed = effectivePhase === "failed";
  return useMemo(() => ({ busy, canStop, stopping, failed, onStop }), [busy, canStop, stopping, failed, onStop]);
}
