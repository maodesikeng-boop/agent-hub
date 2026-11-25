import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  ASK_MAX_OPTION_CHARS,
  ENV_HUB_SOCK,
  ENV_HUB_TOKEN,
  HUB_COMMANDS,
  HUB_ERROR_HTTP_STATUS,
  HUB_MAX_BODY_BYTES,
  HUB_REQUEST_TIMEOUT_MS,
  HUB_TIMEOUT_CHECK_MS,
  LedgerRequestError,
  MAX_DECISION_CHOICE_CHARS,
  MAX_DECISION_NOTE_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_GRAPH_SPEC_BYTES,
  MAX_GRAPH_TITLE_CHARS,
  MAX_NAME_CHARS,
  MAX_NODE_ARTIFACT_SUMMARY_CHARS,
  MAX_NODE_KEY_CHARS,
  MAX_PATH_BYTES,
  MAX_PERSONA_BYTES,
  MAX_SETUP_COMMAND_BYTES,
  MAX_MODEL_CHARS,
  MAX_REASON_CHARS,
  MAX_TASK_BYTES,
  DELIVERABLE_LABEL_MAX_CHARS,
  PM_MODES,
  ROUTER_DISPATCH_AGENT_PATH,
  SELF_RELOAD_AGENT_PATH,
  SELF_RELOAD_UNSUPPORTED_MESSAGE,
  TASK_GRAPH_STATUSES,
  WORKER_CAPABILITY_MODES,
  hubCommandAllowed,
  hubPath,
  type HubCommand,
  type HubErrorCode,
  type HubResponse,
  type Ledger,
  type RouterAgentDispatchInput,
  type RouterCommandId,
  type SessionId,
  type SessionTokens,
} from "../../shared/index.ts";
import { API_ERRORS } from "../../shared/errors.ts";
import { LOG_PREFIX } from "../../shared/names.ts";
import { runHubSafely } from "../../hub/cli.ts";
import { isCrossPlatformAbsolutePath, isWindowsNamedPipe } from "../platform/index.ts";
import { listenOnRunSocket } from "../run-socket.ts";
import { unlessAborted } from "../sent-files.ts";
import type { RouterSandboxGuard } from "../router/sandbox.ts";
import type { WorkerPr, WorkerPrProbeResult } from "../../shared/hub.ts";
import type { QuotaResponse, SelfReloadStatus } from "../../shared/api.ts";
import type { HubCallContext, WorkspaceProbe } from "../../shared/ledger.ts";
import type { HubFileArg } from "../../shared/deliverables.ts";
import { HUB_FILE_ARGS_MAX, HUB_MODELS_QUOTA_WAIT_MS, HUB_SHUTDOWN_PREPARE_GRACE_MS } from "../../shared/limits.ts";
import { mergeVendorQuota, type ObservedQuotaStore } from "../quota/observed-quota.ts";
import { AGENT_VENDORS, isAgentVendor, type AgentVendor, type ModelCatalog } from "../../shared/vendors.ts";
import { vendorTranscriptPath } from "../driver/transcript.ts";
import type { TranscriptRef } from "../driver/transcript.ts";
import { probePr as defaultProbePr, probePrByUrl as defaultProbePrByUrl, probeWorkspace as defaultProbeWorkspace } from "../git/index.ts";

export interface AgentApiOptions {
  ledger: Pick<
    Ledger,
    | "hubCall"
    | "reconcileHubBranches"
    | "sessionRole"
    | "reportHealth"
    | "workerStartFolder"
    | "workerPrTarget"
    | "graphPrTargets"
    | "graphAutoDispatchVendors"
    | "workerTranscriptTarget"
    | "shareHubFiles"
  >;
  /** Probe git outside the ledger transaction so a hung git call cannot stall the daemon. */
  probeWorkspace?: (folder: string) => Promise<WorkspaceProbe>;
  probePr?: (cwd: string, branch: string) => Promise<WorkerPrProbeResult>;
  probePrByUrl?: (cwd: string, url: string) => Promise<WorkerPrProbeResult>;
  findTranscript?: (ref: TranscriptRef) => string | null;
  refreshVendor?: (vendor: AgentVendor) => Promise<unknown>;
  models?: { list(options?: { refresh?: boolean | "unusable"; vendor?: AgentVendor }): Promise<ModelCatalog[]> };
  quota?: { observed: ObservedQuotaStore; get(): Promise<QuotaResponse>; now?: () => number };
  sandboxGuard?: RouterSandboxGuard;
  onRouterDispatch?: (
    sessionId: SessionId,
    commandId: RouterCommandId,
    payload: RouterAgentDispatchInput,
  ) => Promise<{ text: string; data: unknown }>;
  selfReload?: (input: { sessionId: SessionId; build: boolean }) => { text: string; data: unknown };
  selfReloadStatus?: () => SelfReloadStatus | undefined;
  tokens: SessionTokens;
  logger?: boolean;
  log?: (line: string) => void;
  requestTimeoutMs?: number;
  timeoutCheckMs?: number;
  boundSocketPath?: () => string;
}

const BEARER = /^Bearer ([A-Za-z0-9_-]+)$/;

const nameField = { type: "string", minLength: 1, maxLength: MAX_NAME_CHARS };
/** ajv maxLength counts characters, so byte limits are checked separately. */
const pathField = { type: "string", minLength: 1, maxLength: MAX_PATH_BYTES };
const noArgs = { type: "object", additionalProperties: false, properties: {} };

const folderOnly = { type: "object", additionalProperties: false, required: ["folder"], properties: { folder: pathField } };
const workerIdField = { type: "integer", minimum: 1 };
const taskField = { type: "string", minLength: 1, maxLength: MAX_TASK_BYTES };
const fileArgsField = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["label", "path"],
    properties: {
      label: { type: ["string", "null"], maxLength: DELIVERABLE_LABEL_MAX_CHARS * 4 },
      path: pathField,
    },
  },
};

const scheduleIdOnly = { type: "object", additionalProperties: false, required: ["scheduleId"], properties: { scheduleId: workerIdField } };

const BODY_SCHEMAS: Record<HubCommand, object> = {
  status: noArgs,
  "project.create": {
    type: "object",
    additionalProperties: false,
    required: ["folder"],
    properties: { folder: pathField, name: nameField, description: { type: "string", maxLength: MAX_DESCRIPTION_CHARS } },
  },
  "project.attach": folderOnly,
  "project.detach": folderOnly,
  "project.setup": {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: { command: { type: ["string", "null"], maxLength: MAX_SETUP_COMMAND_BYTES } },
  },
  "persona.show": noArgs,
  "persona.edit": {
    type: "object",
    additionalProperties: false,
    anyOf: [{ required: ["text"] }, { required: ["mode"] }],
    properties: {
      text: { type: "string", maxLength: MAX_PERSONA_BYTES },
      mode: { type: "string", enum: [...PM_MODES] },
      reason: { type: "string", maxLength: MAX_REASON_CHARS },
    },
  },
  "worker.start": {
    type: "object",
    additionalProperties: false,
    anyOf: [{ required: ["title", "task"] }, { required: ["node"] }],
    properties: {
      title: { type: "string", minLength: 1 },
      task: taskField,
      vendor: { type: "string", minLength: 1, maxLength: MAX_MODEL_CHARS },
      model: { type: "string", minLength: 1, maxLength: MAX_MODEL_CHARS },
      effort: { type: "string", minLength: 1, maxLength: MAX_MODEL_CHARS },
      maxTimeMs: { type: "integer" },
      readonly: { type: "boolean" },
      caps: { type: "string", enum: [...WORKER_CAPABILITY_MODES] },
      allow: { type: "array", items: { type: "string", minLength: 1, maxLength: 512 } },
      noWorktree: { type: "boolean" },
      node: { type: "string", minLength: 1, maxLength: MAX_NODE_KEY_CHARS * 2 },
      graphId: workerIdField,
    },
  },
  "worker.send": {
    type: "object",
    additionalProperties: false,
    required: ["workerId", "text"],
    properties: { workerId: workerIdField, text: taskField, maxTimeMs: { type: "integer" } },
  },
  "worker.max-time": {
    type: "object",
    additionalProperties: false,
    required: ["workerId", "maxTimeMs"],
    properties: { workerId: workerIdField, maxTimeMs: { type: "integer" } },
  },
  "worker.end": {
    type: "object",
    additionalProperties: false,
    required: ["workerId"],
    properties: { workerId: workerIdField },
  },
  "worker.list": { type: "object", additionalProperties: false, properties: { vendor: { type: "string", enum: [...AGENT_VENDORS] } } },
  "worker.show": {
    type: "object",
    additionalProperties: false,
    required: ["workerId"],
    properties: { workerId: workerIdField, task: { type: "boolean" }, report: { oneOf: [{ type: "integer" }, { const: "latest" }] } },
  },
  "worker.search": {
    type: "object",
    additionalProperties: false,
    required: ["keywords"],
    properties: { keywords: { type: "array", items: { type: "string" } }, limit: { type: "integer" } },
  },
  "worker.log": {
    type: "object",
    additionalProperties: false,
    required: ["workerId"],
    properties: { workerId: workerIdField, last: { type: "integer" }, stats: { type: "boolean" } },
  },
  models: {
    type: "object",
    additionalProperties: false,
    properties: { vendor: { type: "string", minLength: 1, maxLength: MAX_MODEL_CHARS }, refresh: { type: "boolean" } },
  },
  ask: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
      text: taskField,
      options: { type: "array", items: { type: "string" } },
      recommended: { type: "string", minLength: 1, maxLength: ASK_MAX_OPTION_CHARS * 4 },
      node: { type: "string", minLength: 1, maxLength: MAX_NODE_KEY_CHARS * 2 },
      graphId: workerIdField,
      replaceItemId: workerIdField,
      files: fileArgsField,
    },
  },
  "ask.close": {
    type: "object",
    additionalProperties: false,
    properties: { itemId: workerIdField, messageId: workerIdField },
    oneOf: [{ required: ["itemId"] }, { required: ["messageId"] }],
  },
  "schedule.add": {
    type: "object",
    additionalProperties: false,
    required: ["name", "prompt"],
    properties: {
      name: nameField,
      prompt: taskField,
      daily: { type: "string", maxLength: 5 },
      everyMinutes: { type: "integer" },
    },
  },
  "schedule.list": noArgs,
  "schedule.pause": scheduleIdOnly,
  "schedule.resume": scheduleIdOnly,
  "schedule.remove": scheduleIdOnly,
  "router.report": {
    type: "object",
    additionalProperties: false,
    required: ["summary"],
    properties: {
      summary: { type: "string", minLength: 1, maxLength: MAX_TASK_BYTES },
      links: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "target"],
          properties: {
            label: { type: "string", minLength: 1 },
            target: { type: "string", minLength: 1 },
          },
        },
      },
      files: fileArgsField,
    },
  },
  "graph.create": {
    type: "object",
    additionalProperties: false,
    required: ["specJson"],
    properties: {
      title: { type: "string", maxLength: MAX_GRAPH_TITLE_CHARS * 2 },
      specJson: { type: "string", minLength: 1, maxLength: MAX_GRAPH_SPEC_BYTES },
    },
  },
  "graph.show": {
    type: "object",
    additionalProperties: false,
    properties: { graphId: workerIdField },
  },
  "graph.list": {
    type: "object",
    additionalProperties: false,
    properties: {
      all: { type: "boolean" },
      status: { type: "string", enum: [...TASK_GRAPH_STATUSES] },
    },
  },
  "graph.patch": {
    type: "object",
    additionalProperties: false,
    required: ["specJson"],
    properties: {
      graphId: workerIdField,
      specJson: { type: "string", minLength: 1, maxLength: MAX_GRAPH_SPEC_BYTES },
    },
  },
  "graph.done": {
    type: "object",
    additionalProperties: false,
    required: ["nodeKey"],
    properties: {
      nodeKey: { type: "string", minLength: 1, maxLength: MAX_NODE_KEY_CHARS * 2 },
      graphId: workerIdField,
      prUrl: { type: "string" },
      commit: { type: "string" },
      branch: { type: "string" },
      summary: { type: "string", maxLength: MAX_NODE_ARTIFACT_SUMMARY_CHARS * 4 },
      note: taskField,
    },
  },
  "graph.decide": {
    type: "object",
    additionalProperties: false,
    required: ["nodeKey", "choice"],
    properties: {
      nodeKey: { type: "string", minLength: 1, maxLength: MAX_NODE_KEY_CHARS * 2 },
      graphId: workerIdField,
      choice: { type: "string", minLength: 1, maxLength: MAX_DECISION_CHOICE_CHARS * 2 },
      note: { type: "string", maxLength: MAX_DECISION_NOTE_CHARS * 2 },
    },
  },
  "graph.skip": {
    type: "object",
    additionalProperties: false,
    required: ["nodeKey"],
    properties: {
      nodeKey: { type: "string", minLength: 1, maxLength: MAX_NODE_KEY_CHARS * 2 },
      graphId: workerIdField,
      reason: { type: "string", maxLength: MAX_REASON_CHARS * 2 },
    },
  },
  "graph.cancel": {
    type: "object",
    additionalProperties: false,
    properties: {
      graphId: workerIdField,
      reason: { type: "string", maxLength: MAX_REASON_CHARS * 2 },
    },
  },
  "graph.finish": {
    type: "object",
    additionalProperties: false,
    required: ["summary"],
    properties: {
      graphId: workerIdField,
      unmergedOk: { type: "boolean" },
      summary: { type: "string", minLength: 1, maxLength: MAX_TASK_BYTES },
    },
  },
};

const FIELD_KINDS: Partial<Record<HubCommand, Record<string, "path" | "name">>> = {
  "project.create": { name: "name", folder: "path" },
  "project.attach": { folder: "path" },
  "project.detach": { folder: "path" },
  "worker.start": { title: "name" },
  "schedule.add": { name: "name" },
};
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/u;

const BYTE_LIMITS: Partial<Record<HubCommand, Record<string, number>>> = {
  "project.create": { folder: MAX_PATH_BYTES },
  "project.attach": { folder: MAX_PATH_BYTES },
  "project.detach": { folder: MAX_PATH_BYTES },
  "project.setup": { command: MAX_SETUP_COMMAND_BYTES },
  "persona.edit": { text: MAX_PERSONA_BYTES },
  "worker.start": { task: MAX_TASK_BYTES },
  "worker.send": { text: MAX_TASK_BYTES },
  ask: { text: MAX_TASK_BYTES },
  "schedule.add": { prompt: MAX_TASK_BYTES },
  "graph.create": { specJson: MAX_GRAPH_SPEC_BYTES },
  "graph.patch": { specJson: MAX_GRAPH_SPEC_BYTES },
  "graph.done": { note: MAX_TASK_BYTES },
  "graph.finish": { summary: MAX_TASK_BYTES },
};

class HubError extends Error {
  readonly code: HubErrorCode;
  constructor(code: HubErrorCode, message: string) {
    super(message);
    this.name = "HubError";
    this.code = code;
  }
}

function checkFields(command: HubCommand, body: Record<string, unknown>): void {
  for (const [field, limit] of Object.entries(BYTE_LIMITS[command] ?? {})) {
    const value = body[field];
    if (typeof value === "string" && Buffer.byteLength(value, "utf8") > limit) {
      throw new HubError("invalid", `参数不对：${field} 不能超过 ${limit} 字节`);
    }
  }
  for (const [field, kind] of Object.entries(FIELD_KINDS[command] ?? {})) {
    const value = body[field];
    if (typeof value !== "string") continue;
    if (kind === "path" && !isCrossPlatformAbsolutePath(value)) {
      throw new HubError("invalid", `参数不对：${field} 必须是绝对路径`);
    }
    if (kind === "path" && value.includes("\0")) throw new HubError("invalid", `参数不对：${field} 不能含 NUL 字符`);
    if (kind === "name" && CONTROL_CHARS.test(value)) throw new HubError("invalid", `参数不对：${field} 不能含 NUL 或控制字符`);
  }
}

function send(reply: FastifyReply, response: HubResponse): FastifyReply {
  return reply.code(response.ok ? 200 : HUB_ERROR_HTTP_STATUS[response.code]).send(response);
}

interface SchemaIssue {
  keyword: string;
  instancePath: string;
  params: Record<string, unknown>;
}

const TYPE_NAMES: Record<string, string> = { string: "文字", integer: "整数", number: "数字", boolean: "true 或 false", object: "对象（JSON）", array: "列表", null: "null" };

const fieldOf = (issue: SchemaIssue): string => issue.instancePath.replace(/^\//, "").replaceAll("/", ".");

function describeIssue(issue: SchemaIssue, all: readonly SchemaIssue[]): string {
  const field = fieldOf(issue);
  const target = field === "" ? "请求体" : field;
  const params = issue.params;
  switch (issue.keyword) {
    case "required": {
      // anyOf reports required for every branch; merge them into one "missing a or b" message.
      const missing = all.filter((i) => i.keyword === "required" && fieldOf(i) === field).map((i) => String(i.params.missingProperty));
      return `缺 ${[...new Set(missing)].join(" 或 ")}`;
    }
    case "additionalProperties":
      return `多了 ${String(params.additionalProperty)}`;
    case "type": {
      const names = String(params.type).split(",").map((t) => TYPE_NAMES[t] ?? t);
      return `${target}${field === "" ? "" : " "}必须是${names.join("或")}`;
    }
    case "minLength":
      return params.limit === 1 ? `${target} 不能是空的` : `${target} 不能少于 ${String(params.limit)} 个字`;
    case "maxLength":
      return `${target} 不能超过 ${String(params.limit)} 个字`;
    case "minimum":
      return `${target} 不能小于 ${String(params.limit)}`;
    case "enum":
      return `${target} 只能是 ${(params.allowedValues as unknown[]).join("、")}`;
    default:
      return `${target} 的值不对`;
  }
}

function describeValidation(issues: readonly SchemaIssue[]): string {
  const first = issues.find((i) => i.keyword !== "anyOf" && i.keyword !== "oneOf") ?? issues[0];
  return first === undefined ? "请求内容不对" : describeIssue(first, issues);
}

function describeFramework(err: FastifyError): string {
  switch (err.code) {
    case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
      return "请求的内容类型必须是 application/json";
    case "FST_ERR_CTP_EMPTY_JSON_BODY":
      return "请求体是空的，要给一个 JSON 对象";
    case "FST_ERR_CTP_INVALID_CONTENT_LENGTH":
      return "请求体的长度和声明的不一致";
    case "FST_ERR_BAD_URL":
      return "网址里有解不开的编码";
    default:
      return err instanceof SyntaxError || err.code === "FST_ERR_CTP_INVALID_JSON_BODY" ? "请求体不是合法的 JSON" : "请求的格式不对";
  }
}

const reasonOf = (err: HubError | LedgerRequestError): string => err.message;

function fail(reply: FastifyReply, code: HubErrorCode, message: string): FastifyReply {
  return send(reply, { ok: false, code, message });
}

const UNAUTHORIZED_MESSAGE = "令牌不对或已作废：这个会话不能再用 hub";

async function modelQuotas(quota: AgentApiOptions["quota"], vendor: AgentVendor | undefined, signal: AbortSignal) {
  if (quota === undefined) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const fetched = await unlessAborted(Promise.race([
      quota.get().catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), HUB_MODELS_QUOTA_WAIT_MS); }),
    ]), signal, () => null);
    const at = (quota.now ?? Date.now)();
    const observed = quota.observed.snapshot(at);
    return Object.fromEntries((vendor === undefined ? AGENT_VENDORS : [vendor]).flatMap((v) => {
      const entry = mergeVendorQuota(v, observed[v] ?? null, fetched ?? null, at);
      return entry === undefined ? [] : [[v, entry]];
    }));
  } finally {
    clearTimeout(timer);
  }
}

function createPreparation(opts: AgentApiOptions) {
  const { ledger } = opts;
  const probeWorkspace = opts.probeWorkspace ?? ((folder: string) => defaultProbeWorkspace(folder));
  const probePr = opts.probePr ?? ((cwd: string, branch: string) => defaultProbePr(cwd, branch));
  const probePrByUrl = opts.probePrByUrl ?? ((cwd: string, url: string) => defaultProbePrByUrl(cwd, url));
  const findTranscript = opts.findTranscript ?? ((ref: TranscriptRef) => vendorTranscriptPath(ref));

  return async (sessionId: SessionId, command: HubCommand, body: Record<string, unknown>, signal: AbortSignal): Promise<HubCallContext> => {
    const role = ledger.sessionRole(sessionId);
    if (role === null || !hubCommandAllowed(role, command)) return {};
    const reconcile = ledger.reconcileHubBranches?.(sessionId, command, body, signal);
    if (reconcile != null) await reconcile;
    if (signal.aborted) return {};
    if (command === "ask" || command === "router.report") {
      const files = body.files as HubFileArg[] | undefined;
      if (files === undefined || files.length === 0 || files.length > HUB_FILE_ARGS_MAX) return {};
      return { sharedFiles: await ledger.shareHubFiles(sessionId, files, signal) };
    }
    if (command === "status") {
      const selfReload = role === "pm" ? opts.selfReloadStatus?.() : undefined;
      return selfReload === undefined ? {} : { selfReload };
    }
    if (command === "models") {
      const vendor = isAgentVendor(body.vendor) ? body.vendor : undefined;
      if (body.vendor !== undefined && vendor === undefined) return {};
      const [modelCatalogs, vendorQuotas] = await Promise.all([
        opts.models?.list({ refresh: body.refresh === true, ...(vendor ? { vendor } : {}) }),
        modelQuotas(opts.quota, vendor, signal),
      ]);
      return { modelCatalogs, vendorQuotas };
    }
    if (command === "worker.show") {
      const target = ledger.workerPrTarget(sessionId, body.workerId as number);
      const pr = target === null ? null : await probePr(target.cwd, target.branch);
      if (signal.aborted) return {};
      const ref = ledger.workerTranscriptTarget(sessionId, body.workerId as number);
      const transcript = ref === null ? null : findTranscript(ref);
      return { ...(pr === null ? {} : { pr }), transcript };
    }
    if (command === "graph.finish") {
      const targets = ledger.graphPrTargets?.(sessionId, body.graphId as number | undefined) ?? [];
      if (targets.length === 0) return {};
      const entries = await Promise.all(
        targets.map(async (t) => {
          const key = "prUrl" in t ? t.prUrl : t.branch;
          const res = await ("prUrl" in t ? probePrByUrl(t.cwd, t.prUrl) : probePr(t.cwd, t.branch)).catch(() => null);
          return res !== null && !("unavailable" in res) ? ([key, res] as const) : null;
        }),
      );
      const graphPrs: Record<string, WorkerPr> = {};
      for (const entry of entries) {
        if (entry !== null) graphPrs[entry[0]] = entry[1];
      }
      return { graphPrs };
    }
    if (
      command === "graph.create" ||
      command === "graph.patch" ||
      command === "graph.done" ||
      command === "graph.decide" ||
      command === "graph.skip"
    ) {
      const context: HubCallContext = {};
      const folder = ledger.workerStartFolder(sessionId);
      if (folder !== null) context.workspace = await probeWorkspace(folder);
      if (signal.aborted) return context;
      if (opts.refreshVendor) {
        const refresh = opts.refreshVendor;
        await Promise.all((ledger.graphAutoDispatchVendors?.(sessionId, command, body) ?? []).map((v) => refresh(v)));
      }
      return context;
    }
    if (command !== "worker.start") return {};
    const context: HubCallContext = {};
    if (opts.refreshVendor && isAgentVendor(body.vendor)) await opts.refreshVendor(body.vendor);
    if (signal.aborted || body.noWorktree === true) return context;
    const folder = ledger.workerStartFolder(sessionId);
    if (folder !== null) context.workspace = await probeWorkspace(folder);
    return context;
  };
}

export function createAgentApi(opts: AgentApiOptions): FastifyInstance {
  const { ledger, tokens } = opts;
  const prepare = createPreparation(opts);
  const requestTimeoutMs = opts.requestTimeoutMs ?? HUB_REQUEST_TIMEOUT_MS;
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: HUB_MAX_BODY_BYTES,
    requestTimeout: requestTimeoutMs,
    // Node swaps headersTimeout and requestTimeout when headersTimeout is larger, so both are lowered to cut half-sent requests after about 15 seconds.
    http: { headersTimeout: requestTimeoutMs, connectionsCheckingInterval: opts.timeoutCheckMs ?? HUB_TIMEOUT_CHECK_MS },
    // close() drops open connections instead of waiting, so shutdown always finishes.
    forceCloseConnections: true,
    // Reject unknown fields and wrong types instead of silently stripping or coercing them.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
    frameworkErrors: (err, _req, reply) => {
      void fail(reply, "invalid", `参数不对：${describeFramework(err)}`);
    },
  });
  const authOf = new WeakMap<FastifyRequest, { sessionId: SessionId; token: string }>();

  // On close, cancel pending prepares first, then wait for in-flight handlers after connections drop.
  const closing = new AbortController();
  const handlers = new Set<Promise<unknown>>();
  const preparing = new Set<Promise<unknown>>();
  app.addHook("preClose", (done) => {
    closing.abort();
    done();
  });
  app.addHook("onClose", async () => {
    while (handlers.size > 0) await Promise.all(handlers);
    // Pending prepares settle on abort, but reads stuck in open() cannot be cancelled, so wait at most HUB_SHUTDOWN_PREPARE_GRACE_MS.
    if (preparing.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(preparing),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, HUB_SHUTDOWN_PREPARE_GRACE_MS))),
    ]);
    clearTimeout(timer);
  });
  const runPrepare = (sessionId: SessionId, command: HubCommand, body: Record<string, unknown>): Promise<HubCallContext | null> => {
    const work = prepare(sessionId, command, body, closing.signal);
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    preparing.add(settled);
    void settled.then(() => preparing.delete(settled));
    return unlessAborted(work, closing.signal, () => null);
  };
  const shuttingDown = (reply: FastifyReply) => fail(reply, "shutting_down", API_ERRORS.shutting_down.text);
  const tracked =
    (handler: (req: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply>) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      if (closing.signal.aborted) return shuttingDown(reply);
      const run = handler(req, reply);
      const settled = run.then(
        () => undefined,
        () => undefined,
      );
      handlers.add(settled);
      void settled.then(() => handlers.delete(settled));
      try {
        return await run;
      } catch (error) {
        if (closing.signal.aborted) return shuttingDown(reply);
        throw error;
      }
    };

  const reportHealth = (error: string | null) => {
    try {
      ledger.reportHealth("agent-api", error);
    } catch (err) {
      app.log.error({ err }, "agent-api reportHealth failed");
      opts.log?.(`${LOG_PREFIX} agent 接口记健康状态失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Authenticate before routing, reading the body, or touching the ledger.
  app.addHook("onRequest", async (req, reply) => {
    const match = BEARER.exec(req.headers.authorization ?? "");
    const token = match?.[1] ?? "";
    const sessionId = match === null ? null : tokens.resolve(token);
    if (sessionId === null) return fail(reply, "unauthorized", UNAUTHORIZED_MESSAGE);
    authOf.set(req, { sessionId, token });
  });

  app.setErrorHandler((err: FastifyError | HubError | LedgerRequestError, req, reply) => {
    if (closing.signal.aborted) return shuttingDown(reply);
    if (err instanceof HubError || err instanceof LedgerRequestError) return fail(reply, err.code, reasonOf(err));
    if ((err as FastifyError).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return fail(reply, "invalid", `参数不对：请求体不能超过 ${HUB_MAX_BODY_BYTES} 字节`);
    }
    const validation = (err as FastifyError).validation;
    if (validation !== undefined) {
      req.log.info({ err }, "agent-api request body rejected");
      return fail(reply, "invalid", `参数不对：${describeValidation(validation as unknown as SchemaIssue[])}`);
    }
    const status = (err as FastifyError).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      req.log.info({ err }, "agent-api request rejected by fastify");
      return fail(reply, "invalid", `参数不对：${describeFramework(err as FastifyError)}`);
    }
    req.log.error({ err }, "agent-api request failed");
    opts.log?.(`${LOG_PREFIX} hub 请求出错（${req.method} ${req.url.split("?", 1)[0]}）：${err.message}`);
    reportHealth(err.message);
    return fail(reply, "internal", API_ERRORS.internal.text);
  });

  app.setNotFoundHandler((req, reply) => fail(reply, "invalid", `未知命令：${req.method} ${req.url.split("?", 1)[0]}`));

  for (const command of HUB_COMMANDS) {
    app.post(hubPath(command), { schema: { body: BODY_SCHEMAS[command] } }, tracked(async (req, reply) => {
      const auth = authOf.get(req);
      if (auth === undefined) throw new Error("agent-api: request reached a route without a session");
      const role = ledger.sessionRole(auth.sessionId);
      if (opts.sandboxGuard) {
        opts.sandboxGuard.assertRegularHubAllowed(role);
      } else if (role === "assistant") {
        throw new LedgerRequestError("forbidden", "总助只读调度会话严禁调用普通 hub 命令，只能调用 hub dispatch");
      }
      const body = req.body as Record<string, unknown>;
      checkFields(command, body);
      const stillAuthorized = () => tokens.resolve(auth.token) === auth.sessionId;
      // The token may be revoked while the body uploads, so check before preparing.
      if (!stillAuthorized()) return fail(reply, "unauthorized", UNAUTHORIZED_MESSAGE);
      const context = await runPrepare(auth.sessionId, command, body);
      if (context === null || closing.signal.aborted) return shuttingDown(reply);
      // Prepares (large copies, git probes) take time, so check the token again before calling the ledger.
      if (!stillAuthorized()) return fail(reply, "unauthorized", UNAUTHORIZED_MESSAGE);
      const result = ledger.hubCall(auth.sessionId, command, body as never, context);
      reportHealth(null);
      return send(reply, { ok: true, text: result.text, data: result.data });
    }));
  }

  const selfReloadSchema = { type: "object", additionalProperties: false, properties: { build: { type: "boolean" } } };
  app.post(SELF_RELOAD_AGENT_PATH, { schema: { body: selfReloadSchema } }, tracked(async (req, reply) => {
    const auth = authOf.get(req);
    if (auth === undefined) throw new Error("agent-api: request reached self.reload without a session");
    // Only PMs may restart the daemon.
    if (ledger.sessionRole(auth.sessionId) !== "pm") throw new LedgerRequestError("forbidden", "只有项目经理可以调用 hub self-reload");
    if (!opts.selfReload) throw new LedgerRequestError("conflict", SELF_RELOAD_UNSUPPORTED_MESSAGE);
    const result = opts.selfReload({ sessionId: auth.sessionId, build: (req.body as { build?: boolean }).build === true });
    reportHealth(null);
    return reply.code(200).send({ ok: true, text: result.text, data: result.data });
  }));

  const routerDispatchSchema = {
    type: "object",
    additionalProperties: false,
    required: ["op", "device"],
    properties: {
      op: {
        type: "string",
        enum: ["pm", "worker-start", "worker-stop", "worker-send", "worker-end", "worker-list", "project-create", "project-show"],
      },
      device: { type: "string", minLength: 1, maxLength: MAX_NAME_CHARS * 2 },
      pmId: workerIdField,
      projectId: workerIdField,
      workerId: workerIdField,
      title: { type: "string", minLength: 1, maxLength: MAX_NAME_CHARS * 2 },
      vendor: { type: "string", minLength: 1, maxLength: MAX_MODEL_CHARS },
      model: { type: "string", minLength: 1, maxLength: MAX_MODEL_CHARS },
      effort: { type: "string", minLength: 1, maxLength: MAX_MODEL_CHARS },
      readonly: { type: "boolean" },
      noWorktree: { type: "boolean" },
      verbatim: { type: "boolean" },
      text: taskField,
      task: taskField,
      folder: pathField,
      name: nameField,
      pmName: nameField,
      mode: { type: "string", enum: [...PM_MODES] },
    },
  };

  app.post(ROUTER_DISPATCH_AGENT_PATH, { schema: { body: routerDispatchSchema } }, tracked(async (req, reply) => {
    const auth = authOf.get(req);
    if (auth === undefined) throw new Error("agent-api: request reached router.dispatch without a session");
    const role = ledger.sessionRole(auth.sessionId);
    if (role !== "assistant") {
      throw new LedgerRequestError("forbidden", "只有总助调度会话可以调用 hub dispatch");
    }
    if (!opts.sandboxGuard || !opts.onRouterDispatch) {
      throw new LedgerRequestError("forbidden", "当前服务未启用总助调度通道");
    }
    const commandId = opts.sandboxGuard.assertCanDispatch(auth.sessionId, role);
    const body = req.body as Record<string, unknown>;
    if (typeof body.text === "string" && Buffer.byteLength(body.text, "utf8") > MAX_TASK_BYTES) {
      throw new HubError("invalid", `参数不对：text 不能超过 ${MAX_TASK_BYTES} 字节`);
    }
    if (typeof body.task === "string" && Buffer.byteLength(body.task, "utf8") > MAX_TASK_BYTES) {
      throw new HubError("invalid", `参数不对：task 不能超过 ${MAX_TASK_BYTES} 字节`);
    }
    if (typeof body.folder === "string") {
      if (Buffer.byteLength(body.folder, "utf8") > MAX_PATH_BYTES) {
        throw new HubError("invalid", `参数不对：folder 不能超过 ${MAX_PATH_BYTES} 字节`);
      }
      if (body.folder.includes("\0")) {
        throw new HubError("invalid", "参数不对：folder 不能含 NUL 字符");
      }
    }
    for (const field of ["title", "name", "pmName", "device"] as const) {
      const v = body[field];
      if (typeof v === "string" && CONTROL_CHARS.test(v)) {
        throw new HubError("invalid", `参数不对：${field} 不能含 NUL 或控制字符`);
      }
    }
    if (tokens.resolve(auth.token) !== auth.sessionId) return fail(reply, "unauthorized", UNAUTHORIZED_MESSAGE);
    const result = await opts.onRouterDispatch(
      auth.sessionId,
      commandId,
      body as unknown as RouterAgentDispatchInput,
    );
    // Scheduling mutates the ledger, so it is never abandoned midway; onClose waits for it.
    if (closing.signal.aborted) return shuttingDown(reply);
    reportHealth(null);
    return reply.code(200).send({ ok: true, text: result.text, data: result.data });
  }));

  const hubCliPipeSchema = {
    type: "object",
    additionalProperties: false,
    required: ["argv", "cwd"],
    properties: {
      argv: { type: "array", items: { type: "string" } },
      cwd: { type: "string" },
      msystem: { type: "string" },
      exepath: { type: "string" },
      stdinUtf8: { type: "string" },
      stdinInvalidUtf8: { type: "boolean" },
    },
  };

  app.post("/hub/cli", { bodyLimit: HUB_MAX_BODY_BYTES * 4, schema: { body: hubCliPipeSchema } }, tracked(async (req, reply) => {
    const auth = authOf.get(req);
    if (auth === undefined) throw new Error("agent-api: request reached /hub/cli without a session");
    const sock = opts.boundSocketPath?.() ?? "";
    if (!sock) {
      return fail(reply, "internal", API_ERRORS.internal.text);
    }
    const body = req.body as {
      argv: string[];
      cwd: string;
      msystem?: string;
      exepath?: string;
      stdinUtf8?: string;
      stdinInvalidUtf8?: boolean;
    };
    let stdout = "";
    let stderr = "";
    const exitCode = await runHubSafely({
      argv: body.argv,
      cwd: body.cwd || process.cwd(),
      env: {
        [ENV_HUB_TOKEN]: auth.token,
        [ENV_HUB_SOCK]: sock,
        ...(body.msystem !== undefined ? { MSYSTEM: body.msystem } : {}),
        ...(body.exepath !== undefined ? { EXEPATH: body.exepath } : {}),
      },
      stdin: () => {
        if (body.stdinInvalidUtf8) {
          return Readable.from([Buffer.from([0xff, 0xfe])]);
        }
        return Readable.from(body.stdinUtf8 !== undefined ? [Buffer.from(body.stdinUtf8, "utf8")] : []);
      },
      stdout: { write: (chunk: string) => { stdout += chunk; } },
      stderr: { write: (chunk: string) => { stderr += chunk; } },
    });
    return reply.code(200).send({ exitCode, stdout, stderr });
  }));

  return app;
}

export interface AgentApiListenOptions extends AgentApiOptions {
  runDir: string;
  hubSock: string;
}

export interface RunningAgentApi {
  app: FastifyInstance;
  socketPath: string;
  close(): Promise<void>;
}

export async function startAgentApi(opts: AgentApiListenOptions): Promise<RunningAgentApi> {
  if (!isWindowsNamedPipe(opts.hubSock) && resolve(dirname(opts.hubSock)) !== resolve(opts.runDir)) {
    throw new Error(`hubSock must be directly inside runDir: ${opts.hubSock}`);
  }
  let activeSocketPath = opts.hubSock;
  const app = createAgentApi({ ...opts, boundSocketPath: () => activeSocketPath });
  const socketPath = await listenOnRunSocket(
    opts.hubSock,
    (path) => app.listen({ path }).then(() => undefined),
    () => app.close(),
  );
  activeSocketPath = socketPath;
  return { app, socketPath, close: () => app.close() };
}
