import type { SessionId } from "../../shared/domain.ts";
import type { DriverEvent } from "../../shared/driver.ts";
import { MAX_PENDING_DRIVER_EVENTS_PER_SESSION } from "../../shared/limits.ts";
import { LOG_PREFIX } from "../../shared/names.ts";
import type { AgentTextMeta } from "../../shared/sent-files.ts";
import type { LocalLink } from "../sent-files.ts";
import {
  NO_TURN_FACTS,
  type TurnCompletionFacts,
  type TurnCompletionReceipt,
  type TurnEndedEvent,
  type createTurnCompletionLedger,
} from "./turn-completions.ts";

type OrdinaryEvent = Exclude<DriverEvent, TurnEndedEvent>;
type QueueItem = { event: OrdinaryEvent; links: LocalLink[] } | { receipt: TurnCompletionReceipt; facts: TurnCompletionFacts | null; prepared: boolean };

interface Queue {
  items: QueueItem[];
  preparing: AbortController | null;
  applying: boolean;
  waiting: boolean;
  offline: boolean;
  plainLinks: boolean;
  done: Promise<void>;
  finish(): void;
}

interface DriverEventDrainOptions {
  completions: ReturnType<typeof createTurnCompletionLedger>;
  beforeTurn?(sessionId: SessionId, signal: AbortSignal): Promise<void> | null;
  factsFor(sessionId: SessionId, event: TurnEndedEvent): TurnCompletionFacts;
  apply(sessionId: SessionId, event: OrdinaryEvent, meta: AgentTextMeta | null): void;
  localLinks(text: string): LocalLink[];
  textMetaFor(sessionId: SessionId, event: OrdinaryEvent, links: LocalLink[], signal: AbortSignal): Promise<AgentTextMeta | null>;
  onOverflow(sessionId: SessionId): void;
  onSessionDrained?(sessionId: SessionId): void;
  onQueueEmpty?(sessionId: SessionId): void;
}

const HANDOVER_TRIGGER_EVENTS = new Set<DriverEvent["type"]>([
  "session.exited",
  "message.requeued",
  "message.cancelled",
  "background.changed",
]);

function isHandoverTrigger(item: QueueItem): boolean {
  return "receipt" in item || HANDOVER_TRIGGER_EVENTS.has(item.event.type);
}

export function createDriverEventDrain(options: DriverEventDrainOptions) {
  const { completions } = options;
  const queues = new Map<SessionId, Queue>();

  function log(sessionId: SessionId, type: DriverEvent["type"], error: unknown): void {
    console.error(`${LOG_PREFIX} driver event ${type} (session ${sessionId}):`, error);
  }

  function factsFor(sessionId: SessionId, event: TurnEndedEvent): TurnCompletionFacts {
    try {
      return options.factsFor(sessionId, event);
    } catch (error) {
      log(sessionId, event.type, error);
      return NO_TURN_FACTS;
    }
  }

  function applyLogged(sessionId: SessionId, event: OrdinaryEvent, meta: AgentTextMeta | null): void {
    try {
      options.apply(sessionId, event, meta);
    } catch (error) {
      log(sessionId, event.type, error);
    }
  }

  function copyReply(sessionId: SessionId, queue: Queue, item: Extract<QueueItem, { event: OrdinaryEvent }>): void {
    const copy = new AbortController();
    queue.preparing = copy;
    void options.textMetaFor(sessionId, item.event, item.links, copy.signal).catch((error) => {
      log(sessionId, item.event.type, error);
      return null;
    }).then((meta) => {
      if (copy.signal.aborted) return;
      queue.items.shift();
      queue.applying = true;
      try {
        applyLogged(sessionId, item.event, meta);
      } finally {
        queue.applying = false;
      }
      queue.preparing = null;
      drain(sessionId, queue, isHandoverTrigger(item));
    }).catch((error) => log(sessionId, item.event.type, error));
  }

  function prepareTurn(sessionId: SessionId, queue: Queue): boolean {
    if (options.beforeTurn === undefined) return false;
    const pending = new AbortController();
    try {
      const prepare = options.beforeTurn(sessionId, pending.signal);
      if (prepare === null) return false;
      queue.preparing = pending;
      void prepare.catch((error) => log(sessionId, "turn.ended", error)).then(() => {
        if (pending.signal.aborted) return;
        queue.preparing = null;
        drain(sessionId, queue);
      }).catch((error) => log(sessionId, "turn.ended", error));
      return true;
    } catch (error) {
      log(sessionId, "turn.ended", error);
      return false;
    }
  }

  function drain(sessionId: SessionId, queue: Queue, lastTrigger = false): void {
    if (queue.preparing !== null || queue.waiting) return;
    let lastWasTrigger = lastTrigger;
    while (queue.items.length > 0) {
      const item = queue.items[0]!;
      if ("receipt" in item) {
        if (!item.prepared && !queue.plainLinks) {
          item.prepared = true;
          if (prepareTurn(sessionId, queue)) return;
        }
        item.facts ??= factsFor(sessionId, item.receipt.event);
        queue.waiting = true;
        queue.applying = true;
        let result;
        try {
          result = completions.settle(item.receipt, item.facts);
        } finally {
          queue.applying = false;
        }
        if (result.kind === "pending") return;
        queue.waiting = false;
      } else if (!queue.plainLinks && item.links.length > 0) {
        copyReply(sessionId, queue, item);
        return;
      } else {
        queue.applying = true;
        try {
          applyLogged(sessionId, item.event, null);
        } finally {
          queue.applying = false;
        }
      }
      lastWasTrigger = isHandoverTrigger(item);
      queue.items.shift();
    }
    if (queues.get(sessionId) === queue) queues.delete(sessionId);
    queue.finish();
    try {
      options.onQueueEmpty?.(sessionId);
    } catch (error) {
      console.error(`${LOG_PREFIX} driver event queue empty callback (session ${sessionId}):`, error);
    }
    if (!lastWasTrigger) {
      try {
        options.onSessionDrained?.(sessionId);
      } catch (error) {
        console.error(`${LOG_PREFIX} driver event drain callback (session ${sessionId}):`, error);
      }
    }
  }

  function flush(sessionId: SessionId, queue: Queue): void {
    queue.preparing?.abort();
    queue.preparing = null;
    queue.plainLinks = true;
    drain(sessionId, queue);
  }

  function push(sessionId: SessionId, event: DriverEvent): void {
    let queue = queues.get(sessionId);
    if (queue !== undefined && queue.items.length >= MAX_PENDING_DRIVER_EVENTS_PER_SESSION && !queue.offline) {
      flush(sessionId, queue);
      queue = queues.get(sessionId);
      if (queue !== undefined && queue.items.length >= MAX_PENDING_DRIVER_EVENTS_PER_SESSION) {
        queue.offline = true;
        options.onOverflow(sessionId);
      }
    }
    if (queue?.offline) {
      if (event.type === "turn.ended") {
        const receipt = completions.receive(sessionId, event, NO_TURN_FACTS);
        completions.settle(receipt, NO_TURN_FACTS);
      }
      return;
    }
    const links = event.type === "agent.text" && !queue?.plainLinks ? options.localLinks(event.text) : [];
    if (queue === undefined && event.type !== "turn.ended" && links.length === 0) {
      options.apply(sessionId, event, null);
      return;
    }
    const facts = queue === undefined && event.type === "turn.ended" ? factsFor(sessionId, event) : null;
    const item = event.type === "turn.ended"
      ? { receipt: completions.receive(sessionId, event, facts), facts, prepared: false }
      : { event, links };
    if (queue === undefined) {
      let finish = () => {};
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      queue = { items: [], preparing: null, applying: false, waiting: false, offline: false, plainLinks: false, done, finish };
      queues.set(sessionId, queue);
    }
    queue.items.push(item);
    drain(sessionId, queue);
  }

  return {
    push,
    hasPending(sessionId: SessionId): boolean {
      const queue = queues.get(sessionId);
      if (queue === undefined) return false;
      if (queue.applying) return queue.items.length > (queue.preparing !== null ? 0 : 1);
      return queue.items.length > 0;
    },
    onSettled(receipt: TurnCompletionReceipt) {
      const queue = queues.get(receipt.sessionId);
      const head = queue?.items[0];
      if (queue === undefined || head === undefined || !("receipt" in head) || head.receipt.sequence !== receipt.sequence) return;
      queue.waiting = false;
      queue.items.shift();
      drain(receipt.sessionId, queue, true);
    },
    async wait() {
      while (queues.size > 0) await Promise.all([...queues.values()].map((queue) => queue.done));
    },
    close() {
      for (const [sessionId, queue] of queues) {
        flush(sessionId, queue);
        queue.finish();
      }
      queues.clear();
    },
  };
}
