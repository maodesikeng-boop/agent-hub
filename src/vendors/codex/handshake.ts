import { CODEX_RESUME_REBAKES, personaSeenAtStart } from "../../daemon/driver/persona-note.ts";
import type { AgentSessionPatch } from "../../shared/index.ts";
import { asObject, type CodexDriverHost, type Proc, type SessionState } from "./driver-state.ts";
import {
  ZERO_CODEX_USAGE_COUNTS,
  buildInitializedNotification,
  buildSkillsExtraRootsRequest,
  buildThreadResumeRequest,
  buildThreadStartRequest,
} from "./protocol.ts";

export type HandshakePhase = "initialize" | "skills_extra_roots" | "thread_resume" | "thread_start";

export function isHandshakePhase(phase: string): phase is HandshakePhase {
  return phase === "initialize" || phase === "skills_extra_roots" || phase === "thread_resume" || phase === "thread_start";
}

function failStartup(host: CodexDriverHost, st: SessionState, proc: Proc, errorObj: Record<string, unknown>, fallback: string): void {
  proc.resolveReady({
    kind: "failed",
    exitCode: null,
    signal: null,
    stderr: proc.stderr,
    timedOut: false,
    errorMessage: typeof errorObj.message === "string" ? errorObj.message : fallback,
  });
  host.forceKillProc(st, proc);
}

function openThread(host: CodexDriverHost, st: SessionState, proc: Proc): void {
  const row = host.row(st);
  const sessionInfo = {
    vendorSessionId: row?.vendorSessionId ?? proc.threadId ?? "",
    cwd: row?.cwd ?? proc.launched.cwd,
    model: row?.model ?? proc.launched.model ?? proc.defaultModel,
  };
  const nextId = host.nextRequestSeq();
  if (proc.resume) {
    proc.pendingRpcs.set(nextId, "thread_resume");
    proc.child.stdin.write(buildThreadResumeRequest(nextId, sessionInfo, proc.launchConfig) + "\n");
  } else {
    proc.pendingRpcs.set(nextId, "thread_start");
    proc.child.stdin.write(buildThreadStartRequest(nextId, sessionInfo, proc.launchConfig) + "\n");
  }
}

function threadOpened(
  host: CodexDriverHost,
  st: SessionState,
  proc: Proc,
  resultObj: Record<string, unknown> | null,
  resumed: boolean,
  at: number,
): void {
  const thread = asObject(resultObj?.thread);
  const threadId = typeof thread?.id === "string" && thread.id !== "" ? thread.id : proc.threadId;
  const model =
    typeof thread?.model === "string" && thread.model !== ""
      ? thread.model
      : (host.row(st)?.model ?? proc.launched.model);
  completeThreadHandshake(host, st, proc, threadId, model, resumed, at);
}

export function onHandshakeResponse(
  host: CodexDriverHost,
  st: SessionState,
  proc: Proc,
  phase: HandshakePhase,
  errorObj: Record<string, unknown> | null,
  resultObj: Record<string, unknown> | null,
  at: number,
): void {
  switch (phase) {
    case "initialize": {
      if (errorObj) {
        failStartup(host, st, proc, errorObj, "initialize failed");
        return;
      }
      proc.child.stdin.write(buildInitializedNotification() + "\n");
      if (proc.launchConfig.skillRoots.length > 0) {
        const skillsId = host.nextRequestSeq();
        proc.pendingRpcs.set(skillsId, "skills_extra_roots");
        proc.child.stdin.write(buildSkillsExtraRootsRequest(skillsId, proc.launchConfig.skillRoots) + "\n");
        return;
      }
      openThread(host, st, proc);
      return;
    }

    case "skills_extra_roots": {
      // Older codex lacks skills/extraRoots/set; start without it.
      if (errorObj) {
        const message = typeof errorObj.message === "string" ? errorObj.message : JSON.stringify(errorObj);
        host.log(`[codex] session ${st.id} skills/extraRoots/set 失败，任务图手册只能按路径读：${message}`);
      }
      openThread(host, st, proc);
      return;
    }

    case "thread_resume": {
      if (errorObj) {
        // thread/resume fails when the rollout is missing; fall back to thread/start.
        proc.resume = false;
        proc.threadId = null;
        const row = host.row(st);
        const sessionInfo = {
          cwd: row?.cwd ?? proc.launched.cwd,
          model: row?.model ?? proc.launched.model ?? proc.defaultModel,
        };
        const startId = host.nextRequestSeq();
        proc.pendingRpcs.set(startId, "thread_start");
        proc.child.stdin.write(buildThreadStartRequest(startId, sessionInfo, proc.launchConfig) + "\n");
        return;
      }
      threadOpened(host, st, proc, resultObj, true, at);
      return;
    }

    case "thread_start": {
      if (errorObj) {
        failStartup(host, st, proc, errorObj, "thread/start failed");
        return;
      }
      threadOpened(host, st, proc, resultObj, false, at);
      return;
    }
  }
}

function completeThreadHandshake(
  host: CodexDriverHost,
  st: SessionState,
  proc: Proc,
  threadId: string | null,
  model: string | null,
  resumed: boolean,
  at: number,
): void {
  if (threadId) proc.threadId = threadId;
  if (proc.initSeen) return;
  proc.initSeen = true;
  proc.resume = resumed;
  if (!resumed) {
    st.usageThreadId = proc.threadId;
    st.lastThreadTotal = { ...ZERO_CODEX_USAGE_COUNTS };
  } else if (st.usageThreadId !== proc.threadId) {
    st.usageThreadId = proc.threadId;
    st.lastThreadTotal = null;
  }
  host.markHealthy(st.id);
  host.setPersonaSeen(st, personaSeenAtStart(st, host.row(st), proc.personaLaunched, !resumed || CODEX_RESUME_REBAKES));
  host.clearTimer(st, "startTimer");

  const patch: AgentSessionPatch = {
    status: "running",
    lastEventAt: at,
    ...(proc.threadId ? { vendorSessionId: proc.threadId } : {}),
  };
  const row = host.row(st);
  if (row && row.hasCompletedTurn !== resumed) patch.hasCompletedTurn = resumed;
  host.update(st, patch);
  host.emit(st.id, {
    type: "session.started",
    resumed,
    model,
    tools: [],
    at,
  });
  proc.resolveReady({ kind: "ok" });
}
