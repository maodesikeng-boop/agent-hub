import { LRUCache } from "lru-cache";
import {
  COMMANDS_FRESH_MS,
  COMMANDS_RETRY_MS,
  isInternalSkillCommand,
  MAX_COMMAND_CACHE_ENTRIES,
  MAX_CONCURRENT_COMMAND_QUERIES,
  PROBE_SHUTDOWN_DRAIN_MS,
  type AgentVendor, type ComposerCommand,
  type SessionId,
} from "../shared/index.ts";
import { LOG_PREFIX } from "../shared/names.ts";
import type { VendorComposer } from "./vendors/index.ts";

export interface CommandsRequest {
  sessionId: SessionId;
  vendor: string;
  cwd: string;
  addDirs: readonly string[];
}

export interface CommandCatalogsOptions {
  vendors: Readonly<Partial<Record<AgentVendor, VendorComposer>>>;
  queryRunning: (sessionId: SessionId) => Promise<ComposerCommand[] | null>;
  now?: () => number;
  log?: (line: string) => void;
  maxConcurrent?: number;
  maxEntries?: number;
}

export interface CommandCatalogs {
  list(request: CommandsRequest): Promise<ComposerCommand[]>;
  cached(request: Omit<CommandsRequest, "sessionId">): ComposerCommand[] | null;
  update(request: Omit<CommandsRequest, "sessionId">, commands: ComposerCommand[]): void;
  close(): Promise<void>;
}

interface Entry {
  commands: ComposerCommand[] | null;
  at: number;
  failedAt: number | null;
  inflight: Promise<void> | null;
}

function keyOf(request: Omit<CommandsRequest, "sessionId">): string {
  return JSON.stringify([request.vendor, request.cwd, ...request.addDirs]);
}

export function createCommandCatalogs(options: CommandCatalogsOptions): CommandCatalogs {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_COMMAND_QUERIES;
  const maxEntries = options.maxEntries ?? MAX_COMMAND_CACHE_ENTRIES;
  const entries = new LRUCache<string, Entry>({ max: Math.max(1, maxEntries) });
  const inflight = new Set<Promise<void>>();
  const controller = new AbortController();
  let closed = false;
  let active = 0;
  const waiting: Array<{ go: () => void; cancel: () => void }> = [];

  /** Queue when all spawn slots are busy; shutdown cancels queued requests. */
  const acquire = (): Promise<void> => {
    if (closed) return Promise.reject(new Error("cancelled"));
    if (active < maxConcurrent) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => waiting.push({ go: resolve, cancel: () => reject(new Error("cancelled")) }));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next.go();
    else active--;
  };

  const vendorOf = (vendor: string): VendorComposer | null =>
    Object.hasOwn(options.vendors, vendor) ? (options.vendors[vendor as AgentVendor] ?? null) : null;

  const entryOf = (key: string): Entry => {
    let entry = entries.get(key);
    if (!entry) {
      entry = { commands: null, at: 0, failedAt: null, inflight: null };
      entries.set(key, entry);
    }
    return entry;
  };

  const store = (key: string, entry: Entry, commands: ComposerCommand[]) => {
    entries.set(key, entry);
    entry.commands = commands;
    entry.at = now();
    entry.failedAt = null;
  };

  const ask = (vendor: VendorComposer, request: CommandsRequest, key: string, entry: Entry): Promise<void> => {
    if (entry.inflight) return entry.inflight;
    const running = (async () => {
      try {
        await acquire();
        try {
          store(key, entry, await vendor.queryCommands({ cwd: request.cwd, addDirs: request.addDirs }, controller.signal));
        } finally {
          release();
        }
      } catch (error) {
        entry.failedAt = now();
        if (!closed) log(`${LOG_PREFIX} 没问到 ${request.vendor} 在 ${request.cwd} 的命令列表（${error instanceof Error ? error.message : String(error)}），先给空列表`);
      }
    })().finally(() => {
      entry.inflight = null;
      inflight.delete(running);
    });
    entry.inflight = running;
    inflight.add(running);
    return running;
  };

  const visible = (vendor: VendorComposer, commands: ComposerCommand[] | null) =>
    (commands ?? []).filter((c) => !vendor.isHiddenCommand(c) && !isInternalSkillCommand(c.name));

  return {
    async list(request) {
      const vendor = vendorOf(request.vendor);
      if (vendor === null) return [];
      const key = keyOf(request);
      const entry = entryOf(key);
      if (closed) return visible(vendor, entry.commands);
      const running = await options.queryRunning(request.sessionId).catch(() => null);
      if (running !== null) {
        store(key, entry, running);
        return visible(vendor, running);
      }
      const retryOk = entry.failedAt === null || now() - entry.failedAt >= COMMANDS_RETRY_MS;
      if (entry.commands === null) {
        if (entry.inflight || retryOk) await ask(vendor, request, key, entry);
      } else if (!entry.inflight && now() - entry.at >= COMMANDS_FRESH_MS && retryOk) {
        void ask(vendor, request, key, entry);
      }
      return visible(vendor, entry.commands);
    },
    cached: (request) => entries.peek(keyOf(request))?.commands ?? null,
    update(request, commands) {
      if (closed || vendorOf(request.vendor) === null) return;
      const key = keyOf(request);
      store(key, entryOf(key), commands);
    },
    async close() {
      closed = true;
      controller.abort();
      for (const w of waiting.splice(0)) w.cancel();
      if (inflight.size === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...inflight]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, PROBE_SHUTDOWN_DRAIN_MS);
          timer.unref();
        }),
      ]);
      clearTimeout(timer);
    },
  };
}
