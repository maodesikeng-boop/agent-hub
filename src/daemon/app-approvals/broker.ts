// Invariant: the broker holds the only in-memory waits; ledger rows are the source of truth for decisions, so a
// decision recorded by the ledger always resolves every wait attached to that row, and no wait outlives its row.
import {
  APP_APPROVAL_NATIVE_WAITS_PER_WORKER_MAX, type AppApprovalAnswer, type AppApprovalGate, type AppApprovalId,
  type AppApprovalRequest, type WorkerId,
} from "../../shared/index.ts";
import type { AppApprovalStore } from "../ledger/app-approvals.ts";

export interface AppApprovalBrokerOptions {
  store: AppApprovalStore;
  /** Fires after a ledger write that changed an app approval row, so waits can settle without polling. */
  onRowChanged: (listener: (id: AppApprovalId) => void) => () => void;
  workerIdOf?: (request: AppApprovalRequest) => WorkerId | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  log?: (line: string) => void;
}

export interface AppApprovalBroker extends AppApprovalGate {
  /** Postcondition: resolves every open wait with "cancel", cancels timers, and unsubscribes; later requests resolve "decline". */
  close(): void;
  hasLiveRequests(id: AppApprovalId): boolean;
}

type Wait = (answer: AppApprovalAnswer) => void;

interface RowWaits {
  timer: { cancel(): void };
  requests: Set<Wait>;
}

/**
 * Postcondition: request() returns "accept" or "decline" immediately for allowed, denied, or ineligible lookups, and
 * otherwise waits until the row is decided ("accept"/"decline"), expires ("decline"), or the signal aborts ("cancel").
 * At most one timer runs per pending row, firing at its expires_at.
 */
export function createAppApprovalBroker(options: AppApprovalBrokerOptions): AppApprovalBroker {
  const { store, now = Date.now, workerIdOf = ({ sessionId }) => sessionId, log } = options;
  const setTimer = options.setTimer ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  });
  const rows = new Map<AppApprovalId, RowWaits>();
  const counts = new Map<WorkerId, number>();
  let closed = false;

  function finishRow(id: AppApprovalId, answer: AppApprovalAnswer): void {
    const row = rows.get(id);
    if (row === undefined) return;
    rows.delete(id);
    row.timer.cancel();
    for (const finish of row.requests) finish(answer);
  }

  const unsubscribe = options.onRowChanged((id) => {
    if (closed || !rows.has(id)) return;
    const status = store.getById(id)?.status;
    if (status !== "pending") finishRow(id, status === "allowed" ? "accept" : "decline");
  });

  function arm(id: AppApprovalId, expiresAt: number): { cancel(): void } {
    return setTimer(() => {
      if (closed) return;
      try {
        const at = now();
        if (at < expiresAt) {
          const row = rows.get(id);
          if (row !== undefined) row.timer = arm(id, expiresAt);
          return;
        }
        store.expireDue(at);
      } catch (error) {
        log?.(`App approval expiry failed: ${String(error)}`);
      } finally {
        if (now() >= expiresAt) finishRow(id, "decline");
      }
    }, Math.max(0, expiresAt - now()));
  }

  async function request(input: AppApprovalRequest, signal: AbortSignal): Promise<AppApprovalAnswer> {
    if (closed) return "decline";
    if (signal.aborted) return "cancel";
    let release: (() => void) | undefined;
    let waiting = false;
    try {
      const workerId = workerIdOf(input);
      if (workerId === null) return "decline";
      const count = counts.get(workerId) ?? 0;
      if (count >= APP_APPROVAL_NATIVE_WAITS_PER_WORKER_MAX) return "decline";
      counts.set(workerId, count + 1);
      release = () => {
        const remaining = (counts.get(workerId) ?? 1) - 1;
        if (remaining === 0) counts.delete(workerId);
        else counts.set(workerId, remaining);
      };
      const lookup = store.openOrAttach(input);
      if (lookup.kind !== "pending") return lookup.kind === "allowed" ? "accept" : "decline";
      const id = lookup.approvalId;
      let row = rows.get(id);
      if (row === undefined) {
        row = { timer: arm(id, lookup.expiresAt), requests: new Set() };
        rows.set(id, row);
      }
      const requests = row.requests;
      waiting = true;
      return new Promise<AppApprovalAnswer>((resolve) => {
        const abort = () => finish("cancel");
        const finish: Wait = (answer) => {
          if (!requests.delete(finish)) return;
          signal.removeEventListener("abort", abort);
          release?.();
          resolve(answer);
        };
        requests.add(finish);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted || closed) finish("cancel");
      });
    } catch (error) {
      log?.(`App approval request failed: ${String(error)}`);
      return "decline";
    } finally {
      if (!waiting) release?.();
    }
  }

  return {
    request,
    hasLiveRequests: (id) => (rows.get(id)?.requests.size ?? 0) > 0,
    processEnded(sessionId, processKey) {
      if (closed) return;
      try {
        store.endProcess(sessionId, processKey, "process_exit");
      } catch (error) {
        log?.(`App approval process cleanup failed: ${String(error)}`);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      for (const id of rows.keys()) finishRow(id, "cancel");
    },
  };
}
