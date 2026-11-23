// Runners for Feishu flows. Each sends as the owner through the driver and judges only what Feishu itself returns.
import { API_PATHS, type AccountStatusView, type Message } from "../../../src/shared/index.ts";
import { BENCH_ASK_OPTIONS, BENCH_ASK_QUESTION, BENCH_ECHO_REPLY } from "../fake-script.ts";
import { isRecalled, visibleText, type FeishuDriver, type FeishuMessage, type TestChat } from "../feishu-driver.ts";
import { messagesAfter } from "../instance-client.ts";
import type { RemoteInstanceConfig } from "../bench.ts";
import type { FlowContext, FlowRunner } from "../types.ts";
import { ExternalServiceError } from "../verdict.ts";
import { ensureBenchPm, recallCheck, runner, runTag, scenarioPm, waitFor, type Observation } from "./common.ts";

/** Texts the hub posts when the computer owning a group is offline or not connected. */
const OFFLINE_NOTICE = /现在离线|这会儿没接上/;
/** Prefix of the note a reply card carries when the turn failed. */
const FAILED_TURN_NOTE = "没回成";
const GROUP_WAIT_MS = 60_000;
const LEASE_WAIT_MS = 60_000;
const CLOCK_SKEW_MS = 5_000;

function feishuOf(ctx: FlowContext): { driver: FeishuDriver; botAppId: string } {
  const botAppId = ctx.bench.config.feishu?.botAppId;
  if (ctx.feishu === null || botAppId === undefined) throw new ExternalServiceError("bench", "the Feishu driver is not available");
  return { driver: ctx.feishu, botAppId };
}

const fromBot = (botAppId: string) => (m: FeishuMessage) => m.senderType === "app" && m.senderId === botAppId;

/** True unless the message is a card still in streaming mode. */
export function isFinal(message: Pick<FeishuMessage, "msgType" | "content">): boolean {
  if (message.msgType !== "interactive") return true;
  try {
    return (JSON.parse(message.content) as { config?: { streaming_mode?: boolean } }).config?.streaming_mode !== true;
  } catch {
    return true;
  }
}

async function routerChat(driver: FeishuDriver): Promise<string> {
  const chat = (await driver.testChats()).find((c) => c.kind === "router");
  if (chat === undefined) throw new Error("the test bot has no 1-on-1 chat with the owner; send it one message to bind the owner");
  return chat.chatId;
}

async function pmGroup(ctx: FlowContext, driver: FeishuDriver, pmId: number): Promise<string> {
  const deviceId = (await ctx.bench.local().account()).deviceId;
  const match = (chats: TestChat[]) => chats.find((c) => c.kind === "project" && c.deviceId === deviceId && c.pmId === pmId);
  const chat = await waitFor(async () => match(await driver.testChats()), GROUP_WAIT_MS, ctx.signal);
  if (chat === null) throw new Error(`no Feishu project group for PM ${pmId} on device ${deviceId} within ${GROUP_WAIT_MS / 1000} s`);
  return chat.chatId;
}

async function saveLogs(ctx: FlowContext, obs: Observation, local: boolean, remote: boolean): Promise<void> {
  if (local) obs.save("local-daemon.log", await ctx.bench.local().logs(300));
  const logs = ctx.bench.hasRemote() ? ctx.bench.remote().logs : undefined;
  if (remote) obs.save("remote-daemon.log", logs ? await logs(300).catch((e: unknown) => `remote logs unavailable: ${String(e)}`) : "the bench has no remote control\n");
}

/** Waits for a bot message after `sent` matching `done`; null at the deadline. */
async function botReply(driver: FeishuDriver, chatId: string, sent: string, botAppId: string, done: (m: FeishuMessage) => boolean, timeoutMs: number): Promise<FeishuMessage | null> {
  return driver.waitForBotMessage(chatId, sent, (m) => fromBot(botAppId)(m) && done(m), timeoutMs).catch(() => null);
}

async function finishFeishu(ctx: FlowContext, obs: Observation, chatId: string, since: number, botAppId: string, timings: string[], afterMessageId?: string): Promise<FeishuMessage[]> {
  const raw = await ctx.feishu!.listMessages(chatId, Math.max(0, since - CLOCK_SKEW_MS));
  const anchor = afterMessageId === undefined ? -1 : raw.findIndex((m) => m.messageId === afterMessageId);
  const messages = anchor >= 0 ? raw.slice(anchor + 1) : raw;
  obs.json("messages.json", raw);
  recallCheck(obs, messages, botAppId);
  obs.save("timings.txt", `${timings.join("\n")}\n`);
  return messages;
}

const dmRouter = runner(async (ctx, obs) => {
  const { driver, botAppId } = feishuOf(ctx);
  const chatId = await routerChat(driver);
  const t0 = Date.now();
  const sent = await driver.sendAsUser(chatId, `Bench check ${runTag()}: answer with one short line.`);
  const reply = await botReply(driver, chatId, sent, botAppId, (m) => !isRecalled(m), 90_000);
  obs.metrics.replyMs = reply === null ? -1 : Date.now() - t0;
  obs.check("reply-arrives", reply !== null, reply === null ? "no test bot message within 90 s" : `first reply after ${obs.metrics.replyMs} ms`);
  const final = reply && (await waitFor(async () => (await driver.listMessages(chatId, Math.max(0, t0 - CLOCK_SKEW_MS))).find((m) => m.messageId === reply.messageId && isFinal(m) && visibleText(m) !== ""), 60_000, ctx.signal));
  obs.check("reply-final", final !== null, final === null ? "the reply card never left streaming mode with text" : `final: ${visibleText(final).slice(0, 80)}`);
  await finishFeishu(ctx, obs, chatId, t0, botAppId, [`sent ${new Date(t0).toISOString()}`, `reply ${obs.metrics.replyMs} ms`], sent);
});

const groupRoundTrip = runner(async (ctx, obs) => {
  const { driver, botAppId } = feishuOf(ctx);
  const pm = await ensureBenchPm(ctx.bench.local(), scenarioPm("echo"));
  const chatId = await pmGroup(ctx, driver, pm.pmId);
  const t0 = Date.now();
  const sent = await driver.sendAsUser(chatId, `bench round trip ${runTag()}`);
  const reply = await botReply(driver, chatId, sent, botAppId, (m) => isFinal(m) && visibleText(m).includes(BENCH_ECHO_REPLY), 60_000);
  obs.metrics.replyMs = reply === null ? -1 : Date.now() - t0;
  const messages = await finishFeishu(ctx, obs, chatId, t0, botAppId, [`sent ${new Date(t0).toISOString()}`, `reply ${obs.metrics.replyMs} ms`], sent);
  const offline = messages.filter((m) => fromBot(botAppId)(m) && OFFLINE_NOTICE.test(visibleText(m)));
  obs.check("not-offline", offline.length === 0, offline.length === 0 ? "no offline notice" : `offline notice: ${visibleText(offline[0]!)}`);
  obs.check("reply-arrives", reply !== null && obs.metrics.replyMs <= 30_000, reply === null ? "no final reply within 60 s" : `reply card after ${obs.metrics.replyMs} ms`);
  obs.check("reply-text", reply !== null && visibleText(reply).includes(BENCH_ECHO_REPLY), reply === null ? "no reply" : `card text: ${visibleText(reply).slice(0, 120)}`);
  await saveLogs(ctx, obs, true, true);
});

const failedTurnCard = runner(async (ctx, obs) => {
  const { driver, botAppId } = feishuOf(ctx);
  const pm = await ensureBenchPm(ctx.bench.local(), scenarioPm("fail"));
  const chatId = await pmGroup(ctx, driver, pm.pmId);
  const t0 = Date.now();
  const sent = await driver.sendAsUser(chatId, `bench failing turn ${runTag()}`);
  const shown = await botReply(driver, chatId, sent, botAppId, (m) => !isRecalled(m) && visibleText(m).includes(FAILED_TURN_NOTE), 60_000);
  obs.metrics.reasonMs = shown === null ? -1 : Date.now() - t0;
  obs.check("reason-shown", shown !== null && obs.metrics.reasonMs <= 30_000, shown === null ? `no test bot message containing ${FAILED_TURN_NOTE} within 60 s` : `shown after ${obs.metrics.reasonMs} ms: ${visibleText(shown).slice(0, 120)}`);
  await finishFeishu(ctx, obs, chatId, t0, botAppId, [`sent ${new Date(t0).toISOString()}`, `reason ${obs.metrics.reasonMs} ms`], sent);
  await saveLogs(ctx, obs, true, false);
});

const offlineInboxReplay = runner(async (ctx, obs) => {
  const { driver, botAppId } = feishuOf(ctx);
  const local = ctx.bench.local();
  const pm = await ensureBenchPm(local, scenarioPm("echo"));
  const chatId = await pmGroup(ctx, driver, pm.pmId);
  const mode = local.mode ?? "fake";
  await local.stop();
  const t0 = Date.now();
  const sent = await driver.sendAsUser(chatId, `bench offline ${runTag()}`);
  const notice = await botReply(driver, chatId, sent, botAppId, (m) => OFFLINE_NOTICE.test(visibleText(m)), 30_000);
  obs.check("offline-notice", notice !== null, notice === null ? "no offline notice within 30 s" : `notice after ${Date.now() - t0} ms`);
  await local.start(mode);
  const back = Date.now();
  const reply = await botReply(driver, chatId, sent, botAppId, (m) => isFinal(m) && visibleText(m).includes(BENCH_ECHO_REPLY), 90_000);
  obs.metrics.replayMs = reply === null ? -1 : Date.now() - back;
  obs.check("replayed", reply !== null && obs.metrics.replayMs <= 60_000, reply === null ? "no reply within 90 s of the restart" : `reply ${obs.metrics.replayMs} ms after the restart`);
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  const messages = await finishFeishu(ctx, obs, chatId, t0, botAppId, [`stopped and sent ${new Date(t0).toISOString()}`, `restarted ${new Date(back).toISOString()}`, `replay ${obs.metrics.replayMs} ms`], sent);
  const replies = messages.filter((m) => fromBot(botAppId)(m) && visibleText(m).includes(BENCH_ECHO_REPLY));
  obs.check("single-reply", replies.length === 1, `${replies.length} replies`);
  await saveLogs(ctx, obs, true, true);
});

const reconnectCatchUp = runner(async (ctx, obs) => {
  const { driver, botAppId } = feishuOf(ctx);
  const remote = ctx.bench.remote();
  if (!remote.stop || !remote.start) throw new ExternalServiceError("bench", "the bench has no remote control");
  const chatId = await routerChat(driver);
  await remote.stop();
  const t0 = Date.now();
  const sent = await driver.sendAsUser(chatId, `Bench catch-up ${runTag()}: answer with one short line.`);
  await remote.start("real");
  const restarted = Date.now();
  const reply = await botReply(driver, chatId, sent, botAppId, (m) => isFinal(m) && visibleText(m) !== "" && !OFFLINE_NOTICE.test(visibleText(m)), 120_000);
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  const messages = await finishFeishu(ctx, obs, chatId, t0, botAppId, [`sent during restart ${new Date(t0).toISOString()}`, `restarted ${new Date(restarted).toISOString()}`], sent);
  const texts = messages.filter((m) => fromBot(botAppId)(m) && visibleText(m) !== "").map(visibleText);
  const duplicated = texts.find((t, i) => texts.indexOf(t) !== i);
  obs.check("answered-once", reply !== null && duplicated === undefined, reply === null ? "no answer within 120 s of the restart" : duplicated ? `answered twice: ${duplicated.slice(0, 80)}` : `answered after ${Date.now() - restarted} ms`);
  await saveLogs(ctx, obs, false, true);
});

async function holder(ctx: FlowContext): Promise<string | null> {
  const view = await ctx.bench.local().api.json<AccountStatusView>("GET", API_PATHS.account);
  return view.state === "signed_in" ? view.feishuHolder : null;
}

const hubFailover = runner(async (ctx, obs) => {
  const { driver, botAppId } = feishuOf(ctx);
  const remote = ctx.bench.remote();
  if (!remote.stop || !remote.start) throw new ExternalServiceError("bench", "the bench has no remote control");
  const localId = (await ctx.bench.local().account()).deviceId;
  const remoteId = ctx.bench.config.instances.find((i): i is RemoteInstanceConfig => i.role === "remote")!.deviceId;
  const leases: string[] = [`before: ${await holder(ctx)}`];
  await remote.stop();
  const stopped = Date.now();
  const moved = await waitFor(async () => ((await holder(ctx)) === localId ? true : undefined), LEASE_WAIT_MS, ctx.signal);
  leases.push(`after remote stop: ${await holder(ctx)} (${Date.now() - stopped} ms)`);
  obs.check("lease-moved", moved !== null, moved === null ? `the local computer did not take the lease within ${LEASE_WAIT_MS / 1000} s` : "the local computer holds the lease");
  const chatId = await routerChat(driver);
  const t0 = Date.now();
  const sent = await driver.sendAsUser(chatId, `Bench failover ${runTag()}: answer with one short line.`);
  const reply = await botReply(driver, chatId, sent, botAppId, (m) => isFinal(m) && visibleText(m) !== "", 120_000);
  obs.check("dm-answered", reply !== null, reply === null ? "no answer while the local computer held the lease" : `answered after ${Date.now() - t0} ms`);
  await remote.start("real");
  const started = Date.now();
  const returned = await waitFor(async () => ((await holder(ctx)) === remoteId ? true : undefined), LEASE_WAIT_MS, ctx.signal);
  leases.push(`after remote start: ${await holder(ctx)} (${Date.now() - started} ms)`);
  obs.check("lease-returned", returned !== null, returned === null ? `the lease did not return within ${LEASE_WAIT_MS / 1000} s` : "the remote computer holds the lease again");
  obs.save("leases.txt", `${leases.join("\n")}\n`);
  await finishFeishu(ctx, obs, chatId, t0, botAppId, [], sent);
  await saveLogs(ctx, obs, true, true);
});

const desktopAnswerSyncsCard = runner(async (ctx, obs) => {
  const { driver, botAppId } = feishuOf(ctx);
  const local = ctx.bench.local();
  const pm = await ensureBenchPm(local, scenarioPm("ask"));
  const chatId = await pmGroup(ctx, driver, pm.pmId);
  const t0 = Date.now();
  const existingIds = new Set((await driver.listMessages(chatId, Math.max(0, t0 - CLOCK_SKEW_MS))).map((m) => m.messageId));
  const userMessageId = await local.send(pm.conversationId, `bench ask ${runTag()}`);
  const ask = await waitFor(async () => (await messagesAfter(local.api, pm.conversationId, userMessageId)).find((m: Message) => m.meta?.needsUser === true), 60_000, ctx.signal);
  const card = await waitFor(async () => (await driver.listMessages(chatId, Math.max(0, t0 - CLOCK_SKEW_MS))).find((m) => !existingIds.has(m.messageId) && fromBot(botAppId)(m) && visibleText(m).includes(BENCH_ASK_QUESTION)), 60_000, ctx.signal);
  const cardMs = Date.now() - t0;
  obs.check("card-posted", card !== null && cardMs <= 30_000, card === null ? "no decision card in the PM group within 60 s" : `card after ${cardMs} ms`);
  if (card !== null) obs.save("card-before.json", `${card.content}\n`);
  if (ask === null || card === null) {
    obs.check("card-settled", false, ask === null ? "the PM never asked" : "no card to settle");
  } else {
    const answered = Date.now();
    await local.api.json("POST", API_PATHS.askAnswer(ask.id), { clientId: crypto.randomUUID(), optionIndex: 0, choice: BENCH_ASK_OPTIONS[0] });
    const after = await waitFor(async () => (await driver.listMessages(chatId, Math.max(0, t0 - CLOCK_SKEW_MS))).find((m) => m.messageId === card.messageId && m.updateTime > card.updateTime && visibleText(m).includes(BENCH_ASK_OPTIONS[0])), 30_000, ctx.signal);
    if (after !== null) obs.save("card-after.json", `${after.content}\n`);
    const ms = after === null ? -1 : Date.now() - answered;
    obs.check("card-settled", after !== null && ms <= 15_000, after === null ? "the card was not updated in place with the chosen option within 30 s" : `updated ${ms} ms after the desktop answer`);
  }
  await finishFeishu(ctx, obs, chatId, t0, botAppId, []);
});

export const feishuRunners: Readonly<Record<string, FlowRunner>> = {
  "feishu.dm-router": dmRouter,
  "feishu.group-round-trip": groupRoundTrip,
  "feishu.failed-turn-card": failedTurnCard,
  "feishu.offline-inbox-replay": offlineInboxReplay,
  "feishu.reconnect-catch-up": reconnectCatchUp,
  "feishu.hub-failover": hubFailover,
  "feishu.desktop-answer-syncs-card": desktopAnswerSyncsCard,
};

