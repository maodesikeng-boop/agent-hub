// Router 跨设备极速分派引擎（docs/router-design.md §5、§6）：
// - 轨道 A（零模型直通）：解析显式 target、@设备名/项目名、@唯一项目名，0 token 原样投递文本与已上传附件；
// - 轨道 B（单轮只读规划）：并发汇总 24 KB 以内 Fleet Digest，用 resolveRouterModel 选出极快模型跑单轮只读规划，
//   --verbatim 字节级零拷贝搬运原话与附件（最多 ROUTER_MAX_DISPATCH_TARGETS 个目标），超时硬熔断，finally 彻底回收会话。
import {
  DEFAULT_AGENT_VENDOR,
  LedgerRequestError,
  MAX_ATTACHMENTS_PER_MESSAGE,
  ROUTER_AGENT_TIMEOUT_MS,
  ROUTER_CLOSE_GRACE_MS,
  ROUTER_COMMAND_MAX_CHARS,
  ROUTER_MAX_CONCURRENT_TRACK_B,
  ROUTER_MAX_DISPATCH_TARGETS,
  ROUTER_PEER_DISPATCH_TIMEOUT_MS,
  ROUTER_SESSION_CLEANUP_GRACE_MS,
  ROUTER_TRACK_B_QUEUE_MAX,
  truncateChars,
  turnFailureReason,
  type AgentVendor,
  type Driver,
  type ModelCatalog,
  type PmDigestEntry,
  type PostRouterCommandRequest,
  type RouterAgentDispatchInput,
  type RouterAgentPlan,
  type RouterCommandDispatchedTarget,
  type RouterCommandId,
  type RouterCommandRecord,
  type SessionId,
  type SessionTokens,
} from "../../shared/index.ts";
import { within } from "../driver/base-driver.ts";
import type { SqliteLedger } from "../ledger/index.ts";
import { resolveRouterModel } from "./model-resolver.ts";
import {
  ROUTER_FLEET_DIGEST_MAX_BYTES,
  ROUTER_RECENT_RECEIPTS_CONTEXT,
  ROUTER_REPLY_NOTE_MAX_CHARS,
  formatFleetDigestForPrompt,
  type PromptDeviceDigest,
  type PromptReceiptAction,
  type PromptRecentReceipt,
} from "./prompt.ts";
import {
  cleanupRouterLaunchDir,
  ensureRouterHomeDir,
  type RouterSandboxGuard,
} from "./sandbox.ts";
import {
  RouterTargetError,
  type DigestFetchResult,
  type RouterTargetOp,
  type RouterTargetOpResult,
  type RouterTargetPort,
  type RouterTargetRegistry,
} from "./target-port.ts";

interface ActiveTrackBState {
  readonly commandId: RouterCommandId;
  readonly sessionId: SessionId;
  readonly clientId: string;
  readonly rawText: string;
  readonly attachmentIds: string[];
  readonly dispatched: RouterCommandDispatchedTarget[];
  readonly failedOps: Array<{ deviceId: string; op: RouterTargetOp; error: string }>;
  /** 进行中的 hub dispatch 调用（收尾时限时等它们落定，晚到的成功/失败不丢）。 */
  readonly inflight: Set<Promise<unknown>>;
  /** 进行中的写操作数：与已成功的合计不超过 ROUTER_MAX_DISPATCH_TARGETS（模型并发调用也卡得住）。 */
  pendingMutations: number;
  seq: number;
  /** 立即结束本轮（守护进程关闭时用）。 */
  abort(reason: string): void;
}

export interface RouterDispatcherOptions {
  ledger: SqliteLedger;
  driver: Driver;
  tokens: Pick<SessionTokens, "revoke">;
  sandboxGuard: RouterSandboxGuard;
  targetRegistry: Pick<
    RouterTargetRegistry,
    "selfDeviceId" | "getPort" | "listPorts" | "listAllDigests"
  >;
  models: { list(options?: { vendor?: AgentVendor }): Promise<ModelCatalog[]> };
  stateDir: string;
  launchDir: string;
  agentTimeoutMs?: number;
  maxConcurrentTrackB?: number;
  /** 测试用：回收临时会话最多等多久（默认 ROUTER_SESSION_CLEANUP_GRACE_MS）。 */
  sessionCleanupGraceMs?: number;
  log?: (line: string) => void;
}

export interface RouterDispatcher {
  submitCommand(input: PostRouterCommandRequest): Promise<RouterCommandRecord>;
  retryCommand(commandId: RouterCommandId): Promise<RouterCommandRecord>;
  handleAgentDispatch(
    sessionId: SessionId,
    commandId: RouterCommandId,
    payload: RouterAgentDispatchInput,
  ): Promise<{ text: string; data: unknown }>;
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
  // 保留首行空格之后的正文内容（不破坏内部多行缩进与末尾格式）
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
    // @设备名/项目名 <正文>
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

    // part1 不是已知设备名（例如 @tanstack/react-query）：仅当完整 "part1/part2" 恰好是某个在线项目名时才走轨道 A，否则落入轨道 B
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

  // @项目名 <正文>（无斜杠）
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

  // 检查是否单写了离线设备名（如 @LinuxBox 帮我看看）
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

function toDispatchedTarget(
  port: RouterTargetPort,
  result: RouterTargetOpResult,
  verbatim?: boolean,
): RouterCommandDispatchedTarget | null {
  switch (result.kind) {
    case "pm.forward":
      return {
        deviceId: port.deviceId,
        deviceName: port.deviceName,
        pmId: result.pmId,
        pmName: result.pmName,
        projectId: result.projectId,
        projectName: result.projectName,
        conversationId: result.conversationId,
        messageId: result.messageId,
        ok: true,
        op: "pm.forward",
        ...(verbatim !== undefined ? { verbatim } : {}),
      };
    case "worker.start":
      return {
        deviceId: port.deviceId,
        deviceName: port.deviceName,
        pmId: result.pmId,
        pmName: result.pmName,
        projectId: result.projectId,
        projectName: result.projectName,
        workerId: result.workerId,
        workerConversationId: result.workerConversationId,
        title: result.title,
        readonly: result.readonly,
        messageId: result.pmMessageId,
        ok: true,
        op: "worker.start",
        ...(verbatim !== undefined ? { verbatim } : {}),
      };
    case "worker.send":
      return {
        deviceId: port.deviceId,
        deviceName: port.deviceName,
        pmId: result.pmId,
        workerId: result.workerId,
        workerConversationId: result.workerConversationId,
        title: result.title,
        messageId: result.messageId,
        ok: true,
        op: "worker.send",
        ...(verbatim !== undefined ? { verbatim } : {}),
      };
    case "worker.stop":
      return {
        deviceId: port.deviceId,
        deviceName: port.deviceName,
        pmId: result.pmId,
        workerId: result.workerId,
        workerConversationId: result.workerConversationId,
        title: result.title,
        messageId: 0,
        ok: true,
        op: "worker.stop",
      };
    case "worker.end":
      return {
        deviceId: port.deviceId,
        deviceName: port.deviceName,
        pmId: result.pmId,
        workerId: result.workerId,
        workerConversationId: result.workerConversationId,
        title: result.title,
        messageId: 0,
        ok: true,
        op: "worker.end",
      };
    case "project.create":
      return {
        deviceId: port.deviceId,
        deviceName: port.deviceName,
        pmId: result.pmId,
        pmName: result.pmName,
        projectId: result.projectId,
        projectName: result.projectName,
        conversationId: result.conversationId,
        messageId: 0,
        ok: true,
        op: "project.create",
      };
    case "worker.list":
      return null;
  }
}

function formatOpReceiptText(port: RouterTargetPort, result: RouterTargetOpResult): string {
  const devLabel = port.isLocal ? `本机（${port.deviceName}）` : `设备「${port.deviceName}」`;
  switch (result.kind) {
    case "pm.forward":
      return `已投递给${devLabel} PM #${result.pmId}「${result.pmName}」${result.projectName ? `（项目：${result.projectName}）` : ""}`;
    case "worker.start":
      return `已在${devLabel}项目「${result.projectName}」启动${result.readonly ? "只读 " : ""}Piece #${result.workerId}「${result.title}」`;
    case "worker.send":
      return `已向${devLabel} Piece #${result.workerId}「${result.title}」追发消息`;
    case "worker.stop":
      return `已请求暂停${devLabel} Piece #${result.workerId}「${result.title}」`;
    case "worker.end":
      return `已结束收工${devLabel} Piece #${result.workerId}「${result.title}」`;
    case "project.create":
      return `已在${devLabel}创建项目 #${result.projectId}「${result.projectName}」（PM #${result.pmId}「${result.pmName}」）`;
    case "worker.list": {
      if (result.workers.length === 0) return `${devLabel}当前没有 Piece 记录`;
      const lines = result.workers.map(
        (w) =>
          `- #${w.id}「${w.title}」[project=#${w.projectId}, status=${w.status}, activity=${w.activity}${w.readonly ? ", readonly" : ""}]`,
      );
      return `${devLabel} Piece 列表：\n${lines.join("\n")}`;
    }
  }
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

function cleanReplyNote(chunks: readonly string[]): string {
  const joined = chunks.join("\n").trim();
  if (joined === "") return "";
  return truncateChars(joined, ROUTER_REPLY_NOTE_MAX_CHARS);
}

export function createRouterDispatcher(options: RouterDispatcherOptions): RouterDispatcher {
  const { ledger, driver, tokens, sandboxGuard, targetRegistry, models, stateDir, launchDir } =
    options;
  const agentTimeoutMs = options.agentTimeoutMs ?? ROUTER_AGENT_TIMEOUT_MS;
  const maxConcurrentTrackB = options.maxConcurrentTrackB ?? ROUTER_MAX_CONCURRENT_TRACK_B;
  const sessionCleanupGraceMs = options.sessionCleanupGraceMs ?? ROUTER_SESSION_CLEANUP_GRACE_MS;

  const activeStates = new Map<RouterCommandId, ActiveTrackBState>();
  /** 在途的指令管线（close 时限时等它们收尾，不留悬空 Promise）。 */
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
    if (trimmed === "" || trimmed.toLowerCase() === "self" || trimmed === "本机") {
      const local = targetRegistry.getPort(targetRegistry.selfDeviceId()) ?? targetRegistry.getPort("self");
      if (local) return local;
    }
    const direct = targetRegistry.getPort(trimmed);
    if (direct) return direct;
    const lower = trimmed.toLowerCase();
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

  const executeTrackAForward = async (params: {
    commandId: RouterCommandId;
    clientId: string;
    port: RouterTargetPort;
    pmId?: number;
    projectId?: number;
    bodyText: string;
    attachmentIds: string[];
    startedAt: number;
  }): Promise<RouterCommandRecord> => {
    const op: RouterTargetOp = {
      kind: "pm.forward",
      clientId: `${params.clientId}:a0`,
      ...(params.pmId !== undefined ? { pmId: params.pmId } : {}),
      ...(params.projectId !== undefined ? { projectId: params.projectId } : {}),
      text: params.bodyText,
      ...(params.attachmentIds.length > 0 ? { attachmentIds: params.attachmentIds } : {}),
      sourceCommandId: params.commandId,
    };

    try {
      const res = await params.port.executeOp(op);
      const dispatchedItem = toDispatchedTarget(params.port, res, true)!;
      const receipt = formatOpReceiptText(params.port, res);
      return ledger.updateRouterCommand(params.commandId, {
        model: null,
        effort: null,
        status: "dispatched",
        dispatched: [dispatchedItem],
        error: null,
        durationMs: Math.max(0, Date.now() - params.startedAt),
        plan: {
          intent: "dispatch",
          reply: receipt,
          actions: [],
          track: "A",
          ...(params.attachmentIds.length > 0 ? { attachmentIds: params.attachmentIds } : {}),
        },
        auditAction: "router.command.track_a",
        auditActor: "user",
        auditDetail: {
          deviceId: params.port.deviceId,
          pmId: dispatchedItem.pmId,
          messageId: dispatchedItem.messageId,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return ledger.updateRouterCommand(params.commandId, {
        model: null,
        effort: null,
        status: "failed",
        error: message,
        durationMs: Math.max(0, Date.now() - params.startedAt),
        plan: {
          intent: "dispatch",
          reply: message,
          actions: [],
          track: "A",
          ...(params.attachmentIds.length > 0 ? { attachmentIds: params.attachmentIds } : {}),
          retryOps: [{ deviceId: params.port.deviceId, op }],
        },
        auditAction: "router.command.track_a_failed",
        auditActor: "user",
        auditDetail: { deviceId: params.port.deviceId, error: message },
      });
    }
  };

  const executeTrackB = async (params: {
    commandId: RouterCommandId;
    clientId: string;
    rawText: string;
    attachmentIds: string[];
    preloadedFleet?: ReadonlyArray<{ port: RouterTargetPort; result: DigestFetchResult }>;
    startedAt: number;
  }): Promise<RouterCommandRecord> => {
    let releaseSlot: () => void;
    try {
      releaseSlot = await acquireTrackBSlot();
    } catch (err) {
      // 排队满或正在关闭：指令行已经建了，标失败（可重试），不能一直挂在 planning
      const message = err instanceof Error ? err.message : String(err);
      return ledger.updateRouterCommand(params.commandId, {
        status: "failed",
        error: message,
        durationMs: Math.max(0, Date.now() - params.startedAt),
        plan: {
          intent: "answer",
          reply: message,
          actions: [],
          track: "B",
          ...(params.attachmentIds.length > 0 ? { attachmentIds: params.attachmentIds } : {}),
        },
        auditAction: "router.command.track_b_rejected",
        auditActor: "system",
        auditDetail: { error: message },
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
            reply: resolved.message,
            actions: [{ type: "answer", markdown: resolved.message }],
            track: "B",
            ...(params.attachmentIds.length > 0 ? { attachmentIds: params.attachmentIds } : {}),
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

      const promptDevices: PromptDeviceDigest[] = fleet.map(({ port, result }) => ({
        deviceId: port.isLocal ? "self" : port.deviceId,
        deviceName: port.deviceName,
        online: result.online,
        ...(result.stale ? { stale: true } : {}),
        ...(result.digest ? { generatedAt: result.digest.generatedAt } : {}),
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
              }
            : null,
          roleSummary: [pm.pmNote, pm.personaSummary, pm.recentBrief]
            .map((s) => s?.trim())
            .filter(Boolean)
            .join(" | "),
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

      const recentRecords = ledger
        .listRouterCommands(undefined, ROUTER_RECENT_RECEIPTS_CONTEXT + 1)
        .commands.filter((c) => c.id !== params.commandId)
        .slice(0, ROUTER_RECENT_RECEIPTS_CONTEXT);
      const digestPrompt = formatFleetDigestForPrompt(
        promptDevices,
        buildRecentReceipts(recentRecords),
        ROUTER_FLEET_DIGEST_MAX_BYTES,
      );

      const attachmentNote =
        params.attachmentIds.length > 0
          ? `\n\n# 用户随附文件（共 ${params.attachmentIds.length} 个）\n已上传附件编号：${params.attachmentIds.join("、")}（调用 \`hub dispatch ... --verbatim\` 时守护进程会自动将附件随原文一并投递，无需手动处理路径）。`
          : "";

      const turnText = `${digestPrompt}${attachmentNote}\n\n# 当前用户指令\n<user_command>\n${params.rawText}\n</user_command>`;

      const routerHomeDir = ensureRouterHomeDir(stateDir);
      const assistantSession = ledger.createRouterAssistantSession({
        vendor: resolved.vendor,
        model: resolved.model,
        effort: resolved.effort,
        cwd: routerHomeDir,
      });

      const agentTexts: string[] = [];
      let timedOut = false;
      let turnEnded = false;
      let timer: NodeJS.Timeout | undefined;

      type TurnDone = { ok: boolean; error?: string };
      let settleTurn!: (outcome: TurnDone) => void;
      const turnPromise = new Promise<TurnDone>((resolve) => {
        settleTurn = resolve;
      });

      const state: ActiveTrackBState = {
        commandId: params.commandId,
        sessionId: assistantSession.id,
        clientId: params.clientId,
        rawText: params.rawText,
        attachmentIds: params.attachmentIds,
        dispatched: [],
        failedOps: [],
        inflight: new Set(),
        pendingMutations: 0,
        seq: 0,
        abort: (reason) => settleTurn({ ok: false, error: reason }),
      };

      activeStates.set(params.commandId, state);
      sandboxGuard.bind(assistantSession.id, params.commandId);

      const unsub = driver.onEvent((evSessionId, event) => {
        if (evSessionId !== assistantSession.id) return;
        if (event.type === "agent.text" && !event.parentToolUseId) {
          agentTexts.push(event.text);
        } else if (event.type === "turn.ended") {
          turnEnded = true;
          settleTurn({
            ok: event.ok && !event.interrupted,
            ...(event.error ? { error: turnFailureReason(event.error) } : {}),
          });
        } else if (event.type === "session.exited" && !event.hadResult) {
          settleTurn({
            ok: false,
            error: `总助规划进程提前退出（${event.reason}）`,
          });
        } else if (event.type === "driver.error" && event.code === "invalid_input") {
          settleTurn({
            ok: false,
            error: event.message,
          });
        }
      });

      timer = setTimeout(() => {
        timedOut = true;
        settleTurn({
          ok: false,
          error: `总助单轮规划超时（超过 ${Math.max(1, Math.round(agentTimeoutMs / 1000))} 秒），请重试或用 @设备名/项目名 直通发令`,
        });
      }, agentTimeoutMs);
      timer.unref?.();

      let turnOutcome: TurnDone;
      try {
        // start/send 跟超时计时器赛跑：厂商进程起不来或写不进去卡住时，超时照样结束本轮，不挂住并发槽
        void (async () => {
          await driver.start(assistantSession.id);
          const sendRes = await driver.send(assistantSession.id, {
            messageIds: [1],
            source: "user",
            text: turnText,
          });
          if (sendRes.kind === "rejected" || sendRes.kind === "cancelled") {
            settleTurn({ ok: false, error: `总助指令未能写入会话（${sendRes.kind}）` });
          }
        })().catch((err: unknown) => {
          settleTurn({ ok: false, error: err instanceof Error ? err.message : String(err) });
        });
        turnOutcome = await turnPromise;
      } finally {
        clearTimeout(timer);
        unsub();
        // 先撤令牌和绑定：之后到达的 hub dispatch 一律拒绝
        tokens.revoke(assistantSession.id);
        sandboxGuard.unbind(assistantSession.id);
        activeStates.delete(params.commandId);
        // 本轮没正常结束（超时、关闭、出错）先打断再结束；driver.end 遇到还在跑的一轮会等它回完，限时等，厂商进程卡住也按时释放并发槽
        const stopSession = (async () => {
          if (!turnEnded) await driver.interrupt(assistantSession.id).catch(() => {});
          await driver.end(assistantSession.id).catch(() => {});
        })();
        if ((await within(stopSession, sessionCleanupGraceMs)) === "timeout") {
          options.log?.(`总助规划会话 ${assistantSession.id} 结束超时，放弃等待`);
        }
        // 已发出的 hub dispatch 限时等落定（各自也有跨设备超时），晚到的成功/失败照样记进回执与重试列表
        if (state.inflight.size > 0) {
          await within(Promise.allSettled([...state.inflight]), ROUTER_PEER_DISPATCH_TIMEOUT_MS);
        }
        cleanupRouterLaunchDir(launchDir, assistantSession.id);
        try {
          ledger.deleteRouterAssistantSession(assistantSession.id);
        } catch {
          // ignore if DB already closed during shutdown
        }
      }

      const durationMs = Math.max(0, Date.now() - params.startedAt);
      const replyNote = cleanReplyNote(agentTexts);

      if (timedOut) {
        const timeoutMsg =
          turnOutcome.error ??
          `总助单轮规划超时（超过 ${Math.max(1, Math.round(agentTimeoutMs / 1000))} 秒）`;
        return ledger.updateRouterCommand(params.commandId, {
          status: "failed",
          dispatched: state.dispatched.length > 0 ? state.dispatched : null,
          error: timeoutMsg,
          durationMs,
          plan: {
            intent: state.dispatched.length > 0 ? "dispatch" : "answer",
            reply: replyNote || timeoutMsg,
            actions: [],
            track: "B",
            ...(params.attachmentIds.length > 0 ? { attachmentIds: params.attachmentIds } : {}),
            ...(state.failedOps.length > 0
              ? { retryOps: state.failedOps.map((f) => ({ deviceId: f.deviceId, op: f.op })) }
              : {}),
          },
          auditAction: "router.command.timeout",
          auditActor: "router_agent",
          auditDetail: { durationMs, dispatchedCount: state.dispatched.length },
        });
      }

      if (state.failedOps.length > 0) {
        const errText = state.failedOps.map((f) => f.error).join("；");
        return ledger.updateRouterCommand(params.commandId, {
          status: "failed",
          dispatched: state.dispatched.length > 0 ? state.dispatched : null,
          error: errText,
          durationMs,
          plan: {
            intent: "dispatch",
            reply: replyNote || errText,
            actions: [],
            track: "B",
            ...(params.attachmentIds.length > 0 ? { attachmentIds: params.attachmentIds } : {}),
            retryOps: state.failedOps.map((f) => ({ deviceId: f.deviceId, op: f.op })),
          },
          auditAction: "router.command.partial_failed",
          auditActor: "router_agent",
          auditDetail: {
            dispatchedCount: state.dispatched.length,
            failedCount: state.failedOps.length,
          },
        });
      }

      if (state.dispatched.length > 0) {
        return ledger.updateRouterCommand(params.commandId, {
          status: "dispatched",
          dispatched: state.dispatched,
          error: null,
          durationMs,
          plan: {
            intent: "dispatch",
            reply: replyNote,
            actions: [],
            track: "B",
            ...(params.attachmentIds.length > 0 ? { attachmentIds: params.attachmentIds } : {}),
          },
          auditAction: "router.command.dispatched",
          auditActor: "router_agent",
          auditDetail: {
            vendor: resolved.vendor,
            model: resolved.model,
            dispatchedCount: state.dispatched.length,
            durationMs,
          },
        });
      }

      if (!turnOutcome.ok) {
        const errMsg = turnOutcome.error ?? "总助单轮规划失败";
        return ledger.updateRouterCommand(params.commandId, {
          status: "failed",
          error: errMsg,
          durationMs,
          plan: {
            intent: "answer",
            reply: replyNote || errMsg,
            actions: [],
            track: "B",
            ...(params.attachmentIds.length > 0 ? { attachmentIds: params.attachmentIds } : {}),
          },
          auditAction: "router.command.failed",
          auditActor: "router_agent",
          auditDetail: { error: errMsg },
        });
      }

      const finalAnswer = replyNote || "当前指令未触发分派操作，请补充目标项目或设备信息。";
      return ledger.updateRouterCommand(params.commandId, {
        status: "answered",
        error: null,
        durationMs,
        plan: {
          intent: "answer",
          reply: finalAnswer,
          actions: [{ type: "answer", markdown: finalAnswer }],
          track: "B",
          ...(params.attachmentIds.length > 0 ? { attachmentIds: params.attachmentIds } : {}),
        },
        auditAction: "router.command.answered",
        auditActor: "router_agent",
        auditDetail: { durationMs },
      });
    } finally {
      releaseSlot();
    }
  };

  /** 跟踪在途管线：close 时限时等它们收尾。 */
  const track = <T>(p: Promise<T>): Promise<T> => {
    runningPipelines.add(p);
    const done = () => runningPipelines.delete(p);
    p.then(done, done);
    return p;
  };

  const runCommandPipeline = async (params: {
    commandId: RouterCommandId;
    clientId: string;
    text: string;
    attachmentIds: string[];
    explicitTarget?: PostRouterCommandRequest["target"];
  }): Promise<RouterCommandRecord> => {
    const startedAt = Date.now();

    // 1. 显式 target：轨道 A 零模型直通
    if (params.explicitTarget !== undefined) {
      let port: RouterTargetPort;
      try {
        port = resolvePortByDeviceSpec(params.explicitTarget.deviceId ?? "self");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return ledger.updateRouterCommand(params.commandId, {
          model: null,
          effort: null,
          status: "failed",
          error: msg,
          durationMs: Math.max(0, Date.now() - startedAt),
          plan: {
            intent: "dispatch",
            reply: msg,
            actions: [],
            track: "A",
            ...(params.attachmentIds.length > 0 ? { attachmentIds: params.attachmentIds } : {}),
          },
        });
      }
      return executeTrackAForward({
        commandId: params.commandId,
        clientId: params.clientId,
        port,
        pmId: params.explicitTarget.pmId,
        projectId: params.explicitTarget.projectId,
        bodyText: params.text,
        attachmentIds: params.attachmentIds,
        startedAt,
      });
    }

    // 2. @设备名/项目名 或 @唯一项目名：轨道 A 零模型直通（非设备前缀如 @tanstack/... 平滑落入轨道 B）
    let preloadedFleet: ReadonlyArray<{ port: RouterTargetPort; result: DigestFetchResult }> | undefined;
    if (/^\s*@/.test(params.text)) {
      preloadedFleet = await targetRegistry.listAllDigests();
      const atRes = resolveAtMention(params.text, preloadedFleet);
      if (atRes.kind === "matched") {
        return executeTrackAForward({
          commandId: params.commandId,
          clientId: params.clientId,
          port: atRes.port,
          pmId: atRes.pm.pmId,
          bodyText: atRes.bodyText,
          attachmentIds: params.attachmentIds,
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
            reply: atRes.message,
            actions: [],
            track: "A",
            ...(params.attachmentIds.length > 0 ? { attachmentIds: params.attachmentIds } : {}),
          },
          auditAction: "router.command.track_a_rejected",
          auditActor: "user",
          auditDetail: { error: atRes.message },
        });
      }
    }

    // 3. 轨道 B：单轮只读规划
    return executeTrackB({
      commandId: params.commandId,
      clientId: params.clientId,
      rawText: params.text,
      attachmentIds: params.attachmentIds,
      preloadedFleet,
      startedAt,
    });
  };

  return {
    async submitCommand(input: PostRouterCommandRequest): Promise<RouterCommandRecord> {
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

      const initialVendor = ledger.getRouterSettings().vendor ?? DEFAULT_AGENT_VENDOR;
      const { command, deduplicated } = ledger.createRouterCommand({
        clientId,
        inputText: rawText,
        vendor: initialVendor,
        model: null,
        effort: null,
        status: "planning",
        plan:
          attachmentIds.length > 0
            ? { intent: "dispatch", reply: "", actions: [], attachmentIds }
            : null,
        auditAction: "router.command.submit",
        auditActor: "user",
      });

      if (deduplicated) return command;

      return track(runCommandPipeline({
        commandId: command.id,
        clientId,
        text: rawText,
        attachmentIds,
        explicitTarget: input.target,
      }));
    },

    async retryCommand(commandId: RouterCommandId): Promise<RouterCommandRecord> {
      const existing = ledger.getRouterCommand(commandId);
      if (existing === null) {
        throw new LedgerRequestError("not_found", `没有编号 ${commandId} 的总助指令`);
      }
      if (existing.status !== "failed") {
        throw new LedgerRequestError("conflict", "只有失败状态的总助指令才能重试");
      }

      const attachmentIds = existing.plan?.attachmentIds ?? [];
      const retryOps = existing.plan?.retryOps ?? [];

      // 若上次已有明确失败的目标操作列表（含部分成功场景），仅补跑失败项，绝不重复投递已成功项
      if (retryOps.length > 0) {
        const startedAt = Date.now();
        ledger.updateRouterCommand(commandId, { status: "planning", error: null });
        const succeeded: RouterCommandDispatchedTarget[] = [...(existing.dispatched ?? [])];
        const stillFailed: Array<{ deviceId: string; op: RouterTargetOp; error: string }> = [];

        for (const item of retryOps) {
          const op = item.op as RouterTargetOp;
          try {
            const port = resolvePortByDeviceSpec(item.deviceId);
            const res = await port.executeOp(op);
            const target = toDispatchedTarget(port, res);
            if (target !== null) succeeded.push(target);
          } catch (err) {
            stillFailed.push({
              deviceId: item.deviceId,
              op,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const durationMs = Math.max(0, Date.now() - startedAt);
        if (stillFailed.length === 0) {
          return ledger.updateRouterCommand(commandId, {
            status: "dispatched",
            dispatched: succeeded,
            error: null,
            durationMs,
            plan: {
              intent: "dispatch",
              reply: existing.plan?.reply ?? "",
              actions: [],
              track: existing.plan?.track ?? "B",
              ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
            },
            auditAction: "router.command.retry_succeeded",
            auditActor: "user",
          });
        }

        const errMsg = stillFailed.map((f) => f.error).join("；");
        return ledger.updateRouterCommand(commandId, {
          status: "failed",
          dispatched: succeeded.length > 0 ? succeeded : null,
          error: errMsg,
          durationMs,
          plan: {
            intent: "dispatch",
            reply: errMsg,
            actions: [],
            track: existing.plan?.track ?? "B",
            ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
            retryOps: stillFailed.map((f) => ({ deviceId: f.deviceId, op: f.op })),
          },
          auditAction: "router.command.retry_failed",
          auditActor: "user",
        });
      }

      // 已有目标投递成功、又没有明确的失败操作（如规划超时、重启中断时已投出一部分）：整条重跑会让模型再投一遍，拒绝
      if ((existing.dispatched ?? []).some((d) => d.ok)) {
        throw new LedgerRequestError(
          "conflict",
          "这条指令已有目标投递成功，整条重跑会重复投递；还有没交代到的请重新发一条",
        );
      }

      // 否则（例如设备之前离线尚未拿到名片、模型曾未登录或规划曾超时）重新执行完整管线
      ledger.updateRouterCommand(commandId, { status: "planning", error: null });
      return track(runCommandPipeline({
        commandId,
        clientId: existing.clientId,
        text: existing.inputText,
        attachmentIds,
      }));
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

      const isMutating = payload.op !== "worker-list";
      if (isMutating && state.dispatched.length + state.pendingMutations >= ROUTER_MAX_DISPATCH_TARGETS) {
        throw new LedgerRequestError(
          "conflict",
          `单条指令最多分派 ${ROUTER_MAX_DISPATCH_TARGETS} 个目标`,
        );
      }

      let port: RouterTargetPort;
      try {
        port = resolvePortByDeviceSpec(payload.device);
      } catch (err) {
        return mapTargetErrorToLedger(err);
      }

      const opSeq = ++state.seq;
      const opClientId = `${state.clientId}:b${opSeq}`;
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
            sourceCommandId: commandId,
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

      if (isMutating) state.pendingMutations++;
      const run = executeAgentOp(state, commandId, port, targetOp, usedVerbatim, isMutating);
      state.inflight.add(run);
      try {
        return await run;
      } finally {
        state.inflight.delete(run);
        if (isMutating) state.pendingMutations--;
      }
    },

    async close(): Promise<void> {
      closed = true;
      for (const waiter of trackBWaiters.splice(0)) {
        waiter.reject(new LedgerRequestError("conflict", "总助分派引擎已关闭"));
      }
      for (const st of activeStates.values()) st.abort("守护进程正在关闭，总助规划中断，可点击重试");
      // 在途管线各自会打断并结束临时会话、写好指令状态；限时等，不留悬空 Promise 和计时器
      if (runningPipelines.size > 0) {
        await within(Promise.allSettled([...runningPipelines]), ROUTER_CLOSE_GRACE_MS);
      }
    },
  };

  async function executeAgentOp(
    state: ActiveTrackBState,
    commandId: RouterCommandId,
    port: RouterTargetPort,
    targetOp: RouterTargetOp,
    usedVerbatim: boolean | undefined,
    isMutating: boolean,
  ): Promise<{ text: string; data: unknown }> {
    try {
      const res = await port.executeOp(targetOp);
      const targetRecord = toDispatchedTarget(port, res, usedVerbatim);
      if (targetRecord !== null) {
        state.dispatched.push(targetRecord);
        ledger.updateRouterCommand(commandId, {
          dispatched: [...state.dispatched],
          auditAction: `router.dispatch.${targetOp.kind}`,
          auditActor: "router_agent",
          auditDetail: {
            deviceId: port.deviceId,
            op: targetOp.kind,
            verbatim: usedVerbatim ?? false,
          },
        });
      }
      return {
        text: formatOpReceiptText(port, res),
        data: res,
      };
    } catch (err) {
      if (
        isMutating &&
        err instanceof RouterTargetError &&
        (err.code === "device_offline" || err.code === "device_timeout")
      ) {
        state.failedOps.push({
          deviceId: port.deviceId,
          op: targetOp,
          error: err.message,
        });
      }
      return mapTargetErrorToLedger(err);
    }
  }
}
