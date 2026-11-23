import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { createStore, useStore, type StoreApi } from "zustand";
import {
  ATTACHMENTS_MISSING_MESSAGE,
  CHANGE_BUFFER_SIZE,
  CONVERSATION_LOOKUP_MAX_IDS,
  MAX_CONVERSATION_LOOKUP_STATES,
  MAX_MESSAGE_BYTES,
  MAX_REWOUND_PENDING_KEYS,
  findRewindableMessage,
  type Attachment,
  type Change,
  type ConversationId,
  type DeviceInfo,
  type MessageId,
  type PmId,
  type PostMessageRequest,
  type StateSnapshot,
  type WsServerMessage,
  type WorkerId,
  type WorkerPick,
  WS_BURST_FRAME_LIMIT,
  WS_FRAME_BUDGET_MS,
  userMessageDedupeKey,
  workerPickOf,
} from "../shared/index.ts";
import { changeCursorFromSnapshot, type ChangeCursor } from "../shared/change-stream.ts";
import { createAutoReloader, installAutoReloadListeners, type AutoReloadEnv, type AutoReloader } from "./auto-reload.ts";
import { byteLength } from "./format.ts";
import { ApiError, createClient, fetchDevices, localClient, onUnauthorized, type HubClient } from "./client.ts";
import { openChangeStream, planSnapshotRecovery, reconnectDelay, type ChangeStreamConnection } from "./connection.ts";
import { LOCAL_DEVICE, OFFLINE_AFTER_MS, deviceStatus, placeholderSelf, sameDeviceInfo, type DeviceKey, type DeviceView, type LinkHistory } from "./devices.ts";
import { ErrorNotice, errorText, newClientId } from "./format.ts";
import { invalidateAccount, queryClient, useHubQueryClient } from "./query-client.ts";
import { parseRoute } from "./route.ts";
import { uploadFiles } from "./upload.ts";
import { initialState, oldestMessageId, referencesUnknownConversation, reducer, type HubState } from "./state.ts";

const RESYNC_RETRY_MS = 3_000;

function messageBody(clientId: string, text: string, attachmentIds: string[], workerPick: WorkerPick | null): PostMessageRequest {
  return { clientId, text, ...(attachmentIds.length > 0 && { attachmentIds }), ...(workerPick !== null && { workerPick }) };
}

type Action = Parameters<typeof reducer>[1];

interface StreamRecovery {
  connection: ChangeStreamConnection;
  buffered: Change[] | null;
  done: Promise<void>;
}

function requireCursor(snapshot: StateSnapshot): ChangeCursor {
  const cursor = changeCursorFromSnapshot(snapshot);
  if (cursor === null) throw new Error("Invalid state snapshot cursor");
  return cursor;
}

function waitForRecoveryRetry(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, RESYNC_RETRY_MS);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function isDocumentHidden(): boolean {
  return typeof document === "object" && document.visibilityState === "hidden";
}

export class DeviceHub {
  readonly store: StoreApi<HubState> = createStore<HubState>(() => initialState);
  readonly link: LinkHistory = { lastOnlineAt: null, disconnectedAt: null };
  private cursor: ChangeCursor | null = null;
  private connection: ChangeStreamConnection | null = null;
  private recovery: StreamRecovery | null = null;
  private loading: AbortController | null = null;
  private readonly olderInFlight = new Set<ConversationId>();
  private readonly requestedWorkers = new Set<WorkerId>();
  private readonly endedWorkersInFlight = new Set<PmId>();
  private readonly inFlightPosts = new Map<string, { conversationId: ConversationId; after: "none" | "stop" | "rewind" }>();
  private readonly rewindBarriers = new Map<ConversationId, number>();
  private readonly stopRequests = new Map<ConversationId, Promise<void>>();
  private alive = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private offlineTimer: ReturnType<typeof setTimeout> | undefined;
  private notifyRaf: number | undefined;
  private frameResetRaf: number | undefined;
  private frameChangeCount = 0;
  private frameRenderMs = 0;
  private closeStream: (() => void) | null = null;
  private loadAttempt = 0;
  private offUnauthorized: (() => void) | null = null;
  private offVisibility: (() => void) | null = null;

  readonly key: DeviceKey;
  readonly client: HubClient;
  private readonly onChange: () => void;
  private readonly onResync: (() => void) | undefined;
  private readonly onBoot: ((bootId: string) => void) | undefined;
  private readonly onAccountUpdated: (() => void) | undefined;
  private readonly qc: QueryClient;

  constructor(
    key: DeviceKey,
    client: HubClient,
    onChange: () => void,
    onResync?: () => void,
    onBoot?: (bootId: string) => void,
    onAccountUpdated?: () => void,
    qc: QueryClient = queryClient,
  ) {
    this.key = key;
    this.client = client;
    this.onChange = onChange;
    this.onResync = onResync;
    this.onBoot = key === LOCAL_DEVICE ? onBoot : undefined;
    this.onAccountUpdated = key === LOCAL_DEVICE ? onAccountUpdated : undefined;
    this.qc = qc;
  }

  get state(): HubState {
    return this.store.getState();
  }

  set state(next: HubState) {
    this.store.setState(next, true);
  }

  subscribe = (listener: (state: HubState, prevState: HubState) => void): (() => void) => this.store.subscribe(listener);

  private get remote(): boolean {
    return this.key !== LOCAL_DEVICE;
  }

  private dispatch(action: Action): void {
    if (action.type === "loaded") this.requestedWorkers.clear();
    const before = this.state;
    this.state = reducer(this.state, action);
    if (this.state.phase !== "ready" && before.phase === "ready") this.stopStream();
    for (const id of this.rewindBarriers.keys()) {
      if (!this.state.conversations[id] || this.state.conversations[id]?.conversation.purgedAt !== undefined) this.rewindBarriers.delete(id);
    }
    this.trackLink();
    if (action.type === "change") {
      this.scheduleChangeNotify();
      return;
    }
    this.flushPendingNotify();
    this.onChange();
  }

  private scheduleFrameReset(): void {
    if (this.frameResetRaf !== undefined || typeof requestAnimationFrame !== "function") return;
    this.frameResetRaf = requestAnimationFrame(() => {
      this.frameResetRaf = undefined;
      this.frameChangeCount = 0;
      this.frameRenderMs = 0;
    });
  }

  private clearFrameResetRaf(): void {
    this.frameChangeCount = 0;
    this.frameRenderMs = 0;
    if (this.frameResetRaf !== undefined) {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.frameResetRaf);
      this.frameResetRaf = undefined;
    }
  }

  private flushPendingNotify(): boolean {
    this.clearFrameResetRaf();
    if (this.notifyRaf === undefined) return false;
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.notifyRaf);
    this.notifyRaf = undefined;
    return true;
  }

  private handleVisibilityChange = (): void => {
    const hadPending = this.flushPendingNotify();
    if (hadPending && (this.alive || this.cursor !== null)) this.onChange();
  };

  private scheduleChangeNotify(): void {
    // Browsers and WKWebView suspend rAF while hidden, which would stall background notifications.
    if (isDocumentHidden() || typeof requestAnimationFrame !== "function") {
      this.flushPendingNotify();
      if (this.alive || this.cursor !== null) this.onChange();
      return;
    }
    this.frameChangeCount++;
    this.scheduleFrameReset();
    const coalesce = this.frameChangeCount > WS_BURST_FRAME_LIMIT || this.frameRenderMs >= WS_FRAME_BUDGET_MS;
    if (coalesce) {
      if (this.notifyRaf !== undefined) return;
      this.notifyRaf = requestAnimationFrame(() => {
        this.notifyRaf = undefined;
        this.clearFrameResetRaf();
        if (this.alive || this.cursor !== null) this.onChange();
      });
      return;
    }
    if (this.notifyRaf !== undefined) return;
    const t0 = typeof performance === "object" ? performance.now() : 0;
    if (this.alive || this.cursor !== null) this.onChange();
    if (typeof performance === "object") this.frameRenderMs += performance.now() - t0;
  }

  private trackLink(): void {
    const online = this.state.phase === "ready" && this.state.connection === "open";
    if (online) {
      this.link.lastOnlineAt = Date.now();
      this.link.disconnectedAt = null;
      if (this.offlineTimer !== undefined) {
        clearTimeout(this.offlineTimer);
        this.offlineTimer = undefined;
      }
      return;
    }
    if (this.state.phase === "ready" && this.state.connection === "reconnecting" && this.link.disconnectedAt === null) {
      this.link.disconnectedAt = Date.now();
      if (this.offlineTimer !== undefined) clearTimeout(this.offlineTimer);
      this.offlineTimer = setTimeout(() => {
        this.offlineTimer = undefined;
        if (this.alive) this.onChange();
      }, OFFLINE_AFTER_MS);
    }
  }

  start(): void {
    this.alive = true;
    this.offVisibility?.();
    if (typeof document === "object" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
      this.offVisibility = () => document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    }
    if (!this.remote) {
      this.offUnauthorized = onUnauthorized(() => {
        if (!this.alive) return;
        this.loading?.abort();
        this.dispatch({ type: "loadFailed", unauthorized: true });
      });
    }
    void this.load();
  }

  dispose(): void {
    this.alive = false;
    this.loading?.abort();
    this.loading = null;
    this.inFlightPosts.clear();
    this.stopRequests.clear();
    this.rewindBarriers.clear();
    this.offUnauthorized?.();
    this.offUnauthorized = null;
    this.offVisibility?.();
    this.offVisibility = null;
    clearTimeout(this.timer);
    clearTimeout(this.offlineTimer);
    this.offlineTimer = undefined;
    this.flushPendingNotify();
    this.stopStream();
  }

  private applyChange(change: Change): void {
    if (!this.cursor || change.seq <= this.cursor.seq) return;
    this.cursor = { bootId: this.cursor.bootId, seq: change.seq };
    this.dispatch({ type: "change", change });
  }

  private installSnapshot(snapshot: StateSnapshot, cursor: ChangeCursor): void {
    this.cursor = cursor;
    this.dispatch({ type: "loaded", snapshot });
    this.onBoot?.(cursor.bootId);
  }

  private async load(): Promise<void> {
    if (!this.alive) return;
    clearTimeout(this.timer);
    this.loading?.abort();
    const request = new AbortController();
    this.loading = request;
    this.stopStream();
    if (!this.remote || this.state.phase === "loading") this.dispatch({ type: "loading" });
    try {
      const snapshot = await this.client.fetchState(request.signal);
      if (request.signal.aborted) return;
      const cursor = requireCursor(snapshot);
      this.loadAttempt = 0;
      this.installSnapshot(snapshot, cursor);
      this.openStream();
    } catch (err) {
      if (request.signal.aborted) return;
      const unauthorized = err instanceof ApiError && err.status === 401;
      if (!this.remote || this.state.phase === "loading") this.dispatch({ type: "loadFailed", unauthorized, error: errorText(err) });
      if (this.remote && !unauthorized) this.timer = setTimeout(() => void this.load(), reconnectDelay(this.loadAttempt++));
    } finally {
      if (this.loading === request) this.loading = null;
    }
  }

  reload = (): Promise<void> => this.connection ? this.resync(this.connection) : this.load();

  private resync(connection: ChangeStreamConnection, first?: Change): Promise<void> {
    if (this.recovery?.connection === connection) return this.recovery.done;
    const recovery: StreamRecovery = {
      connection,
      buffered: first === undefined ? [] : [first],
      done: Promise.resolve().then(() => this.recoverSnapshot(recovery)),
    };
    this.recovery = recovery;
    this.onResync?.();
    return recovery.done;
  }

  private async recoverSnapshot(recovery: StreamRecovery): Promise<void> {
    const { connection } = recovery;
    while (!connection.signal.aborted) {
      try {
        const snapshot = await this.client.fetchState(connection.signal);
        if (connection.signal.aborted) return;
        const cursor = requireCursor(snapshot);
        const plan = planSnapshotRecovery(connection, cursor, recovery.buffered);
        if (plan.kind === "ignore") return;
        if (plan.kind === "reconnect") this.stopStream();
        this.recovery = null;
        this.installSnapshot(snapshot, cursor);
        if (plan.kind === "reconnect") this.openStream();
        else {
          for (const change of plan.changes) this.applyChange(change);
          this.dispatch({ type: "connection", status: "open" });
        }
        return;
      } catch (err) {
        if (connection.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) {
          this.dispatch({ type: "loadFailed", unauthorized: true });
          return;
        }
        this.dispatch({ type: "connection", status: "reconnecting" });
        await waitForRecoveryRetry(connection.signal);
      }
    }
  }

  private receive(message: WsServerMessage, connection: ChangeStreamConnection): void {
    if (message.type === "account.updated") {
      if (!this.remote) {
        void invalidateAccount(this.qc);
        this.onAccountUpdated?.();
      }
    } else if (message.type === "resync") {
      if (!this.remote) void invalidateAccount(this.qc);
      void this.resync(connection);
    } else if (this.recovery?.connection === connection) {
      const buffered = this.recovery.buffered;
      if (buffered?.length === CHANGE_BUFFER_SIZE) this.recovery.buffered = null;
      else buffered?.push(message);
    } else if (referencesUnknownConversation(this.state, message)) {
      void this.resync(connection, message);
    } else {
      this.applyChange(message);
    }
  }

  private openStream(): void {
    if (this.closeStream || !this.alive || !this.cursor || this.state.phase !== "ready") return;
    this.closeStream = openChangeStream({
      url: this.client.changeStreamUrl,
      reportPresence: !this.remote,
      getCursor: () => this.cursor!,
      onStatus: (status, connection) => {
        const reconnected = !this.remote && status === "open" && this.state.phase === "ready" && this.state.connection === "reconnecting";
        this.connection = connection;
        this.recovery = null;
        this.dispatch({ type: "connection", status });
        if (reconnected) {
          void invalidateAccount(this.qc);
          this.onAccountUpdated?.();
        }
      },
      onMessage: (message, connection) => this.receive(message, connection),
    });
  }

  private stopStream(): void {
    const close = this.closeStream;
    this.closeStream = null;
    this.connection = null;
    this.recovery = null;
    close?.();
  }

  private async submit(conversationId: ConversationId, clientId: string, text: string, attachmentIds: string[], workerPick: WorkerPick | null): Promise<void> {
    const flight = { conversationId, after: "none" as "none" | "stop" | "rewind" };
    this.inFlightPosts.set(clientId, flight);
    try {
      await this.client.postMessage(conversationId, messageBody(clientId, text, attachmentIds, workerPick));
      if (this.alive) {
        if (flight.after === "rewind") void this.stop(conversationId).then(() => this.client.postRewind(conversationId)).catch(() => {});
        else if (flight.after === "stop") void this.client.postStop(conversationId).catch(() => {});
      }
    } catch (err) {
      // A 400 means the server rejected this clientId; retrying can never succeed.
      const rejected = err instanceof ApiError && err.status === 400;
      const reason = errorText(err);
      const missing = rejected && reason.text === ATTACHMENTS_MISSING_MESSAGE;
      if (this.alive && flight.after !== "rewind") {
        this.dispatch({
          type: "pendingPhase",
          clientId,
          phase: "failed",
          ...(missing ? { failure: "attachments_missing" as const } : rejected ? { failure: "rejected" as const, reason } : {}),
        });
      }
    } finally {
      this.inFlightPosts.delete(clientId);
    }
  }

  private post(conversationId: ConversationId, text: string, attachments: Attachment[], workerPick: WorkerPick | null): void {
    const clientId = newClientId();
    this.dispatch({
      type: "pendingAdd",
      pending: { clientId, conversationId, text, attachments, ...(workerPick !== null && { workerPick }), phase: "sending", createdAt: Date.now() },
    });
    void this.submit(conversationId, clientId, text, attachments.map((a) => a.id), workerPick);
  }

  send = (conversationId: ConversationId, text: string, workerPick: WorkerPick | null = null): void => this.post(conversationId, text, [], workerPick);

  sendChecked = async (conversationId: ConversationId, text: string, workerPick: WorkerPick | null = null): Promise<void> => {
    const clientId = newClientId();
    const pending = { clientId, conversationId, text, attachments: [], ...(workerPick !== null && { workerPick }), createdAt: Date.now() };
    try {
      await this.client.postMessage(conversationId, messageBody(clientId, text, [], workerPick));
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) throw new ErrorNotice(errorText(err));
      if (this.alive) this.dispatch({ type: "pendingAdd", pending: { ...pending, phase: "failed" } });
      return;
    }
    const key = userMessageDedupeKey(conversationId, clientId);
    const arrived = this.state.conversations[conversationId]?.messages.some((m) => m.sender === "user" && m.dedupeKey === key);
    if (this.alive && !arrived) this.dispatch({ type: "pendingAdd", pending: { ...pending, phase: "sending" } });
  };

  sendWithFiles = async (conversationId: ConversationId, text: string, files: File[], workerPick: WorkerPick | null = null): Promise<void> => {
    const attachments = await uploadFiles(files, this.client);
    if (this.alive) this.post(conversationId, text, attachments, workerPick);
  };

  retrySend = (clientId: string): void => {
    const pending = this.state.pending.find((p) => p.clientId === clientId);
    if (!pending) return;
    this.dispatch({ type: "pendingPhase", clientId, phase: "sending" });
    void this.submit(pending.conversationId, clientId, pending.text, pending.attachments.map((a) => a.id), pending.workerPick ?? null);
  };

  retryMessage = async (messageId: MessageId): Promise<void> => {
    this.dispatch({ type: "retryStart", messageId });
    try {
      await this.client.postRetryMessage(messageId);
    } catch {
      if (this.alive) this.dispatch({ type: "retryFailed", messageId });
    }
  };

  stop = (conversationId: ConversationId): Promise<void> => {
    for (const flight of this.inFlightPosts.values()) {
      if (flight.conversationId === conversationId && flight.after === "none") flight.after = "stop";
    }
    const request = this.client.postStop(conversationId);
    this.stopRequests.set(conversationId, request);
    void request.finally(() => {
      if (this.stopRequests.get(conversationId) === request) this.stopRequests.delete(conversationId);
    }).catch(() => {});
    return request;
  };

  rewind = (conversationId: ConversationId, stopping: boolean, draftText = ""): { text: string; workerPick: WorkerPick | null } | null => {
    const fits = (text: string): boolean => {
      const merged = draftText.trim() === "" || draftText === text ? text : `${text}\n${draftText}`;
      return byteLength(merged) <= MAX_MESSAGE_BYTES;
    };
    const persist = () => {
      const stopped = this.stopRequests.get(conversationId) ?? Promise.resolve();
      void stopped.then(() => this.client.postRewind(conversationId)).catch(() => {});
    };
    const pending = this.state.pending.findLast((p) => p.conversationId === conversationId);
    if (pending !== undefined) {
      if (!stopping || pending.phase !== "sending" || (pending.text === "" && pending.workerPick === undefined)) return null;
      if (!fits(pending.text)) return null;
      const flight = this.inFlightPosts.get(pending.clientId);
      if (flight) flight.after = "rewind";
      const lastId = this.state.conversations[conversationId]?.messages.at(-1)?.id ?? 0;
      this.rewindBarriers.delete(conversationId);
      this.rewindBarriers.set(conversationId, lastId);
      if (this.rewindBarriers.size > MAX_REWOUND_PENDING_KEYS) this.rewindBarriers.delete(this.rewindBarriers.keys().next().value!);
      this.dispatch({ type: "pendingRewind", clientId: pending.clientId });
      if (!flight) persist();
      return { text: pending.text, workerPick: pending.workerPick ?? null };
    }
    const view = this.state.conversations[conversationId];
    if (!view) return null;
    const target = findRewindableMessage(view.messages, { stopping });
    if (target === null || !fits(target.text)) return null;
    const barrier = this.rewindBarriers.get(conversationId);
    if (barrier !== undefined && target.id <= barrier) return null;
    this.rewindBarriers.delete(conversationId);
    this.dispatch({ type: "messageRewind", conversationId, messageId: target.id });
    persist();
    return { text: target.text, workerPick: workerPickOf(target) };
  };

  ensureConversation = (conversationId: ConversationId): void => {
    if (this.state.phase !== "ready" || this.state.conversations[conversationId] || this.state.lookups[conversationId] !== undefined) return;
    void this.lookup([conversationId], []);
  };

  ensureWorkers = (workerIds: readonly WorkerId[]): void => {
    if (this.state.phase !== "ready") return;
    const fresh = workerIds.filter((id) => !this.requestedWorkers.has(id));
    if (fresh.length === 0) return;
    if (this.requestedWorkers.size + fresh.length > MAX_CONVERSATION_LOOKUP_STATES) this.requestedWorkers.clear();
    for (const id of fresh) this.requestedWorkers.add(id);
    for (let i = 0; i < fresh.length; i += CONVERSATION_LOOKUP_MAX_IDS) void this.lookup([], fresh.slice(i, i + CONVERSATION_LOOKUP_MAX_IDS));
  };

  private async lookup(ids: ConversationId[], workerIds: WorkerId[]): Promise<void> {
    if (ids.length > 0) this.dispatch({ type: "lookupStart", ids });
    try {
      const lookup = await this.client.fetchConversationsLookup({ ids, workerIds });
      if (this.alive) this.dispatch({ type: "lookupDone", ids, lookup });
    } catch {
      if (!this.alive) return;
      if (ids.length > 0) this.dispatch({ type: "lookupFailed", ids });
      for (const id of workerIds) this.requestedWorkers.delete(id);
    }
  }

  loadEndedWorkers = async (pmId: PmId): Promise<void> => {
    const before = this.state.olderEndedWorkers[pmId];
    if (before === undefined || this.endedWorkersInFlight.has(pmId)) return;
    this.endedWorkersInFlight.add(pmId);
    try {
      const page = await this.client.fetchEndedWorkers(pmId, before);
      if (this.alive) this.dispatch({ type: "endedWorkersLoaded", pmId, before, page });
    } finally {
      this.endedWorkersInFlight.delete(pmId);
    }
  };

  loadOlder = async (conversationId: ConversationId): Promise<void> => {
    const view = this.state.conversations[conversationId];
    if (!view?.hasMore || this.olderInFlight.has(conversationId)) return;
    const before = oldestMessageId(view) ?? Number.MAX_SAFE_INTEGER;
    this.olderInFlight.add(conversationId);
    this.dispatch({ type: "olderStart", conversationId });
    try {
      const page = await this.client.fetchOlderMessages(conversationId, before);
      if (this.alive) this.dispatch({ type: "olderDone", conversationId, messages: page.messages, hasMore: page.hasMore });
    } catch {
      if (this.alive) this.dispatch({ type: "olderFailed", conversationId });
    } finally {
      this.olderInFlight.delete(conversationId);
    }
  };
}

export interface DevicesSnapshot {
  devices: readonly DeviceView[];
  selfId: string | null;
  managed: boolean;
  listed: boolean;
  listFailed: boolean;
}

export class DevicesStore {
  private readonly hubs = new Map<DeviceKey, DeviceHub>();
  private infos: readonly DeviceInfo[] | null = null;
  private prevDevices: readonly DeviceView[] = [];
  private managed = false;
  readonly store: StoreApi<DevicesSnapshot>;
  private running = false;
  private listTimer: ReturnType<typeof setTimeout> | undefined;
  private listAttempt = 0;
  private listGen = 0;
  private listController: AbortController | null = null;

  private readonly clientFor: (key: DeviceKey) => HubClient;
  private readonly autoReload: AutoReloader;

  constructor(clientFor: (key: DeviceKey) => HubClient = defaultClientFor, routed?: DeviceKey, autoReloadEnv?: Partial<AutoReloadEnv>, qc: QueryClient = queryClient) {
    this.clientFor = clientFor;
    this.autoReload = createAutoReloader({
      isStreaming: () => [...this.hubs.values()].some((hub) => hub.state.sessions.some((s) => s.streamingText != null)),
      ...autoReloadEnv,
    });
    const refreshIfRunning = () => {
      if (this.running) void this.refresh();
    };
    this.hubs.set(
      LOCAL_DEVICE,
      new DeviceHub(
        LOCAL_DEVICE,
        this.clientFor(LOCAL_DEVICE),
        this.changed,
        refreshIfRunning,
        (bootId) => this.autoReload.observeBoot(bootId),
        refreshIfRunning,
        qc,
      ),
    );
    if (routed !== undefined && routed !== LOCAL_DEVICE) this.hubs.set(routed, new DeviceHub(routed, this.clientFor(routed), this.changed));
    this.store = createStore<DevicesSnapshot>(() => this.build());
  }

  subscribe = (listener: (state: DevicesSnapshot, prevState: DevicesSnapshot) => void): (() => void) => this.store.subscribe(listener);

  getSnapshot = (): DevicesSnapshot => this.store.getState();

  private changed = (): void => {
    this.store.setState(this.build(), true);
  };

  private build(): DevicesSnapshot {
    const now = Date.now();
    const local = this.hubs.get(LOCAL_DEVICE)!;
    const selfInfo = this.infos?.find((d) => d.self) ?? placeholderSelf(local.state.server.platform);
    const others = (this.infos ?? []).filter((d) => !d.self);
    const prevByKey = new Map(this.prevDevices.map((d) => [d.key, d]));
    const view = (key: DeviceKey, info: DeviceInfo): DeviceView[] => {
      const hub = this.hubs.get(key);
      if (!hub) return [];
      const status = deviceStatus(hub.state, hub.link, now);
      const lastOnlineAt = hub.link.lastOnlineAt;
      const prev = prevByKey.get(key);
      if (prev !== undefined && prev.info === info && prev.state === hub.state && prev.status === status && prev.lastOnlineAt === lastOnlineAt) {
        return [prev];
      }
      return [{ key, info, state: hub.state, status, lastOnlineAt }];
    };
    const nextDevices = [...view(LOCAL_DEVICE, selfInfo), ...others.flatMap((info) => view(info.id, info))];
    const devices =
      nextDevices.length === this.prevDevices.length && nextDevices.every((d, i) => d === this.prevDevices[i])
        ? this.prevDevices
        : nextDevices;
    this.prevDevices = devices;
    return {
      devices,
      selfId: this.infos?.find((d) => d.self)?.id ?? null,
      managed: this.managed,
      listed: this.infos !== null,
      listFailed: this.infos === null && this.listAttempt > 0,
    };
  }

  hub(key: DeviceKey): DeviceHub {
    return this.hubs.get(key) ?? this.hubs.get(LOCAL_DEVICE)!;
  }

  start(): void {
    this.running = true;
    installAutoReloadListeners();
    for (const hub of this.hubs.values()) hub.start();
    void this.refresh();
  }

  dispose(): void {
    this.running = false;
    this.listGen++;
    this.listController?.abort();
    this.listController = null;
    clearTimeout(this.listTimer);
    this.autoReload.dispose();
    for (const hub of this.hubs.values()) hub.dispose();
  }

  refresh = async (): Promise<void> => {
    clearTimeout(this.listTimer);
    this.listController?.abort();
    const controller = new AbortController();
    this.listController = controller;
    const gen = ++this.listGen;
    let infos: readonly DeviceInfo[];
    try {
      infos = (await fetchDevices(controller.signal)).devices;
    } catch (err) {
      if (!this.running || gen !== this.listGen) return;
      if (err instanceof ApiError && err.status === 404) {
        this.listAttempt = 0;
        this.managed = false;
        this.setDevices([]);
        return;
      }
      this.listTimer = setTimeout(() => void this.refresh(), reconnectDelay(this.listAttempt++));
      this.changed();
      return;
    } finally {
      if (this.listController === controller) this.listController = null;
    }
    if (!this.running || gen !== this.listGen) return;
    this.listAttempt = 0;
    this.managed = true;
    this.setDevices(infos);
  };

  setDevices(infos: readonly DeviceInfo[]): void {
    const prevById = new Map((this.infos ?? []).map((d) => [d.id, d]));
    this.infos = infos.map((next) => {
      const prev = prevById.get(next.id);
      return prev !== undefined && sameDeviceInfo(prev, next) ? prev : next;
    });
    const wanted = new Set(infos.filter((d) => !d.self).map((d) => d.id));
    for (const [key, hub] of this.hubs) {
      if (key !== LOCAL_DEVICE && !wanted.has(key)) {
        hub.dispose();
        this.hubs.delete(key);
      }
    }
    for (const info of infos) {
      if (info.self) continue;
      const existing = this.hubs.get(info.id);
      if (existing !== undefined) {
        if (!prevById.get(info.id)?.online && info.online && existing.state.phase === "error" && this.running) {
          void existing.reload();
        }
        continue;
      }
      const hub = new DeviceHub(info.id, this.clientFor(info.id), this.changed);
      this.hubs.set(info.id, hub);
      if (this.running) hub.start();
    }
    this.changed();
  }
}

function defaultClientFor(key: DeviceKey): HubClient {
  return key === LOCAL_DEVICE ? localClient : createClient(key);
}

export function useDevices() {
  const qc = useHubQueryClient();
  const [store] = useState(() => new DevicesStore(defaultClientFor, parseRoute(window.location.hash)?.device, undefined, qc));
  useEffect(() => {
    store.start();
    return () => store.dispose();
  }, [store]);
  const snapshot = useStore(store.store);
  // Stable reference so downstream useCallback consumers keep their memo.
  const hub = useCallback((key: DeviceKey) => store.hub(key), [store]);
  return { ...snapshot, hub, refresh: store.refresh };
}
