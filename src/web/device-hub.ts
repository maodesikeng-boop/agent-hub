// 把接口、WebSocket 和 state.ts 接起来，一台设备一个 DeviceHub：先拉快照，再按 seq 接着收变化；收到 resync 重新拉。
// DevicesStore 管设备清单（GET /api/devices）和每台的 DeviceHub（Map，键见 devices.ts）；useDevices 是给 React 用的那一层。
// 每台各跑各的 seq、resync、重连：一台断了只补那一台，不拖累别的。
import { useCallback, useEffect, useState } from "react";
import { createStore, useStore, type StoreApi } from "zustand";
import {
  ATTACHMENTS_MISSING_MESSAGE,
  MAX_MESSAGE_BYTES,
  MAX_REWOUND_PENDING_KEYS,
  findRewindableMessage,
  type Attachment,
  type Change,
  type ConversationId,
  type DeviceInfo,
  type MessageId,
  type PostMessageRequest,
  type WorkerPick,
  userMessageDedupeKey,
  workerPickOf,
} from "../shared/index.ts";
import { byteLength } from "./format.ts";
import { ApiError, createClient, fetchDevices, localClient, onUnauthorized, type HubClient } from "./client.ts";
import { openChangeStream, reconnectDelay, type ConnectionStatus } from "./connection.ts";
import { LOCAL_DEVICE, OFFLINE_AFTER_MS, deviceStatus, placeholderSelf, type DeviceKey, type DeviceView, type LinkHistory } from "./devices.ts";
import { ErrorNotice, errorText, newClientId } from "./format.ts";
import { parseRoute } from "./route.ts";
import { uploadFiles } from "./upload.ts";
import { initialState, oldestMessageId, referencesUnknownConversation, reducer, type HubState } from "./state.ts";

/** resync 拉快照失败后隔多久再试。 */
const RESYNC_RETRY_MS = 3_000;

/** 发消息的请求体：没有附件、没选 workerPick 的不带这两个字段。 */
function messageBody(clientId: string, text: string, attachmentIds: string[], workerPick: WorkerPick | null): PostMessageRequest {
  return { clientId, text, ...(attachmentIds.length > 0 && { attachmentIds }), ...(workerPick !== null && { workerPick }) };
}

type Action = Parameters<typeof reducer>[1];

/** 一台设备的连接和状态。入口本机第一次拉快照失败时等用户点“重试”（整页提示）；别的设备自己按退避一直重试。 */
export class DeviceHub {
  readonly store: StoreApi<HubState> = createStore<HubState>(() => initialState);
  readonly link: LinkHistory = { lastOnlineAt: null, disconnectedAt: null };
  /** 已经交给界面的最后一个 seq；重连时从它之后补。 */
  private seq = 0;
  /** 正在 resync 时到的变化先存在这里；null 表示没在 resync。 */
  private buffer: Change[] | null = null;
  private streamStatus: ConnectionStatus = "connecting";
  private readonly olderInFlight = new Set<ConversationId>();
  /** POST /messages 还在路上的记录：若用户在请求返回前就按了 Esc 停止或二次 Esc 回退，等入库返回后再补一次 stop / rewind。 */
  private readonly inFlightPosts = new Map<string, { conversationId: ConversationId; after: "none" | "stop" | "rewind" }>();
  // 待发气泡删除后，旧历史不能变成下一次 Esc 的候选。只保留有上限的消息 id 边界。
  private readonly rewindBarriers = new Map<ConversationId, number>();
  private readonly stopRequests = new Map<ConversationId, Promise<void>>();
  private alive = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private offlineTimer: ReturnType<typeof setTimeout> | undefined;
  private closeStream: (() => void) | null = null;
  private loadAttempt = 0;
  private offUnauthorized: (() => void) | null = null;

  readonly key: DeviceKey;
  readonly client: HubClient;
  private readonly onChange: () => void;
  private readonly onResync: (() => void) | undefined;

  constructor(key: DeviceKey, client: HubClient, onChange: () => void, onResync?: () => void) {
    this.key = key;
    this.client = client;
    this.onChange = onChange;
    this.onResync = onResync;
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
    const before = this.state;
    this.state = reducer(this.state, action);
    if (this.state.phase === "ready" && before.phase !== "ready") this.openStream();
    if (this.state.phase !== "ready" && before.phase === "ready") this.stopStream();
    for (const id of this.rewindBarriers.keys()) {
      if (!this.state.conversations[id] || this.state.conversations[id]?.conversation.purgedAt !== undefined) this.rewindBarriers.delete(id);
    }
    this.trackLink();
    this.onChange();
  }

  /** 记下连上、断开的时间；断开后过 OFFLINE_AFTER_MS 再通知一次（状态从“重连中”变“离线”）。 */
  private trackLink(): void {
    const online = this.state.phase === "ready" && this.state.connection === "open";
    if (online) {
      this.link.lastOnlineAt = Date.now();
      this.link.disconnectedAt = null;
      clearTimeout(this.offlineTimer);
      return;
    }
    if (this.state.phase === "ready" && this.state.connection === "reconnecting" && this.link.disconnectedAt === null) {
      this.link.disconnectedAt = Date.now();
      clearTimeout(this.offlineTimer);
      this.offlineTimer = setTimeout(() => this.alive && this.onChange(), OFFLINE_AFTER_MS);
    }
  }

  start(): void {
    this.alive = true;
    // 任何接口回 401（不只是拉快照）：入口本机直接切到登录界面，不弹报错
    if (!this.remote) {
      this.offUnauthorized = onUnauthorized(() => {
        if (!this.alive) return;
        this.buffer = null;
        this.dispatch({ type: "loadFailed", unauthorized: true });
      });
    }
    void this.load();
  }

  dispose(): void {
    this.alive = false;
    this.inFlightPosts.clear();
    this.stopRequests.clear();
    this.rewindBarriers.clear();
    this.offUnauthorized?.();
    this.offUnauthorized = null;
    clearTimeout(this.timer);
    clearTimeout(this.offlineTimer);
    this.stopStream();
  }

  private applyChange(change: Change): void {
    if (change.seq <= this.seq) return;
    this.seq = change.seq;
    this.dispatch({ type: "change", change });
  }

  /** 拉快照。别的设备拉不到（离线）不回到“加载中”，按退避一直重试。 */
  private async load(): Promise<void> {
    if (!this.remote || this.state.phase === "loading") this.dispatch({ type: "loading" });
    try {
      const snapshot = await this.client.fetchState();
      if (!this.alive) return;
      this.loadAttempt = 0;
      this.seq = snapshot.seq;
      this.dispatch({ type: "loaded", snapshot });
    } catch (err) {
      if (!this.alive) return;
      const unauthorized = err instanceof ApiError && err.status === 401;
      if (!this.remote || this.state.phase === "loading") this.dispatch({ type: "loadFailed", unauthorized, error: errorText(err) });
      if (this.remote && !unauthorized) this.timer = setTimeout(() => void this.load(), reconnectDelay(this.loadAttempt++));
    }
  }

  /** 入口本机拉不到时用户点“重试”。 */
  reload = (): Promise<void> => this.load();

  /** 重新拉快照；拉的时候到的变化先存着，快照之后的再补上。拉不到就一直重试。 */
  private async resync(first: Change[] = []): Promise<void> {
    this.onResync?.();
    if (this.buffer) {
      this.buffer.push(...first);
      return;
    }
    this.buffer = [...first];
    while (this.alive) {
      try {
        const snapshot = await this.client.fetchState();
        if (!this.alive) return;
        const queued = this.buffer ?? [];
        this.buffer = null;
        this.seq = snapshot.seq;
        this.dispatch({ type: "loaded", snapshot });
        for (const change of queued.toSorted((a, b) => a.seq - b.seq)) this.applyChange(change);
        this.dispatch({ type: "connection", status: this.streamStatus });
        return;
      } catch (err) {
        if (!this.alive) return;
        if (err instanceof ApiError && err.status === 401) {
          this.buffer = null;
          this.dispatch({ type: "loadFailed", unauthorized: true });
          return;
        }
        this.dispatch({ type: "connection", status: "reconnecting" });
        await new Promise<void>((resolve) => {
          this.timer = setTimeout(resolve, RESYNC_RETRY_MS);
        });
      }
    }
  }

  private openStream(): void {
    if (this.closeStream) return;
    this.closeStream = openChangeStream({
      url: (since) => this.client.changeStreamUrl(since),
      // 前台上报只发给入口本机（联机 P4）
      reportPresence: !this.remote,
      getSince: () => this.seq,
      onStatus: (status) => {
        this.streamStatus = status;
        // 重新拉快照的过程中一直显示“重连中”，拉完再按连接的真实状态显示
        this.dispatch({ type: "connection", status: this.buffer ? "reconnecting" : status });
      },
      onMessage: (message) => {
        if (message.type === "resync") {
          void this.resync();
        } else if (this.buffer) {
          this.buffer.push(message);
        } else if (referencesUnknownConversation(this.state, message)) {
          void this.resync([message]);
        } else {
          this.applyChange(message);
        }
      },
    });
  }

  private stopStream(): void {
    const close = this.closeStream;
    this.closeStream = null;
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
      // 400：服务端拒绝了这条消息（同一个 clientId 重发还是会被拦，重试永远不会成功）：带的文件找不到了要重新添加，
      // 别的原因（比如手打了不能用的命令）把服务端的 error 原样显示
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

  /** 消息先显示出来（排队中），再发给服务端。 */
  private post(conversationId: ConversationId, text: string, attachments: Attachment[], workerPick: WorkerPick | null): void {
    const clientId = newClientId();
    this.dispatch({
      type: "pendingAdd",
      pending: { clientId, conversationId, text, attachments, ...(workerPick !== null && { workerPick }), phase: "sending", createdAt: Date.now() },
    });
    void this.submit(conversationId, clientId, text, attachments.map((a) => a.id), workerPick);
  }

  /** workerPick：输入框 /hub:worker 选的（只有项目经理对话会有），没选是 null。下面几个发送的方法一样。 */
  send = (conversationId: ConversationId, text: string, workerPick: WorkerPick | null = null): void => this.post(conversationId, text, [], workerPick);

  /**
   * 先发、等接口回应再显示（以 / 开头的消息：手打的命令可能被拦）：被拦（400，ErrorNotice 带着原因）reject，什么都没留下，
   * 输入框那边显示原因、原文不动；发出去了就显示成排队中；网络、服务出错和普通消息一样变成可重试的待发消息。
   */
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
    // 服务端的推送可能比 POST 的回应先到：消息已经在列表里了就不再加临时消息
    const key = userMessageDedupeKey(conversationId, clientId);
    const arrived = this.state.conversations[conversationId]?.messages.some((m) => m.sender === "user" && m.dedupeKey === key);
    if (this.alive && !arrived) this.dispatch({ type: "pendingAdd", pending: { ...pending, phase: "sending" } });
  };

  /**
   * 带文件发：先把文件都传上去（传到这台设备），都传好了才发消息；传失败 reject（Error.message 是中文），这时什么消息都没发出去。
   * 传的时候不显示临时消息（输入框那边显示“发送中”）。
   */
  sendWithFiles = async (conversationId: ConversationId, text: string, files: File[], workerPick: WorkerPick | null = null): Promise<void> => {
    const attachments = await uploadFiles(files, this.client);
    if (this.alive) this.post(conversationId, text, attachments, workerPick);
  };

  /** 重发：同一个 clientId、同样的附件和 workerPick，服务端按 clientId 去重。 */
  retrySend = (clientId: string): void => {
    const pending = this.state.pending.find((p) => p.clientId === clientId);
    if (!pending) return;
    this.dispatch({ type: "pendingPhase", clientId, phase: "sending" });
    void this.submit(pending.conversationId, clientId, pending.text, pending.attachments.map((a) => a.id), pending.workerPick ?? null);
  };

  /** 服务端标了失败的用户消息：请求重试。排进队之后的变化从 WebSocket 来（message.updated），这里只管请求本身。 */
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

  /**
   * 二次 Esc 回退当前对话最后一轮被中断、已取消或正在停止中的用户消息：
   * 返回要恢复进输入框的 { text, workerPick }；没有符合条件的消息（幂等、已完成、失败或已被后续消息越过）返回 null。
   */
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

/** useDevices 给界面的一份：设备按清单顺序（入口本机第一）。 */
export interface DevicesSnapshot {
  devices: readonly DeviceView[];
  /** 入口本机的设备编号；守护进程还没有联机（GET /api/devices 404）或还没拉到时是 null。 */
  selfId: string | null;
  /** 守护进程支持设备管理（GET /api/devices 拉到了）：设置里才有“设备”一组。 */
  managed: boolean;
  /** 设备清单拉过了（拉到或确定拉不到）；之前网址里写的别的设备还认不出来。 */
  listed: boolean;
  /** 第一次拉设备清单就失败、手上没有旧清单，正在按退避重试：先只显示本机，界面提示一句。 */
  listFailed: boolean;
}

/** 设备清单 + 每台一个 DeviceHub。只有入口本机一台时，界面和没有联机时一样。 */
export class DevicesStore {
  private readonly hubs = new Map<DeviceKey, DeviceHub>();
  private infos: readonly DeviceInfo[] | null = null;
  private managed = false;
  readonly store: StoreApi<DevicesSnapshot>;
  private running = false;
  private listTimer: ReturnType<typeof setTimeout> | undefined;
  /** 设备清单连续拉失败的次数（退避用）；拉到或 404 归零。 */
  private listAttempt = 0;

  private readonly clientFor: (key: DeviceKey) => HubClient;

  /**
   * routed：网址里写的别的设备（打开网页时）。不等设备清单回来就开它的连接、拉它的快照，和清单同时拉；
   * 清单回来里面没有它（编号不对、已经移除）就关掉（setDevices）。清单回来之前界面里不出现它（没有设备信息）。
   */
  constructor(clientFor: (key: DeviceKey) => HubClient = defaultClientFor, routed?: DeviceKey) {
    this.clientFor = clientFor;
    this.hubs.set(
      LOCAL_DEVICE,
      new DeviceHub(LOCAL_DEVICE, this.clientFor(LOCAL_DEVICE), this.changed, () => {
        if (this.running) void this.refresh();
      }),
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
    const view = (key: DeviceKey, info: DeviceInfo): DeviceView[] => {
      const hub = this.hubs.get(key);
      if (!hub) return [];
      return [{ key, info, state: hub.state, status: deviceStatus(hub.state, hub.link, now), lastOnlineAt: hub.link.lastOnlineAt }];
    };
    return {
      devices: [...view(LOCAL_DEVICE, selfInfo), ...others.flatMap((info) => view(info.id, info))],
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
    for (const hub of this.hubs.values()) hub.start();
    void this.refresh();
  }

  dispose(): void {
    this.running = false;
    clearTimeout(this.listTimer);
    for (const hub of this.hubs.values()) hub.dispose();
  }

  /** 重新拉设备清单（打开网页时，设置里加、改、删设备之后）：新来的设备开连接，没了的关掉。
   * 404（守护进程没开联机）当只有本机；别的错误保留上一份清单和 managed，按退避自动重试。 */
  refresh = async (): Promise<void> => {
    clearTimeout(this.listTimer);
    let infos: readonly DeviceInfo[];
    try {
      infos = (await fetchDevices()).devices;
    } catch (err) {
      if (!this.running) return;
      if (err instanceof ApiError && err.status === 404) {
        this.listAttempt = 0;
        this.managed = false;
        this.setDevices([]);
        return;
      }
      this.listTimer = setTimeout(() => void this.refresh(), reconnectDelay(this.listAttempt++));
      this.changed();
      return;
    }
    if (!this.running) return;
    this.listAttempt = 0;
    this.managed = true;
    this.setDevices(infos);
  };

  /** 换一份设备清单（测试和假数据也从这里进）。 */
  setDevices(infos: readonly DeviceInfo[]): void {
    this.infos = infos;
    const wanted = new Set(infos.filter((d) => !d.self).map((d) => d.id));
    for (const [key, hub] of this.hubs) {
      if (key !== LOCAL_DEVICE && !wanted.has(key)) {
        hub.dispose();
        this.hubs.delete(key);
      }
    }
    for (const id of wanted) {
      if (this.hubs.has(id)) continue;
      const hub = new DeviceHub(id, this.clientFor(id), this.changed);
      this.hubs.set(id, hub);
      if (this.running) hub.start();
    }
    this.changed();
  }
}

function defaultClientFor(key: DeviceKey): HubClient {
  return key === LOCAL_DEVICE ? localClient : createClient(key);
}

/** 网页的全部设备：快照（每台的状态）+ 按设备取操作的 hub(key) + 刷新设备清单。 */
export function useDevices() {
  const [store] = useState(() => new DevicesStore(defaultClientFor, parseRoute(window.location.hash)?.device));
  useEffect(() => {
    store.start();
    return () => store.dispose();
  }, [store]);
  const snapshot = useStore(store.store);
  // hub 引用稳定：下游 useCallback（如 Router 工作台的 clientForDevice）不会因每次重画都换新函数而击穿 memo
  const hub = useCallback((key: DeviceKey) => store.hub(key), [store]);
  return { ...snapshot, hub, refresh: store.refresh };
}
