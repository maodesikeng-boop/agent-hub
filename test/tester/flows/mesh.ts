// Runners for mesh flows. They reach the remote computer only through the local instance's /d/<deviceId>/ proxy.
import WebSocket from "ws";
import { API_PATHS, WS_HEARTBEAT_TEXT, type AccountStatusView } from "../../../src/shared/index.ts";
import type { RemoteInstanceConfig } from "../bench.ts";
import type { FlowContext, FlowRunner } from "../types.ts";
import { ExternalServiceError } from "../verdict.ts";
import { ensureBenchPm, runner, runTag, sleep, vendorPm, waitFor } from "./common.ts";

const COLD_DIALS = 10;
const COLD_DIAL_TIMEOUT_MS = 15_000;
const DIALS_NEEDED = 9;
const DIAL_P90_MS = 6_000;
const ONLINE_WITHIN_MS = 15_000;
const IDLE_WATCH_MS = 120_000;
const IDLE_POLL_MS = 5_000;
const CHAT_REPLY_MS = 120_000;

function remoteDeviceId(ctx: FlowContext): string {
  return ctx.bench.config.instances.find((i): i is RemoteInstanceConfig => i.role === "remote")!.deviceId;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

/** Each dial follows a restart of the local computer, so the proxy has no pooled connection and must dial through the relay. */
const coldDial = runner(async (ctx, obs) => {
  await ctx.bench.remote().account();
  const local = ctx.bench.local();
  const mode = local.mode ?? "fake";
  const path = `/d/${encodeURIComponent(remoteDeviceId(ctx))}${API_PATHS.routerDigest}`;
  const lines: string[] = [];
  const ok: number[] = [];
  for (let i = 1; i <= COLD_DIALS; i++) {
    await local.restart(mode);
    const connected = await waitFor(async () => {
      const view = await local.api.json<AccountStatusView>("GET", API_PATHS.account, undefined, ctx.signal);
      return view.state === "signed_in" && view.relay === "connected" ? true : undefined;
    }, COLD_DIAL_TIMEOUT_MS, ctx.signal, 250);
    if (connected === null) {
      lines.push(`${i}: the local daemon did not connect to the relay`);
      continue;
    }
    const started = performance.now();
    const status = await local.api
      .request("GET", path, undefined, AbortSignal.any([ctx.signal, AbortSignal.timeout(COLD_DIAL_TIMEOUT_MS)]))
      .then(async (res) => (await res.arrayBuffer(), res.status))
      .catch((error: unknown) => `error ${error instanceof Error ? error.message : String(error)}`);
    const ms = Math.round(performance.now() - started);
    lines.push(`dial ${i} HTTP ${status} TIME ${ms} ms`);
    if (status === 200) ok.push(ms);
  }
  obs.save("dials.txt", `${lines.join("\n")}\n`);
  obs.metrics.dialsOk = ok.length;
  obs.metrics.p90Ms = percentile(ok, 90);
  obs.check("dials-succeed", ok.length >= DIALS_NEEDED, `${ok.length} of ${COLD_DIALS} dials returned HTTP 200`);
  obs.check("dial-latency", obs.metrics.p90Ms < DIAL_P90_MS, `p90 ${obs.metrics.p90Ms} ms over ${ok.length} successful dials`);
});

async function remoteSeesLocalOnline(ctx: FlowContext, localId: string | null): Promise<boolean | null> {
  const presence = ctx.bench.remote().presence;
  if (presence === undefined || localId === null) throw new ExternalServiceError("bench", "remote presence requires the test SSH command and a signed-in local device");
  const output = await presence().catch((error: unknown) => {
    throw new ExternalServiceError("bench", `remote status presence failed: ${String(error)}. Update the remote test command from the checkout.`);
  });
  const row = output.split("\n").find((line) => line.startsWith(`presence ${localId} `));
  return row === undefined ? null : row === `presence ${localId} online`;
}

const routerSeesOnline = runner(async (ctx, obs) => {
  const local = ctx.bench.local();
  const localId = (await local.account()).deviceId;
  await remoteSeesLocalOnline(ctx, localId);
  await local.restart(local.mode ?? "fake");
  const started = Date.now();
  const lines: string[] = [`local restarted ${new Date(started).toISOString()} as ${localId}`];
  const online = await waitFor(async () => ((await remoteSeesLocalOnline(ctx, localId)) === true ? true : undefined), ONLINE_WITHIN_MS * 2, ctx.signal, 500);
  const onlineMs = Date.now() - started;
  lines.push(online === null ? `not online after ${onlineMs} ms` : `online after ${onlineMs} ms`);
  obs.metrics.onlineMs = online === null ? -1 : onlineMs;
  obs.check("online-within", online !== null && onlineMs <= ONLINE_WITHIN_MS, lines.at(-1)!);
  const flaps: string[] = [];
  const watchEnd = Date.now() + IDLE_WATCH_MS;
  while (online !== null && Date.now() < watchEnd) {
    await sleep(IDLE_POLL_MS, ctx.signal);
    const seen = await remoteSeesLocalOnline(ctx, localId).catch((error: unknown) => `error ${String(error)}`);
    lines.push(`${new Date().toISOString()} ${String(seen)}`);
    if (seen !== true) flaps.push(`${new Date().toISOString()} ${String(seen)}`);
  }
  obs.check("no-flap", online !== null && flaps.length === 0, online === null ? "never came online" : flaps.length === 0 ? `online for ${IDLE_WATCH_MS / 1000} s` : `reported not online at ${flaps.join(", ")}`);
  obs.save("presence.txt", `${lines.join("\n")}\n`);
});

interface StreamWatch {
  frames: string[];
  sawMessage(id: number): boolean;
  close(): void;
}

async function watchStream(ctx: FlowContext): Promise<StreamWatch> {
  const api = ctx.bench.local().api;
  const url = `${api.origin.replace(/^http/, "ws")}/d/${encodeURIComponent(remoteDeviceId(ctx))}${API_PATHS.ws}`;
  const socket = new WebSocket(url, { headers: { cookie: api.cookie, origin: api.origin } });
  const frames: string[] = [];
  socket.on("message", (data) => {
    const text = String(data);
    if (text !== WS_HEARTBEAT_TEXT) frames.push(text);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", () => reject(new Error(`state stream ${url} did not open`)));
  });
  return {
    frames,
    sawMessage: (id) =>
      frames.some((f) => {
        try {
          const msg = JSON.parse(f) as { type?: string; data?: { message?: { id?: number } } };
          return (msg.type === "message.created" || msg.type === "message.updated") && msg.data?.message?.id === id;
        } catch {
          return false;
        }
      }),
    close: () => socket.close(),
  };
}

const crossDeviceChat = runner(async (ctx, obs) => {
  const remote = ctx.bench.remote();
  const reachable = await waitFor(async () => (await remote.health()).ok ? true : undefined, COLD_DIAL_TIMEOUT_MS, ctx.signal, 250);
  if (reachable === null) throw new ExternalServiceError("relay", "the remote test daemon was not reachable before opening the chat");
  const pm = await ensureBenchPm(remote, vendorPm("claude", "remote"));
  const stream = await watchStream(ctx);
  try {
    const t0 = Date.now();
    const sent = await remote.send(pm.conversationId, `Bench cross-device ${runTag()}: reply with the word pong.`);
    const reply = await remote.waitForReply(pm.conversationId, sent, CHAT_REPLY_MS).catch(() => null);
    obs.metrics.replyMs = reply === null ? -1 : Date.now() - t0;
    obs.check("reply-arrives", reply !== null, reply === null ? `no reply within ${CHAT_REPLY_MS / 1000} s` : `reply after ${obs.metrics.replyMs} ms`);
    const live = reply !== null && (await waitFor(async () => (stream.sawMessage(reply.id) ? true : undefined), 5_000, ctx.signal, 200)) !== null;
    obs.check("live-update", live, reply === null ? "no reply" : live ? `reply ${reply.id} arrived on the state stream` : `reply ${reply.id} never appeared on the state stream`);
    obs.save("timings.txt", `sent ${new Date(t0).toISOString()}\nreply ${obs.metrics.replyMs} ms\n`);
  } finally {
    stream.close();
    obs.save("state-stream.jsonl", `${stream.frames.join("\n")}\n`);
  }
});

export const meshRunners: Readonly<Record<string, FlowRunner>> = {
  "mesh.cold-dial": coldDial,
  "mesh.router-sees-online": routerSeesOnline,
  "mesh.cross-device-chat": crossDeviceChat,
};
