// Runners for Feishu flows. Each sends as the owner through the driver and judges only what Feishu itself returns.
import { z } from "zod";
import { API_PATHS, type AccountStatusView, type Message } from "../../../src/shared/index.ts";
import { BENCH_ASK_OPTIONS, BENCH_ASK_QUESTION, BENCH_ECHO_REPLY } from "../fake-script.ts";
import { FeishuReplyTimeout, isRecalled, visibleText, type FeishuDriver, type FeishuMessage, type TestChat } from "../feishu-driver.ts";
import { messagesAfter } from "../instance-client.ts";
import type { RemoteInstanceConfig } from "../bench.ts";
import type { FlowContext, FlowRunner } from "../types.ts";
import { ExternalServiceError } from "../verdict.ts";
import { ensureBenchPm, observeVendorFailure, recallCheck, runner, runTag, scenarioPm, sleep, waitFor, type Observation } from "./common.ts";

const OFFLINE_NOTICE = /现在离线|这会儿没接上/;
const TURN_FAILURE = /^[ \t]*没回成[：:]/m;
const REPLY_FAILURE = /^[ \t]*(?:(?:没办成|没回成|没送到|总助没开)[：:]|这段回复飞书显示不了[（(])|（没送到[：:]/m;
const CARD_RESULT = z.object({ status: z.string().optional(), config: z.object({ streaming_mode: z.boolean().optional() }).optional() });
const FAILED_STATUS = new Set(["error", "failed", "failure"]);
const GROUP_WAIT_MS = 60_000;
const LEASE_WAIT_MS = 60_000;
const CLOCK_SKEW_MS = 5_000;

function feishuOf(ctx: FlowContext): { driver: FeishuDriver; botAppId: string } {
  const botAppId = ctx.bench.config.feishu?.botAppId;
  if (ctx.feishu === null || botAppId === undefined) throw new ExternalServiceError("bench", "the Feishu driver is not available");
  return { driver: ctx.feishu, botAppId };
}

const fromBot = (botAppId: string) => (m: FeishuMessage) => m.senderType === "app" && m.senderId === botAppId;

function cardResult(message: FeishuMessage): z.infer<typeof CARD_RESULT> | null {
  if (message.msgType !== "interactive") return null;
  try {
    const result = CARD_RESULT.safeParse(JSON.parse(message.content));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function replyOutcome(message: FeishuMessage): "other" | "answer" | "failure" {
  if (isRecalled(message)) return "other";
  const card = cardResult(message);
  if (message.msgType === "interactive" && (card === null || card.config?.streaming_mode === true)) return "other";
  const text = visibleText(message);
  if ((card?.status !== undefined && FAILED_STATUS.has(card.status)) || REPLY_FAILURE.test(text)) return "failure";
  return text === "" || OFFLINE_NOTICE.test(text) ? "other" : "answer";
}

const terminalReply = (message: FeishuMessage) => replyOutcome(message) !== "other";
const answer = (message: FeishuMessage) => replyOutcome(message) === "answer";
function echoOrFailure(message: FeishuMessage): boolean {
  const outcome = replyOutcome(message);
  return outcome === "failure" || (outcome === "answer" && visibleText(message).includes(BENCH_ECHO_REPLY));
}
const replySummary = (message: FeishuMessage) => visibleText(message).slice(0, 120) || "card has a failed status";

async function routerChat(driver: FeishuDriver): Promise<string> {
  const chat = (await driver.testChats()).find((c) => c.kind === "router");
  if (chat === undefined) throw new ExternalServiceError("bench", "the test bot's 1-on-1 chat was not found. Check the owner binding and `ssh bellwood-tester status router-chats` on the paired test computer.");
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
async function botReply(driver: FeishuDriver, chatId: string, sent: string, done: (m: FeishuMessage) => boolean, timeoutMs: number, signal: AbortSignal): Promise<FeishuMessage | null> {
  try {
    return await driver.waitForBotMessage(chatId, sent, done, timeoutMs, signal);
  } catch (error) {
    if (error instanceof FeishuReplyTimeout) return null;
    throw error;
  }
}

interface MessageWindow {
  afterId?: string;
  excludeIds?: ReadonlySet<string>;
  expectFailure?: true;
}

async function finishFeishu(ctx: FlowContext, obs: Observation, chatId: string, since: number, botAppId: string, timings: string[], window: MessageWindow): Promise<FeishuMessage[]> {
  const raw = await ctx.feishu!.listMessages(chatId, Math.max(0, since - CLOCK_SKEW_MS));
  const anchor = window.afterId === undefined ? -1 : raw.findIndex((m) => m.messageId === window.afterId);
  const messages = raw.slice(anchor + 1).filter((m) => !window.excludeIds?.has(m.messageId));
  obs.json("messages.json", raw);
  recallCheck(obs, messages, botAppId);
  if (!window.expectFailure) {
    const failed = messages.filter((m) => fromBot(botAppId)(m) && replyOutcome(m) === "failure");
    for (const message of failed) {
      const text = visibleText(message);
      observeVendorFailure(obs, text.replace(REPLY_FAILURE, "").trim());
    }
    obs.check("no-error-card", failed.length === 0, failed.length === 0 ? "no error card" : `${failed.length} error card(s): ${replySummary(failed[0]!)}`);
  }
  obs.save("timings.txt", `${timings.join("\n")}\n`);
  return messages;
}

const dmRouter = runner(async (ctx, obs) => {
  const { driver, botAppId } = feishuOf(ctx);
  const chatId = await routerChat(driver);
  const t0 = Date.now();
  const sent = await driver.sendAsUser(chatId, `Bench check ${runTag()}: answer with one short line.`);
  const reply = await botReply(driver, chatId, sent, terminalReply, 90_000, ctx.signal);
  obs.metrics.replyMs = reply === null ? -1 : Date.now() - t0;
  obs.check("reply-arrives", reply !== null, reply === null ? "no test bot message within 90 s" : `first reply after ${obs.metrics.replyMs} ms`);
  obs.check("reply-final", reply !== null && answer(reply), reply === null ? "no final reply with text" : `final: ${replySummary(reply)}`);
  await finishFeishu(ctx, obs, chatId, t0, botAppId, [`sent ${new Date(t0).toISOString()}`, `reply ${obs.metrics.replyMs} ms`], { afterId: sent });
  await saveLogs(ctx, obs, true, true);
});

const groupRoundTrip = runner(async (ctx, obs) => {
  const { driver, botAppId } = feishuOf(ctx);
  const pm = await ensureBenchPm(ctx.bench.local(), scenarioPm("echo"));
  const chatId = await pmGroup(ctx, driver, pm.pmId);
  const t0 = Date.now();
  const sent = await driver.sendAsUser(chatId, `bench round trip ${runTag()}`);
  const reply = await botReply(driver, chatId, sent, echoOrFailure, 60_000, ctx.signal);
  obs.metrics.replyMs = reply === null ? -1 : Date.now() - t0;
  const messages = await finishFeishu(ctx, obs, chatId, t0, botAppId, [`sent ${new Date(t0).toISOString()}`, `reply ${obs.metrics.replyMs} ms`], { afterId: sent });
  const offline = messages.filter((m) => fromBot(botAppId)(m) && OFFLINE_NOTICE.test(visibleText(m)));
  obs.check("not-offline", offline.length === 0, offline.length === 0 ? "no offline notice" : `offline notice: ${visibleText(offline[0]!)}`);
  obs.check("reply-arrives", reply !== null && obs.metrics.replyMs <= 30_000, reply === null ? "no final reply within 60 s" : `reply card after ${obs.metrics.replyMs} ms`);
  obs.check("reply-text", reply !== null && answer(reply) && visibleText(reply).includes(BENCH_ECHO_REPLY), reply === null ? "no reply" : `card text: ${replySummary(reply)}`);
  await saveLogs(ctx, obs, true, true);
});

const failedTurnCard = runner(async (ctx, obs) => {
  const { driver, botAppId } = feishuOf(ctx);
  const pm = await ensureBenchPm(ctx.bench.local(), scenarioPm("fail"));
  const chatId = await pmGroup(ctx, driver, pm.pmId);
  const t0 = Date.now();
  const sent = await driver.sendAsUser(chatId, `bench failing turn ${runTag()}`);
  const shown = await botReply(driver, chatId, sent, (m) => replyOutcome(m) === "failure" && TURN_FAILURE.test(visibleText(m)), 60_000, ctx.signal);
  obs.metrics.reasonMs = shown === null ? -1 : Date.now() - t0;
  obs.check("reason-shown", shown !== null && obs.metrics.reasonMs <= 30_000, shown === null ? "no failed turn note within 60 s" : `shown after ${obs.metrics.reasonMs} ms: ${replySummary(shown)}`);
  await finishFeishu(ctx, obs, chatId, t0, botAppId, [`sent ${new Date(t0).toISOString()}`, `reason ${obs.metrics.reasonMs} ms`], { afterId: sent, expectFailure: true });
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
  let sent: string;
  try {
    sent = await driver.sendAsUser(chatId, `bench offline ${runTag()}`);
    const notice = await botReply(driver, chatId, sent, (m) => OFFLINE_NOTICE.test(visibleText(m)), 30_000, ctx.signal);
    obs.check("offline-notice", notice !== null, notice === null ? "no offline notice within 30 s" : `notice after ${Date.now() - t0} ms`);
  } finally {
    await local.start(mode);
  }
  const back = Date.now();
  const reply = await botReply(driver, chatId, sent, echoOrFailure, 90_000, ctx.signal);
  obs.metrics.replayMs = reply === null ? -1 : Date.now() - back;
  obs.check("replayed", reply !== null && answer(reply) && obs.metrics.replayMs <= 60_000, reply === null ? "no reply within 90 s of the restart" : `reply after ${obs.metrics.replayMs} ms: ${replySummary(reply)}`);
  await sleep(10_000, ctx.signal);
  const messages = await finishFeishu(ctx, obs, chatId, t0, botAppId, [`stopped and sent ${new Date(t0).toISOString()}`, `restarted ${new Date(back).toISOString()}`, `replay ${obs.metrics.replayMs} ms`], { afterId: sent });
  const replies = messages.filter((m) => fromBot(botAppId)(m) && answer(m) && visibleText(m).includes(BENCH_ECHO_REPLY));
  obs.check("single-reply", replies.length === 1, `${replies.length} replies`);
  await saveLogs(ctx, obs, true, true);
});

const reconnectCatchUp = runner(async (ctx, obs) => {
  const { driver, botAppId } = feishuOf(ctx);
  const remote = ctx.bench.remote();
  if (!remote.stop || !remote.start) throw new ExternalServiceError("bench", "the bench has no remote control");
  const chatId = await routerChat(driver);
  await remote.stop().catch((error: unknown) => { throw new ExternalServiceError("bench", `could not stop the remote test daemon: ${String(error)}`); });
  const t0 = Date.now();
  let sent: string;
  try {
    sent = await driver.sendAsUser(chatId, `Bench catch-up ${runTag()}: answer with one short line.`);
  } finally {
    await remote.start("real").catch((error: unknown) => { throw new ExternalServiceError("bench", `could not confirm the remote test daemon restarted: ${String(error)}`); });
  }
  const restarted = Date.now();
  const reply = await botReply(driver, chatId, sent, terminalReply, 120_000, ctx.signal);
  const elapsed = Date.now() - restarted;
  await sleep(15_000, ctx.signal);
  const messages = await finishFeishu(ctx, obs, chatId, t0, botAppId, [`sent during restart ${new Date(t0).toISOString()}`, `restarted ${new Date(restarted).toISOString()}`], { afterId: sent });
  const finals = messages.filter((m) => fromBot(botAppId)(m) && terminalReply(m));
  const ok = reply !== null && answer(reply) && finals.length === 1;
  obs.check("answered-once", ok, reply === null ? "no answer within 120 s of the restart" : `${finals.length} final response(s); first after ${elapsed} ms: ${replySummary(reply)}`);
  await saveLogs(ctx, obs, true, true);
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
  const chatId = await routerChat(driver);
  let sent: string;
  let t0: number;
  try {
    await remote.stop().catch((error: unknown) => { throw new ExternalServiceError("bench", `could not stop the remote test daemon: ${String(error)}`); });
    const stopped = Date.now();
    const moved = await waitFor(async () => (localId !== null && (await holder(ctx)) === localId ? true : undefined), LEASE_WAIT_MS, ctx.signal);
    leases.push(`after remote stop: ${await holder(ctx)} (${Date.now() - stopped} ms)`);
    obs.check("lease-moved", moved !== null, moved === null ? `the local computer did not take the lease within ${LEASE_WAIT_MS / 1000} s` : "the local computer holds the lease");
    t0 = Date.now();
    sent = await driver.sendAsUser(chatId, `Bench failover ${runTag()}: answer with one short line.`);
    const reply = await botReply(driver, chatId, sent, terminalReply, 120_000, ctx.signal);
    obs.check("dm-answered", reply !== null && answer(reply), reply === null ? "no answer while the local computer held the lease" : `response after ${Date.now() - t0} ms: ${replySummary(reply)}`);
  } finally {
    await remote.start("real").catch((error: unknown) => { throw new ExternalServiceError("bench", `could not restore the remote test daemon: ${String(error)}`); });
  }
  const started = Date.now();
  const returned = await waitFor(async () => ((await holder(ctx)) === remoteId ? true : undefined), LEASE_WAIT_MS, ctx.signal);
  leases.push(`after remote start: ${await holder(ctx)} (${Date.now() - started} ms)`);
  obs.check("lease-returned", returned !== null, returned === null ? `the lease did not return within ${LEASE_WAIT_MS / 1000} s` : "the remote computer holds the lease again");
  obs.save("leases.txt", `${leases.join("\n")}\n`);
  await finishFeishu(ctx, obs, chatId, t0, botAppId, [], { afterId: sent });
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
  const card = await waitFor(async () => (await driver.listMessages(chatId, Math.max(0, t0 - CLOCK_SKEW_MS))).find((m) => !existingIds.has(m.messageId) && fromBot(botAppId)(m) && answer(m) && visibleText(m).includes(BENCH_ASK_QUESTION)), 60_000, ctx.signal);
  const cardMs = Date.now() - t0;
  obs.check("card-posted", card !== null && cardMs <= 30_000, card === null ? "no decision card in the PM group within 60 s" : `card after ${cardMs} ms`);
  if (card !== null) obs.save("card-before.json", `${card.content}\n`);
  if (ask === null || card === null) {
    obs.check("card-settled", false, ask === null ? "the PM never asked" : "no card to settle");
  } else {
    const answered = Date.now();
    await local.api.json("POST", API_PATHS.askAnswer(ask.id), { clientId: crypto.randomUUID(), optionIndex: 0, choice: BENCH_ASK_OPTIONS[0] });
    const after = await waitFor(async () => (await driver.listMessages(chatId, Math.max(0, t0 - CLOCK_SKEW_MS))).find((m) => m.messageId === card.messageId && m.updateTime > card.updateTime && answer(m) && visibleText(m).includes(BENCH_ASK_OPTIONS[0])), 30_000, ctx.signal);
    if (after !== null) obs.save("card-after.json", `${after.content}\n`);
    const ms = after === null ? -1 : Date.now() - answered;
    obs.check("card-settled", after !== null && ms <= 15_000, after === null ? "the card was not updated in place with the chosen option within 30 s" : `updated ${ms} ms after the desktop answer`);
  }
  await finishFeishu(ctx, obs, chatId, t0, botAppId, [], { excludeIds: existingIds });
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
