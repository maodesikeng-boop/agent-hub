import { randomUUID } from "node:crypto";
import {
  DEFAULT_AGENT_VENDOR,
  LedgerRequestError,
  MAX_ATTACHMENTS_PER_MESSAGE,
  ROUTER_AGENT_TIMEOUT_MS,
  ROUTER_CLOSE_GRACE_MS,
  ROUTER_COMMAND_MAX_CHARS,
  ROUTER_FLEET_DIGEST_MAX_BYTES,
  ROUTER_MAX_CONCURRENT_TRACK_B,
  ROUTER_PEER_DISPATCH_TIMEOUT_MS,
  ROUTER_PROJECT_SHOW_PER_TURN_MAX,
  ROUTER_REPLY_MAX_CHARS,
  ROUTER_SESSION_CLEANUP_GRACE_MS,
  ROUTER_TRACK_B_QUEUE_MAX,
  turnFailureReason,
  type AgentVendor,
  type Driver,
  type ModelCatalog,
  type PmDigestEntry,
  type PostRouterCommandRequest,
  type RetryRouterCommandRequest,
  type RouterAgentDispatchInput,
  type RouterAgentPlan,
  type RouterCommandAttachment,
  type RouterCommandId,
  type RouterCommandRecord,
  type SessionId,
  type SessionTokens,
} from "../../shared/index.ts";
import { describeFailure } from "../../shared/errors.ts";
import { within } from "../driver/base-driver.ts";
import type { SqliteLedger } from "../ledger/index.ts";
import type { RouterDelivery } from "../ledger/router-command-retries.ts";
import type { RouterCommandRun } from "../ledger/router-command-deliveries.ts";
import { formatOpReceiptText, toDispatchedTarget } from "./delivery-receipt.ts";
import { resolveRouterModel, type ResolvedRouterModel } from "./model-resolver.ts";
import {
  ROUTER_RECENT_RECEIPTS_CONTEXT,
  formatFleetDigestForPrompt,
  type PromptDeviceDigest,
  type PromptReceiptAction,
  type PromptRecentReceipt,
} from "./prompt.ts";
import { planBaseOf, planBaseOfRequest, type PlanBase } from "./plan-base.ts";
import type { RouterSandboxGuard } from "./sandbox.ts";
import type { RouterTurnResult, RouterTurnRunner } from "./single-turn.ts";
import {
  RouterTargetError,
  routerTargetOpSchema,
  type DigestFetchResult,
  type RouterTargetOp,
  type RouterTargetPort,
  type RouterTargetRegistry,
} from "./target-port.ts";

interface ActiveTrackBState {
  readonly run: RouterCommandRun;
  sessionId: SessionId | null;
  readonly rawText: string;
  readonly attachmentIds: string[];
  deliveryFailure?: CommandFailure;
  readonly inflight: Set<Promise<unknown>>;
  projectShows: number;
  abort(reason: string): void;
}

export interface RouterDispatcherOptions {
  ledger: SqliteLedger;
  runTurn: RouterTurnRunner;
  sandboxGuard: RouterSandboxGuard;
  targetRegistry: Pick<
    RouterTargetRegistry,
    "selfDeviceId" | "getPort" | "listPorts" | "listAllDigests"
  >;
  models: { list(options?: { vendor?: AgentVendor }): Promise<ModelCatalog[]> };
  resolveAttachment: (id: string) => RouterCommandAttachment | null;
  agentTimeoutMs?: number;
  maxConcurrentTrackB?: number;
}

export interface RouterCommandRunOptions {
  background?: boolean;
}

export interface RouterDispatcher {
  submitCommand(input: PostRouterCommandRequest, options?: RouterCommandRunOptions): Promise<RouterCommandRecord>;
  retryCommand(commandId: RouterCommandId, retry: RetryRouterCommandRequest, options?: RouterCommandRunOptions): Promise<RouterCommandRecord>;
  handleAgentDispatch(
    sessionId: SessionId,
    commandId: RouterCommandId,
    payload: RouterAgentDispatchInput,
  ): Promise<{ text: string; data: unknown }>;
  busy(): boolean;
  close(): Promise<void>;
}

type AtMentionResolution =
  | {
      kind: "matched";
      port: RouterTargetPort;
      pm: PmDigestEntry;
      bodyText: string;
    }
  | {
      kind: "error";
      message: string;
    }
  | {
      kind: "fallthrough";
    };

function parseAtPrefix(text: string): { part1: string; part2: string | null; rest: string } | null {
  const match = /^\s*@([^\s/]+)(?:\/([^\s]+))?\s+([\s\S]+)$/.exec(text);
  if (!match) return null;
  const part1 = match[1]!.trim();
  const part2 = match[2]?.trim() || null;
  const rest = match[3]!;
  if (part1 === "" || rest.trim() === "") return null;
  return { part1, part2, rest };
}

function matchPmOnDigest(pms: readonly PmDigestEntry[], query: string): PmDigestEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const exact: PmDigestEntry[] = [];
  for (const pm of pms) {
    const pmIdTag = `#${pm.pmId}`;
    const pmExplicitTag = `pm#${pm.pmId}`;
    const projName = pm.project?.name.trim().toLowerCase() ?? "";
    const projExplicitTag = pm.project ? `project#${pm.project.id}` : "";
    const pmName = pm.name.trim().toLowerCase();
    if (
      q === projName ||
      q === pmName ||
      q === pmIdTag ||
      q === pmExplicitTag ||
      (projExplicitTag !== "" && q === projExplicitTag)
    ) {
      exact.push(pm);
    }
  }
  return exact;
}

function resolveAtMention(
  text: string,
  fleet: ReadonlyArray<{ port: RouterTargetPort; result: DigestFetchResult }>,
): AtMentionResolution {
  const parsed = parseAtPrefix(text);
  if (!parsed) return { kind: "fallthrough" };

  const { part1, part2, rest } = parsed;
  const part1Lower = part1.toLowerCase();

  if (part2 !== null) {
    const deviceEntry = fleet.find(
      (entry) =>
        (entry.port.isLocal && (part1Lower === "self" || part1 === "本机")) ||
        entry.port.deviceId.toLowerCase() === part1Lower ||
        entry.port.deviceName.toLowerCase() === part1Lower,
    );

    if (deviceEntry !== undefined) {
      if (!deviceEntry.result.online || !deviceEntry.result.digest) {
        return {
          kind: "error",
          message:
            deviceEntry.result.error ??
            `设备「${deviceEntry.port.deviceName}」当前离线，无法投递消息`,
        };
      }
      const matchedPms = matchPmOnDigest(deviceEntry.result.digest.pms, part2);
      if (matchedPms.length === 1) {
        return {
          kind: "matched",
          port: deviceEntry.port,
          pm: matchedPms[0]!,
          bodyText: rest,
        };
      }
      if (matchedPms.length > 1) {
        const choices = matchedPms
          .map((p) => `@${deviceEntry.port.deviceName}/pm#${p.pmId}（${p.name}）`)
          .join("、");
        return {
          kind: "error",
          message: `设备「${deviceEntry.port.deviceName}」上有多个同名目标（${choices}），请指定更具体的名称`,
        };
      }
      const available = deviceEntry.result.digest.pms
        .map((p) => p.project?.name ?? p.name)
        .slice(0, 6)
        .join("、");
      return {
        kind: "error",
        message: `设备「${deviceEntry.port.deviceName}」上找不到项目或项目经理「${part2}」${available ? `（可用：${available}）` : ""}`,
      };
    }

    // Non-device prefixes such as @tanstack/react-query use track A only when the full "part1/part2" is an online project name.
    const wholeToken = `${part1}/${part2}`;
    const wholeMatches: Array<{ port: RouterTargetPort; pm: PmDigestEntry }> = [];
    for (const entry of fleet) {
      if (!entry.result.online || !entry.result.digest) continue;
      for (const pm of matchPmOnDigest(entry.result.digest.pms, wholeToken)) {
        wholeMatches.push({ port: entry.port, pm });
      }
    }
    if (wholeMatches.length === 1) {
      return {
        kind: "matched",
        port: wholeMatches[0]!.port,
        pm: wholeMatches[0]!.pm,
        bodyText: rest,
      };
    }
    return { kind: "fallthrough" };
  }

  const matches: Array<{ port: RouterTargetPort; pm: PmDigestEntry }> = [];
  for (const entry of fleet) {
    if (!entry.result.online || !entry.result.digest) continue;
    for (const pm of matchPmOnDigest(entry.result.digest.pms, part1)) {
      matches.push({ port: entry.port, pm });
    }
  }
  if (matches.length === 1) {
    return {
      kind: "matched",
      port: matches[0]!.port,
      pm: matches[0]!.pm,
      bodyText: rest,
    };
  }
  if (matches.length > 1) {
    const disambig = matches
      .map((m) => `@${m.port.deviceName}/${m.pm.project?.name ?? m.pm.name}`)
      .join("、");
    return {
      kind: "error",
      message: `找到多个同名目标（${disambig}），请用 @设备名/项目名 指定`,
    };
  }

  const offlineDev = fleet.find(
    (entry) =>
      !entry.result.online &&
      (entry.port.deviceId.toLowerCase() === part1Lower ||
        entry.port.deviceName.toLowerCase() === part1Lower),
  );
  if (offlineDev !== undefined) {
    return {
      kind: "error",
      message:
        offlineDev.result.error ?? `设备「${offlineDev.port.deviceName}」当前离线，无法投递消息`,
    };
  }

  return { kind: "fallthrough" };
}

function buildRecentReceipts(records: readonly RouterCommandRecord[]): PromptRecentReceipt[] {
  const out: PromptRecentReceipt[] = [];
  for (const rec of records) {
    if (out.length >= ROUTER_RECENT_RECEIPTS_CONTEXT) break;
    const actions: PromptReceiptAction[] = [];
    for (const d of rec.dispatched ?? []) {
      const devId = d.deviceId;
      const devName = d.deviceName ?? d.deviceId;
      if (d.op === "worker.start" && d.workerId !== undefined && d.projectId != null) {
        actions.push({
          op: "worker.start",
          deviceId: devId,
          deviceName: devName,
          projectId: d.projectId,
          projectName: d.projectName ?? `#${d.projectId}`,
          workerId: d.workerId,
          ...(d.workerConversationId !== undefined ? { workerConversationId: d.workerConversationId } : {}),
          title: d.title ?? `Piece #${d.workerId}`,
          readonly: d.readonly ?? false,
        });
      } else if (
        (d.op === "worker.send" || d.op === "worker.stop" || d.op === "worker.end") &&
        d.workerId !== undefined
      ) {
        actions.push({
          op: d.op,
          deviceId: devId,
          deviceName: devName,
          workerId: d.workerId,
          ...(d.workerConversationId !== undefined ? { workerConversationId: d.workerConversationId } : {}),
          title: d.title ?? `Piece #${d.workerId}`,
        });
      } else if (d.op === "project.create" && d.projectId != null) {
        actions.push({
          op: "project.create",
          deviceId: devId,
          deviceName: devName,
          pmId: d.pmId,
          pmName: d.pmName ?? `PM #${d.pmId}`,
          projectId: d.projectId,
          projectName: d.projectName ?? `#${d.projectId}`,
          ...(d.conversationId !== undefined ? { conversationId: d.conversationId } : {}),
        });
      } else {
        actions.push({
          op: "pm.forward",
          deviceId: devId,
          deviceName: devName,
          pmId: d.pmId,
          pmName: d.pmName ?? `PM #${d.pmId}`,
          ...(d.conversationId !== undefined ? { conversationId: d.conversationId } : {}),
          verbatim: d.verbatim ?? true,
        });
      }
    }
    out.push({
      id: rec.id,
      text: rec.inputText,
      status: rec.status,
      actions,
      ...(rec.plan?.reply ? { replyNote: rec.plan.reply } : {}),
      createdAt: rec.createdAt,
    });
  }
  return out;
}

/** Join agent text with blank lines because Markdown merges single newlines; truncation is flagged with replyTruncated instead of a silent ellipsis. */
function cleanReply(chunks: readonly string[]): Pick<RouterAgentPlan, "reply" | "replyTruncated"> {
  const joined = chunks
    .map((c) => c.trim())
    .filter((c) => c !== "")
    .join("\n\n");
  const chars = [...joined];
  if (chars.length <= ROUTER_REPLY_MAX_CHARS) return { reply: joined };
  return { reply: chars.slice(0, ROUTER_REPLY_MAX_CHARS).join(""), replyTruncated: true };
}

function agentTimeoutMessage(timeoutMs: number): string {
  const minutes = timeoutMs / 60_000;
  const span = minutes >= 1 ? `${Math.round(minutes)} 分钟` : `${Math.max(1, Math.round(timeoutMs / 1000))} 秒`;
  return `总助规划超时（超过 ${span} 仍没结束，已自动停止），请重试或用 @设备名/项目名 直通发令`;
}

interface CommandFailure {
  error: string;
  errorRaw?: string;
}

function describeRaw(raw: string, vendor?: AgentVendor): CommandFailure {
  return { error: describeFailure(raw, vendor !== undefined ? { vendor } : {}).text, errorRaw: raw };
}

function failureOf(err: unknown, vendor?: AgentVendor): CommandFailure {
  if (err instanceof LedgerRequestError || err instanceof RouterTargetError) return { error: err.message };
  return describeRaw(err instanceof Error ? err.message : String(err), vendor);
}

function errorRawOf(failure: CommandFailure): Pick<RouterAgentPlan, "errorRaw"> {
  return failure.errorRaw !== undefined ? { errorRaw: failure.errorRaw } : {};
}

type TrackBParams = {
  commandId: RouterCommandId;
  rawText: string;
  attachmentIds: string[];
  planBase: PlanBase;
  preloadedFleet?: ReadonlyArray<{ port: RouterTargetPort; result: DigestFetchResult }>;
  startedAt: number;
};

function promptDevicesOf(fleet: ReadonlyArray<{ port: RouterTargetPort; result: DigestFetchResult }>): PromptDeviceDigest[] {
  return fleet.map(({ port, result }) => ({
    deviceId: port.isLocal ? "self" : port.deviceId,
    deviceName: port.deviceName,
    online: result.online,
    ...(result.stale ? { stale: true } : {}),
    ...(result.digest ? { generatedAt: result.digest.generatedAt } : {}),
    ...(result.digest?.omittedPms ? { omittedPms: result.digest.omittedPms } : {}),
    pms: (result.digest?.pms ?? []).map((pm) => ({
      pmId: pm.pmId,
      pmName: pm.name,
      mode: pm.mode,
      ...(pm.conversationId !== undefined ? { conversationId: pm.conversationId } : {}),
      activity: pm.activity,
      project: pm.project
        ? {
            id: pm.project.id,
            name: pm.project.name,
            mainFolder: pm.project.mainFolder,
            description: pm.project.description,
            catalog: pm.project.catalog ?? null,
          }
        : null,
      recentBrief: pm.recentBrief,
      activeWorkers: pm.activeWorkers.map((w) => ({
        id: w.id,
        title: w.title,
        activity: w.activity,
        readonly: w.readonly ?? false,
      })),
      activeWorkerTotal: pm.activeWorkerTotal,
      pendingDecisionCount: pm.pendingDecisionCount,
    })),
  }));
}

function trackBTurnText(
  ledger: SqliteLedger,
  params: TrackBParams,
  fleet: ReadonlyArray<{ port: RouterTargetPort; result: DigestFetchResult }>,
): string {
  const recentRecords = ledger
    .listRouterCommands(undefined, ROUTER_RECENT_RECEIPTS_CONTEXT + 1)
    .commands.filter((c) => c.id !== params.commandId)
    .slice(0, ROUTER_RECENT_RECEIPTS_CONTEXT);
  const digestPrompt = formatFleetDigestForPrompt(promptDevicesOf(fleet), buildRecentReceipts(recentRecords), ROUTER_FLEET_DIGEST_MAX_BYTES);
  const attachmentNote =
    params.attachmentIds.length > 0
      ? `\n\n# 用户随附文件（共 ${params.attachmentIds.length} 个）\n已上传附件编号：${params.attachmentIds.join("、")}（调用 \`hub dispatch ... --verbatim\` 时守护进程会自动将附件随原文一并投递，无需手动处理路径）。`
      : "";
  return `${digestPrompt}${attachmentNote}\n\n# 当前用户指令\n<user_command>\n${params.rawText}\n</user_command>`;
}

type TrackBTurn = { result: RouterTurnResult; state: ActiveTrackBState; abortReason: string };

function recordTrackBOutcome(
  ledger: SqliteLedger,
  params: TrackBParams,
  resolved: ResolvedRouterModel,
  turn: TrackBTurn,
  agentTimeoutMs: number,
): RouterCommandRecord {
  const { result, state, abortReason } = turn;
  const timedOut = !result.ok && result.reason === "timeout";
  const turnOutcome: { ok: boolean } & Partial<CommandFailure> = result.ok
    ? { ok: true }
    : result.reason === "aborted"
      ? { ok: false, error: abortReason || "总助规划被打断，可点击重试" }
      : { ok: false, error: result.error, ...(result.errorRaw === undefined ? {} : { errorRaw: result.errorRaw }) };
  const durationMs = Math.max(0, Date.now() - params.startedAt);
  const replyPart = cleanReply([result.ok ? result.text : result.partialText]);

  const pending = ledger.routerCommandDeliveries.list(params.commandId);
  const dispatchedCount = ledger.getRouterCommand(params.commandId)?.dispatched?.length ?? 0;
  if (pending.length > 0 || dispatchedCount > 0) {
    const failure = pending.length > 0
      ? state.deliveryFailure ?? { error: "总助投递尚未完成，可点击重试" }
      : null;
    return ledger.updateRouterCommand(params.commandId, {
      status: failure === null ? "dispatched" : "failed",
      error: failure?.error ?? null,
      durationMs,
      plan: {
        intent: "dispatch",
        ...replyPart,
        actions: [],
        track: "B",
        ...params.planBase,
        ...(failure === null ? {} : errorRawOf(failure)),
      },
      auditAction: failure === null ? "router.command.dispatched" : "router.command.partial_failed",
      auditActor: "router_agent",
      auditDetail: { vendor: resolved.vendor, model: resolved.model, dispatchedCount, failedCount: pending.length, durationMs },
    });
  }

  if (!turnOutcome.ok) {
    const errMsg = timedOut ? agentTimeoutMessage(agentTimeoutMs) : (turnOutcome.error ?? "总助单轮规划失败");
    return ledger.updateRouterCommand(params.commandId, {
      status: "failed",
      error: errMsg,
      durationMs,
      plan: {
        intent: "answer",
        ...replyPart,
        actions: [],
        track: "B",
        ...params.planBase,
        ...(turnOutcome.errorRaw !== undefined ? { errorRaw: turnOutcome.errorRaw } : {}),
      },
      auditAction: timedOut ? "router.command.timeout" : "router.command.failed",
      auditActor: "router_agent",
      auditDetail: timedOut ? { durationMs } : { error: turnOutcome.errorRaw ?? errMsg },
    });
  }

  const finalAnswer = replyPart.reply || "当前指令未触发分派操作，请补充目标项目或设备信息。";
  return ledger.updateRouterCommand(params.commandId, {
    status: "answered",
    error: null,
    durationMs,
    plan: {
      intent: "answer",
      reply: finalAnswer,
      ...(replyPart.replyTruncated ? { replyTruncated: true } : {}),
      actions: [{ type: "answer", markdown: finalAnswer }],
      track: "B",
      ...params.planBase,
    },
    auditAction: "router.command.answered",
    auditActor: "router_agent",
    auditDetail: { durationMs },
  });
}

export function createRouterDispatcher(options: RouterDispatcherOptions): RouterDispatcher {
  const { ledger, runTurn, sandboxGuard, targetRegistry, models, resolveAttachment } = options;
  const agentTimeoutMs = options.agentTimeoutMs ?? ROUTER_AGENT_TIMEOUT_MS;
  const maxConcurrentTrackB = options.maxConcurrentTrackB ?? ROUTER_MAX_CONCURRENT_TRACK_B;

  const activeStates = new Map<RouterCommandId, ActiveTrackBState>();
  const runningPipelines = new Set<Promise<unknown>>();
  let runningTrackB = 0;
  const trackBWaiters: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  let closed = false;

  const acquireTrackBSlot = async (): Promise<() => void> => {
    if (closed) throw new LedgerRequestError("conflict", "总助分派引擎正在关闭");
    if (runningTrackB < maxConcurrentTrackB) {
      runningTrackB++;
    } else {
      if (trackBWaiters.length >= ROUTER_TRACK_B_QUEUE_MAX) {
        throw new LedgerRequestError("conflict", "当前总助并发规划指令过多，请稍后再试或用 @设备名/项目名 直通发令");
      }
      await new Promise<void>((resolve, reject) => {
        trackBWaiters.push({ resolve, reject });
      });
      runningTrackB++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      runningTrackB--;
      const next = trackBWaiters.shift();
      if (next) next.resolve();
    };
  };

  const resolvePortByDeviceSpec = (deviceSpec: string): RouterTargetPort => {
    const trimmed = deviceSpec.trim();
    const lower = trimmed.toLowerCase();
    if (trimmed === "" || lower === "self" || lower === "local" || trimmed === "本机") {
      const local = targetRegistry.getPort(targetRegistry.selfDeviceId()) ?? targetRegistry.getPort("self");
      if (local) return local;
    }
    const direct = targetRegistry.getPort(trimmed);
    if (direct) return direct;
    const byName = targetRegistry
      .listPorts()
      .find(
        (p) => p.deviceId.toLowerCase() === lower || p.deviceName.toLowerCase() === lower,
      );
    if (byName) return byName;
    throw new RouterTargetError("device_not_found", `找不到目标设备「${trimmed}」`);
  };

  const mapTargetErrorToLedger = (err: unknown): never => {
    if (err instanceof LedgerRequestError) throw err;
    if (err instanceof RouterTargetError) {
      const code =
        err.code === "device_not_found" || err.code === "not_found"
          ? "not_found"
          : err.code === "forbidden"
            ? "forbidden"
            : err.code === "invalid"
              ? "invalid"
              : "conflict";
      throw new LedgerRequestError(code, err.message);
    }
    throw err;
  };

  const deliveries = ledger.routerCommandDeliveries;

  async function executeDelivery(run: RouterCommandRun, delivery: RouterDelivery, port: RouterTargetPort, discardOnRejection = false) {
    const op = routerTargetOpSchema.parse(delivery.op);
    let result;
    try {
      result = await port.executeOp(op);
    } catch (error) {
      if (discardOnRejection && error instanceof RouterTargetError &&
          error.code !== "device_offline" && error.code !== "device_timeout") {
        deliveries.change(run, { kind: "discard", id: delivery.id });
      }
      throw error;
    }
    const receipt = toDispatchedTarget(port, result, delivery.verbatim);
    if (receipt === null || result.kind !== op.kind) throw new Error("Router target returned an unexpected delivery result");
    deliveries.change(run, { kind: "checkpoint", id: delivery.id, receipt });
    deliveries.change(run, { kind: "publish", id: delivery.id });
    return result;
  }

  const executeTrackAForward = async (params: {
    commandId: RouterCommandId;
    port: RouterTargetPort;
    pmId?: number;
    projectId?: number;
    bodyText: string;
    attachmentIds: string[];
    planBase: PlanBase;
    startedAt: number;
  }): Promise<RouterCommandRecord> => {
    const run = { commandId: params.commandId, retryId: params.planBase.retryId };
    const id = randomUUID();
    const op: RouterTargetOp = {
      kind: "pm.forward",
      clientId: id,
      ...(params.pmId !== undefined ? { pmId: params.pmId } : {}),
      ...(params.projectId !== undefined ? { projectId: params.projectId } : {}),
      text: params.bodyText,
      ...(params.attachmentIds.length > 0 ? { attachmentIds: params.attachmentIds } : {}),
    };
    const delivery = { id, deviceId: params.port.deviceId, op, verbatim: true };
    let failure: CommandFailure | null = null;
    try {
      deliveries.change(run, { kind: "prepare", delivery, track: "A" });
      await executeDelivery(run, delivery, params.port);
    } catch (error) {
      failure = failureOf(error);
    }
    return ledger.updateRouterCommand(params.commandId, {
      model: null,
      effort: null,
      status: failure === null ? "dispatched" : "failed",
      error: failure?.error ?? null,
      durationMs: Math.max(0, Date.now() - params.startedAt),
      plan: {
        intent: "dispatch",
        reply: "",
        actions: [],
        track: "A",
        ...params.planBase,
        ...(failure === null ? {} : errorRawOf(failure)),
      },
      auditAction: failure === null ? "router.command.track_a" : "router.command.track_a_failed",
      auditActor: "user",
      auditDetail: { deviceId: params.port.deviceId },
    });
  };

  const runTrackBTurn = async (
    params: TrackBParams,
    resolved: ResolvedRouterModel,
    turnText: string,
  ): Promise<TrackBTurn> => {
    const controller = new AbortController();
    let abortReason = "";
    const state: ActiveTrackBState = {
      run: { commandId: params.commandId, retryId: params.planBase.retryId },
      sessionId: null,
      rawText: params.rawText,
      attachmentIds: params.attachmentIds,
      inflight: new Set(),
      projectShows: 0,
      abort: (reason) => {
        abortReason = reason;
        controller.abort();
      },
    };
    activeStates.set(params.commandId, state);

    let result: RouterTurnResult;
    try {
      result = await runTurn({
        purpose: "dispatch",
        vendor: resolved.vendor,
        model: resolved.model,
        effort: resolved.effort,
        text: turnText,
        timeoutMs: agentTimeoutMs,
        signal: controller.signal,
        onSession: (sessionId) => {
          state.sessionId = sessionId;
          sandboxGuard.bind(sessionId, params.commandId);
          return () => {
            sandboxGuard.unbind(sessionId);
            state.sessionId = null;
          };
        },
      });
    } finally {
      activeStates.delete(params.commandId);
      // Late successes and failures are still recorded in the receipt.
      if (state.inflight.size > 0) {
        await within(Promise.allSettled([...state.inflight]), ROUTER_PEER_DISPATCH_TIMEOUT_MS);
      }
    }
    return { result, state, abortReason };
  };

  const executeTrackB = async (params: TrackBParams): Promise<RouterCommandRecord> => {
    let releaseSlot: () => void;
    try {
      releaseSlot = await acquireTrackBSlot();
    } catch (err) {
      // The command row already exists, so mark it failed (retryable) instead of leaving it in planning.
      const failure = failureOf(err);
      return ledger.updateRouterCommand(params.commandId, {
        status: "failed",
        error: failure.error,
        durationMs: Math.max(0, Date.now() - params.startedAt),
        plan: {
          intent: "answer",
          reply: "",
          actions: [],
          track: "B",
          ...params.planBase,
          ...errorRawOf(failure),
        },
        auditAction: "router.command.track_b_rejected",
        auditActor: "system",
        auditDetail: { error: failure.errorRaw ?? failure.error },
      });
    }
    try {
      const [fleet, catalogs] = await Promise.all([
        params.preloadedFleet ? Promise.resolve(params.preloadedFleet) : targetRegistry.listAllDigests(),
        models.list(),
      ]);

      const settings = ledger.getRouterSettings();
      const resolved = resolveRouterModel(settings, catalogs);
      if (!resolved.ok) {
        return ledger.updateRouterCommand(params.commandId, {
          status: "failed",
          error: resolved.message,
          durationMs: Math.max(0, Date.now() - params.startedAt),
          plan: {
            intent: "answer",
            reply: "",
            actions: [],
            track: "B",
            ...params.planBase,
          },
          auditAction: "router.command.model_unavailable",
          auditActor: "system",
          auditDetail: { code: resolved.code },
        });
      }

      ledger.updateRouterCommand(params.commandId, {
        vendor: resolved.vendor,
        model: resolved.model,
        effort: resolved.effort,
        status: "planning",
      });

      const turn = await runTrackBTurn(params, resolved, trackBTurnText(ledger, params, fleet));
      return recordTrackBOutcome(ledger, params, resolved, turn, agentTimeoutMs);
    } finally {
      releaseSlot();
    }
  };

  const track = <T>(p: Promise<T>): Promise<T> => {
    runningPipelines.add(p);
    const done = () => runningPipelines.delete(p);
    p.then(done, done);
    return p;
  };

  const runCommandPipeline = async (params: {
    commandId: RouterCommandId;
    text: string;
    attachmentIds: string[];
    planBase: PlanBase;
  }): Promise<RouterCommandRecord> => {
    const startedAt = Date.now();
    const explicitTarget = params.planBase.target;

    if (explicitTarget !== undefined) {
      let port: RouterTargetPort;
      try {
        port = resolvePortByDeviceSpec(explicitTarget.deviceId ?? "self");
      } catch (err) {
        const failure = failureOf(err);
        return ledger.updateRouterCommand(params.commandId, {
          model: null,
          effort: null,
          status: "failed",
          error: failure.error,
          durationMs: Math.max(0, Date.now() - startedAt),
          plan: {
            intent: "dispatch",
            reply: "",
            actions: [],
            track: "A",
            ...params.planBase,
            ...errorRawOf(failure),
          },
        });
      }
      return executeTrackAForward({
        commandId: params.commandId,
        port,
        pmId: explicitTarget.pmId,
        projectId: explicitTarget.projectId,
        bodyText: params.text,
        attachmentIds: params.attachmentIds,
        planBase: params.planBase,
        startedAt,
      });
    }

    let preloadedFleet: ReadonlyArray<{ port: RouterTargetPort; result: DigestFetchResult }> | undefined;
    if (params.planBase.routerOnly !== true && /^\s*@/.test(params.text)) {
      preloadedFleet = await targetRegistry.listAllDigests();
      const atRes = resolveAtMention(params.text, preloadedFleet);
      if (atRes.kind === "matched") {
        return executeTrackAForward({
          commandId: params.commandId,
          port: atRes.port,
          pmId: atRes.pm.pmId,
          bodyText: atRes.bodyText,
          attachmentIds: params.attachmentIds,
          planBase: params.planBase,
          startedAt,
        });
      }
      if (atRes.kind === "error") {
        return ledger.updateRouterCommand(params.commandId, {
          model: null,
          effort: null,
          status: "failed",
          error: atRes.message,
          durationMs: Math.max(0, Date.now() - startedAt),
          plan: {
            intent: "ambiguous",
            reply: "",
            actions: [],
            track: "A",
            ...params.planBase,
          },
          auditAction: "router.command.track_a_rejected",
          auditActor: "user",
          auditDetail: { error: atRes.message },
        });
      }
    }

    return executeTrackB({
      commandId: params.commandId,
      rawText: params.text,
      attachmentIds: params.attachmentIds,
      planBase: params.planBase,
      preloadedFleet,
      startedAt,
    });
  };

  const detach = (command: RouterCommandRecord, settled: Promise<RouterCommandRecord>): RouterCommandRecord => {
    settled.catch((err: unknown) => {
      try {
        const current = ledger.getRouterCommand(command.id);
        if (current?.status !== "planning" || current.plan?.retryId !== command.plan?.retryId) return;
        const hasPublishedDeliveries = !current.plan?.retryOps?.length && current.dispatched?.some((entry) => entry.ok);
        ledger.updateRouterCommand(command.id, {
          status: hasPublishedDeliveries ? "dispatched" : "failed",
          error: hasPublishedDeliveries ? null : failureOf(err).error,
        });
      } catch {
        // The database may already be closed during shutdown.
      }
    });
    return command;
  };

  return {
    async submitCommand(input: PostRouterCommandRequest, options?: RouterCommandRunOptions): Promise<RouterCommandRecord> {
      const clientId = input.clientId?.trim() ?? "";
      if (clientId === "") throw new LedgerRequestError("invalid", "缺少 clientId");

      const rawText = input.text ?? "";
      const attachmentIds = (input.attachmentIds ?? []).filter((id) => id.trim() !== "");
      if (attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        throw new LedgerRequestError("invalid", `单条指令最多附带 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件`);
      }
      if (rawText.trim() === "" && attachmentIds.length === 0) {
        throw new LedgerRequestError("invalid", "指令内容不能是空的");
      }
      if ([...rawText].length > ROUTER_COMMAND_MAX_CHARS) {
        throw new LedgerRequestError("invalid", `指令长度不能超过 ${ROUTER_COMMAND_MAX_CHARS} 字`);
      }

      const attachments = attachmentIds
        .map((id) => resolveAttachment(id))
        .filter((a): a is RouterCommandAttachment => a !== null);
      const planBase = planBaseOfRequest(input, attachmentIds, attachments);

      const initialVendor = ledger.getRouterSettings().vendor ?? DEFAULT_AGENT_VENDOR;
      const { command, deduplicated } = ledger.createRouterCommand({
        clientId,
        inputText: rawText,
        vendor: initialVendor,
        model: null,
        effort: null,
        status: "planning",
        plan: Object.keys(planBase).length > 0 ? { intent: "dispatch", reply: "", actions: [], ...planBase } : null,
        auditAction: "router.command.submit",
        auditActor: "user",
      });

      if (deduplicated) return command;

      const settled = track(runCommandPipeline({
        commandId: command.id,
        text: rawText,
        attachmentIds,
        planBase,
      }));
      return options?.background === true ? detach(command, settled) : settled;
    },

    async retryCommand(commandId: RouterCommandId, retry: RetryRouterCommandRequest, options?: RouterCommandRunOptions): Promise<RouterCommandRecord> {
      // Atomically claim retryId inside SQLite before starting any work so reused, stale, or concurrent retries never run twice.
      const planning = ledger.claimRouterCommandRetry(commandId, retry);
      const attachmentIds = planning.plan?.attachmentIds ?? [];
      const planBase: PlanBase = { ...planBaseOf(planning.plan), retryId: retry.retryId };
      const pending = deliveries.list(commandId);
      if (pending.length > 0) {
        const settled = track(resumeDeliveries(planning, planBase, pending));
        return options?.background === true ? detach(planning, settled) : settled;
      }

      // Keep the explicit target so a direct retry stays on track A instead of going through the model.
      const settled = track(runCommandPipeline({
        commandId,
        text: planning.inputText,
        attachmentIds,
        planBase,
      }));
      return options?.background === true ? detach(planning, settled) : settled;
    },

    async handleAgentDispatch(
      sessionId: SessionId,
      commandId: RouterCommandId,
      payload: RouterAgentDispatchInput,
    ): Promise<{ text: string; data: unknown }> {
      const state = activeStates.get(commandId);
      if (!state || state.sessionId !== sessionId) {
        throw new LedgerRequestError("forbidden", "总助调度会话已过期或与当前指令不匹配");
      }

      const isMutating = payload.op !== "worker-list" && payload.op !== "project-show";
      if (payload.op === "project-show" && ++state.projectShows > ROUTER_PROJECT_SHOW_PER_TURN_MAX) {
        throw new LedgerRequestError("conflict", `一轮最多查 ${ROUTER_PROJECT_SHOW_PER_TURN_MAX} 个项目档案，拿不准的转给项目经理`);
      }
      let port: RouterTargetPort;
      try {
        port = resolvePortByDeviceSpec(payload.device);
      } catch (err) {
        return mapTargetErrorToLedger(err);
      }

      const opClientId = randomUUID();
      let targetOp: RouterTargetOp;
      let usedVerbatim: boolean | undefined;

      switch (payload.op) {
        case "pm": {
          usedVerbatim = payload.verbatim === true;
          const text = usedVerbatim ? state.rawText : (payload.text ?? "");
          targetOp = {
            kind: "pm.forward",
            clientId: opClientId,
            ...(payload.pmId !== undefined ? { pmId: payload.pmId } : {}),
            ...(payload.projectId !== undefined ? { projectId: payload.projectId } : {}),
            text,
            ...(state.attachmentIds.length > 0 ? { attachmentIds: state.attachmentIds } : {}),
          };
          break;
        }
        case "worker-start": {
          usedVerbatim = payload.verbatim === true;
          const task = usedVerbatim ? state.rawText : (payload.task ?? "");
          targetOp = {
            kind: "worker.start",
            clientId: opClientId,
            projectId: payload.projectId,
            title: payload.title,
            task,
            ...(state.attachmentIds.length > 0 ? { attachmentIds: state.attachmentIds } : {}),
            ...(payload.vendor !== undefined ? { vendor: payload.vendor } : {}),
            ...(payload.model !== undefined ? { model: payload.model } : {}),
            ...(payload.effort !== undefined ? { effort: payload.effort } : {}),
            ...(payload.readonly !== undefined ? { readonly: payload.readonly } : {}),
            ...(payload.noWorktree !== undefined ? { noWorktree: payload.noWorktree } : {}),
            sourceCommandId: commandId,
          };
          break;
        }
        case "worker-send": {
          usedVerbatim = payload.verbatim === true;
          const text = usedVerbatim ? state.rawText : (payload.text ?? "");
          targetOp = {
            kind: "worker.send",
            clientId: opClientId,
            workerId: payload.workerId,
            text,
            ...(state.attachmentIds.length > 0 ? { attachmentIds: state.attachmentIds } : {}),
          };
          break;
        }
        case "worker-stop":
          targetOp = { kind: "worker.stop", workerId: payload.workerId };
          break;
        case "worker-end":
          targetOp = { kind: "worker.end", workerId: payload.workerId };
          break;
        case "worker-list":
          targetOp = {
            kind: "worker.list",
            ...(payload.projectId !== undefined ? { projectId: payload.projectId } : {}),
          };
          break;
        case "project-show":
          targetOp = { kind: "project.show", projectId: payload.projectId };
          break;
        case "project-create":
          targetOp = {
            kind: "project.create",
            clientId: opClientId,
            folder: payload.folder,
            ...(payload.name !== undefined ? { name: payload.name } : {}),
            ...(payload.pmName !== undefined ? { pmName: payload.pmName } : {}),
            ...(payload.vendor !== undefined ? { vendor: payload.vendor } : {}),
            ...(payload.mode !== undefined ? { mode: payload.mode } : {}),
          };
          break;
      }

      const task = executeAgentOp(state, port, targetOp, opClientId, usedVerbatim, isMutating);
      state.inflight.add(task);
      try {
        return await task;
      } finally {
        state.inflight.delete(task);
      }
    },

    busy(): boolean {
      return runningPipelines.size > 0 || activeStates.size > 0 || trackBWaiters.length > 0 || runningTrackB > 0;
    },

    async close(): Promise<void> {
      closed = true;
      for (const waiter of trackBWaiters.splice(0)) {
        waiter.reject(new LedgerRequestError("conflict", "总助分派引擎已关闭"));
      }
      for (const st of activeStates.values()) st.abort("守护进程正在关闭，总助规划中断，可点击重试");
      // Each pipeline interrupts its own session and writes its status; wait with a limit so no promise or timer dangles.
      if (runningPipelines.size > 0) {
        await within(Promise.allSettled([...runningPipelines]), ROUTER_CLOSE_GRACE_MS);
      }
    },
  };

  async function executeAgentOp(
    state: ActiveTrackBState,
    port: RouterTargetPort,
    op: RouterTargetOp,
    id: string,
    verbatim: boolean | undefined,
    isMutating: boolean,
  ): Promise<{ text: string; data: unknown }> {
    try {
      let result;
      if (isMutating) {
        const delivery = { id, deviceId: port.deviceId, op, verbatim };
        deliveries.change(state.run, { kind: "prepare", delivery, track: "B" });
        try {
          result = await executeDelivery(state.run, delivery, port, true);
        } catch (error) {
          state.deliveryFailure = failureOf(error);
          throw error;
        }
      } else {
        result = await port.executeOp(op);
      }
      return { text: formatOpReceiptText(port, result), data: result };
    } catch (error) {
      return mapTargetErrorToLedger(error);
    }
  }

  async function resumeDeliveries(
    command: RouterCommandRecord, planBase: PlanBase, pending: readonly RouterDelivery[],
  ): Promise<RouterCommandRecord> {
    const startedAt = Date.now();
    const run = { commandId: command.id, retryId: planBase.retryId };
    const failures: CommandFailure[] = [];
    for (const delivery of pending) {
      try {
        if (delivery.receipt !== undefined) {
          deliveries.change(run, { kind: "publish", id: delivery.id });
        } else {
          const port = targetRegistry.getPort(delivery.deviceId);
          if (port === null) throw new RouterTargetError("device_not_found", `找不到目标设备「${delivery.deviceId}」`);
          await executeDelivery(run, delivery, port);
        }
      } catch (error) {
        failures.push(failureOf(error));
      }
    }

    const status = failures.length === 0 ? "dispatched" : "failed";
    const rawErrors = failures.flatMap((failure) => failure.errorRaw ?? []);
    return ledger.updateRouterCommand(command.id, {
      status,
      error: failures.length === 0 ? null : failures.map((failure) => failure.error).join("；"),
      durationMs: Math.max(0, Date.now() - startedAt),
      plan: {
        intent: "dispatch",
        reply: command.plan?.reply ?? "",
        ...(command.plan?.replyTruncated ? { replyTruncated: true } : {}),
        actions: [],
        track: command.plan?.track ?? "B",
        ...planBase,
        ...(rawErrors.length > 0 ? { errorRaw: rawErrors.join("\n") } : {}),
      },
      auditAction: status === "dispatched" ? "router.command.retry_succeeded" : "router.command.retry_failed",
      auditActor: "user",
    });
  }
}
