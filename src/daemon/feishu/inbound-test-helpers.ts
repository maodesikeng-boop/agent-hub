import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DeviceId } from "../../shared/api.ts";
import { createResolveFolder } from "../ledger/files.ts";
import { createLedger, type SqliteLedger } from "../ledger/index.ts";
import type { CenterLease } from "../mesh/lease.ts";
import { openDatabase, type Db } from "../store/db.ts";
import { migrate } from "../store/migrate.ts";
import { createFeishuAccountBot, createFeishuOfflineInbox, type FeishuAccountBot, type FeishuAccountMeshPort, type FeishuForwardedEvent } from "./account-bot.ts";
import type { FeishuInboundPeerFetchResult, FeishuInboundPeerPort, FeishuInboundPeerPushResult, FeishuInboundRelayPort } from "./inbound-checkpoint.ts";
import { FEISHU_GROUP_MSG_SCOPE, FEISHU_REQUIRED_SCOPES } from "./scopes.ts";
import { createFeishuService, type FeishuService } from "./service.ts";
import { createFakeFeishu, type FakeFeishu } from "./test-helpers.ts";
import type { FeishuRawMessageEvent } from "./transport.ts";

export interface HubNode {
  deviceId: DeviceId;
  name: string;
  root: string;
  db: Db;
  ledger: SqliteLedger;
  service: FeishuService;
  bot: FeishuAccountBot;
  fake: FakeFeishu;
  submitted: { clientId: string; text: string }[];
  submitDelay: (() => Promise<void>) | null;
  lease: CenterLease;
  setLease(holding: boolean, holder: DeviceId | null, epoch: number): void;
  online: boolean;
}

export function createHubCluster(
  clockRef: { now: number },
  relay: { holder: DeviceId | null; portFor(deviceId: DeviceId): FeishuInboundRelayPort },
  tempDir: (prefix: string) => string,
  cleanups: (() => Promise<void> | void)[],
) {
  const sharedFeishu: FakeFeishu = createFakeFeishu({ clock: () => clockRef.now });
  sharedFeishu.granted = [...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE];
  const nodes = new Map<DeviceId, HubNode>();
  const onlineListeners = new Map<DeviceId, Set<(id: DeviceId) => void>>();

  const makeNode = async (deviceId: DeviceId, name: string, initialHolding: boolean, initialEpoch: number): Promise<HubNode> => {
    const root = tempDir(`feishu-hub-${name.toLowerCase()}-`);
    const dataHome = join(root, ".agent-hub");
    mkdirSync(join(dataHome, "state"), { recursive: true });
    const db = openDatabase(join(root, "hub.sqlite"));
    migrate(db);
    const ledger = createLedger(db, {
      pmHomeRoot: join(dataHome, "pm-home"),
      dataHome,
      userHome: root,
      osSandboxed: () => true,
      worktreesDir: join(dataHome, "worktrees"),
      resolveFolder: createResolveFolder({ dataHome, userHome: root }),
    });
    const nodeFake = createFakeFeishu({ clock: () => clockRef.now });
    nodeFake.chats = sharedFeishu.chats;
    nodeFake.sent = sharedFeishu.sent;
    nodeFake.history = sharedFeishu.history;
    nodeFake.cards = sharedFeishu.cards;
    nodeFake.granted = sharedFeishu.granted;

    let holding = initialHolding;
    let holder: DeviceId | null = initialHolding ? deviceId : relay.holder;
    let epoch = initialEpoch;
    const leaseListeners = new Set<(h: DeviceId | null) => void>();
    const lease: CenterLease = {
      holding: () => holding,
      holder: () => holder,
      epoch: () => (holding ? epoch : null),
      refresh: () => {},
      onChange: (fn) => {
        leaseListeners.add(fn);
        return () => leaseListeners.delete(fn);
      },
      close: async () => {},
    };
    const submitted: { clientId: string; text: string }[] = [];
    const peerPort: FeishuInboundPeerPort = {
      onlinePeers: () => [...nodes.values()].filter((n) => n.deviceId !== deviceId && n.online).map((n) => n.deviceId),
      async fetchPeerState(peerId): Promise<FeishuInboundPeerFetchResult> {
        const peer = nodes.get(peerId);
        if (peer === undefined || !peer.online) return { kind: "unavailable" };
        return { kind: "ok", state: peer.service.exportInboundState?.() ?? null };
      },
      async pushPeerState(peerId, state): Promise<FeishuInboundPeerPushResult> {
        const peer = nodes.get(peerId);
        if (peer === undefined || !peer.online) return { kind: "unavailable" };
        peer.service.applyInboundState?.(state);
        return { kind: "ok" };
      },
    };
    const nodeRef: { current?: HubNode } = {};
    const service = createFeishuService({
      db,
      ledger,
      router: {
        async submitCommand(input) {
          if (nodeRef.current?.submitDelay !== null && nodeRef.current?.submitDelay !== undefined) {
            await nodeRef.current.submitDelay();
          }
          submitted.push({ clientId: input.clientId, text: input.text });
          return {
            id: submitted.length,
            clientId: input.clientId,
            text: input.text,
            status: "answered",
            reply: `ok:${input.text}`,
            error: null,
            plan: null,
            createdAt: clockRef.now,
            updatedAt: clockRef.now,
          } as never;
        },
      },
      secretsFile: join(dataHome, "state", "feishu-secrets.json"),
      inboundStateFile: join(dataHome, "state", "feishu-inbound.json"),
      inboundRelay: relay.portFor(deviceId),
      inboundPeers: peerPort,
      uploadsDir: join(dataHome, "uploads"),
      sentFilesDir: join(dataHome, "sent-files"),
      device: { id: deviceId, name },
      lease,
      now: () => clockRef.now,
      log: () => {},
      createTransport: () => nodeFake,
    });
    const listeners = new Set<(id: DeviceId) => void>();
    onlineListeners.set(deviceId, listeners);
    const meshPort: FeishuAccountMeshPort = {
      selfId: deviceId,
      deviceName: (id) => nodes.get(id)?.name ?? null,
      isOnline: (id) => nodes.get(id)?.online ?? false,
      async post(id, _path, body) {
        const peer = nodes.get(id);
        if (peer === undefined || !peer.online) throw new Error("peer offline");
        return (await peer.bot.acceptForwarded(body as FeishuForwardedEvent)) ?? {};
      },
      onOnline: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    const bot = createFeishuAccountBot({
      mesh: meshPort,
      local: service,
      inbox: createFeishuOfflineInbox(db),
      now: () => clockRef.now,
      log: () => {},
    });
    service.useAccountBot(bot);
    await service.start();
    const node: HubNode = {
      deviceId,
      name,
      root,
      db,
      ledger,
      service,
      bot,
      fake: nodeFake,
      submitted,
      submitDelay: null,
      lease,
      online: true,
      setLease(nextHolding, nextHolder, nextEpoch) {
        holding = nextHolding;
        holder = nextHolder;
        epoch = nextEpoch;
        for (const fn of leaseListeners) fn(nextHolder);
      },
    };
    nodeRef.current = node;
    nodes.set(deviceId, node);
    cleanups.push(async () => {
      bot.close();
      await service.close();
      ledger.close();
      db.close();
    });
    return node;
  };

  const notifyOnline = (cameOnline: DeviceId) => {
    const target = nodes.get(cameOnline);
    if (target !== undefined) target.online = true;
    for (const [id, set] of onlineListeners) {
      if (id !== cameOnline) for (const fn of set) fn(cameOnline);
    }
  };

  const deliverLive = async (node: HubNode, event: FeishuRawMessageEvent) => {
    node.fake.event(event);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await node.service.idle();
  };

  return { fakeFeishu: sharedFeishu, nodes, makeNode, notifyOnline, deliverLive };
}
