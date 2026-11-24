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
type QueueItem = { event: OrdinaryEvent; links: LocalLink[] } | { receipt: TurnCompletionReceipt; facts: TurnCompletionFacts | null };

interface Queue {
  items: QueueItem[];
  copy: AbortController | null;
  applying: boolean;
  waiting: boolean;
  offline: boolean;
  plainLinks: boolean;
  done: Promise<void>;
  finish(): void;
}

interface DriverEventDrainOptions {
  completions: ReturnType<typeof createTurnCompletionLedger>;
  factsFor(sessionId: SessionId, event: TurnEndedEvent): TurnCompletionFacts;
  apply(sessionId: SessionId, event: OrdinaryEvent, meta: AgentTextMeta | null): void;
  localLinks(text: string): LocalLink[];
  textMetaFor(sessionId: SessionId, event: OrdinaryEvent, links: LocalLink[], signal: AbortSignal): Promise<AgentTextMeta | null>;
  onOverflow(sessionId: SessionId): void;
  onSessionDrained?(sessionId: SessionId): void;
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
    queue.copy = copy;
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
      queue.copy = null;
      drain(sessionId, queue, isHandoverTrigger(item));
    }).catch((error) => log(sessionId, item.event.type, error));
  }

  function drain(sessionId: SessionId, queue: Queue, lastTrigger = false): void {
    if (queue.copy !== null || queue.waiting) return;
    let lastWasTrigger = lastTrigger;
    while (queue.items.length > 0) {
      const item = queue.items[0]!;
      if ("receipt" in item) {
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
    if (!lastWasTrigger) {
      try {
        options.onSessionDrained?.(sessionId);
      } catch (error) {
        console.error(`${LOG_PREFIX} driver event drain callback (session ${sessionId}):`, error);
      }
    }
  }

  function flush(sessionId: SessionId, queue: Queue): void {
    queue.copy?.abort();
    queue.copy = null;
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
      ? { receipt: completions.receive(sessionId, event, facts), facts }
      : { event, links };
    if (queue === undefined) {
      let finish = () => {};
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      queue = { items: [], copy: null, applying: false, waiting: false, offline: false, plainLinks: false, done, finish };
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
      if (queue.applying) return queue.items.length > (queue.copy !== null ? 0 : 1);
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
