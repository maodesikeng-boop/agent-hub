// agent 接口（设计第 4.2、8.1、8.2 节；m2-plan 第 3 节接口约定第 4 条）：第二个 Fastify 实例，只监听 Unix socket run/hub.sock。
// 按会话令牌认人，按 JSON Schema 查请求体的形状和长度，再交给账本的 hubCall。规格见 shared/hub.ts 的注释。
import { dirname, resolve } from "node:path";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
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
  PM_MODES,
  ROUTER_DISPATCH_AGENT_PATH,
  ROUTER_PM_BRIEF_MAX_CHARS,
  SELF_RELOAD_AGENT_PATH,
  SELF_RELOAD_UNSUPPORTED_MESSAGE,
  TASK_GRAPH_STATUSES,
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
import { listenOnRunSocket } from "../run-socket.ts";
import type { RouterSandboxGuard } from "../router/sandbox.ts";
import type { WorkerPrProbeResult } from "../../shared/hub.ts";
import type { HubCallContext, WorkspaceProbe } from "../../shared/ledger.ts";
import { isAgentVendor, type AgentVendor, type ModelCatalog, type VendorAvailability } from "../../shared/vendors.ts";
import { vendorTranscriptPath } from "../driver/transcript.ts";
import type { TranscriptRef } from "../driver/transcript.ts";
import { probePr as defaultProbePr, probeWorkspace as defaultProbeWorkspace } from "../git/index.ts";

export interface AgentApiOptions {
  /** reportHealth：500 记一次 "agent-api" 失败，成功一次清零；400–409 不算。 */
  ledger: Pick<Ledger, "hubCall" | "sessionRole" | "reportHealth" | "workerStartFolder" | "workerPrTarget" | "workerTranscriptTarget">;
  /**
   * hub worker start 之前异步探主文件夹的 git（m3-plan 第 2.6 节），结果作为 HubCallContext.workspace 交给 hubCall：
   * 账本的事务里不做 I/O，git 卡住也不会停住整个守护进程。默认 daemon/git 的 probeWorkspace（每次 git 最多 GIT_PROBE_TIMEOUT_MS）。
   */
  probeWorkspace?: (folder: string) => Promise<WorkspaceProbe>;
  /**
   * hub worker show 之前异步查 Worker 分支上的 PR（同上，事务里不做 I/O），结果作为 HubCallContext.pr。
   * 没有 PR 返回 null（show 不写 PR 行）；gh 查不了返回 { unavailable: 原因 }（show 显示“PR 查不了（原因）”）。默认 gh pr list（最多 WORKER_PR_PROBE_TIMEOUT_MS）。
   */
  probePr?: (cwd: string, branch: string) => Promise<WorkerPrProbeResult>;
  /**
   * hub worker show 之前找这个 Worker 会话在厂商那边的原始记录文件，结果作为 HubCallContext.transcript。
   * 找不到返回 null。默认驱动层的 vendorTranscriptPath（只读文件系统）。
   */
  findTranscript?: (ref: TranscriptRef) => string | null;
  /**
   * hub worker start --vendor 选的这家在这台设备上能不能用（不能用的先重问一次，守护进程接 ModelCatalogs.ensureUsable）。
   * 不给就不查（都当能用）。
   */
  vendorUsable?: (vendor: AgentVendor) => Promise<VendorAvailability>;
  /**
   * hub models 查询各厂商模型目录（守护进程接 ModelCatalogs）。不给就不预查，由账本用缓存或打包目录兜底。
   */
  models?: { list(options?: { refresh?: boolean | "unusable"; vendor?: AgentVendor }): Promise<ModelCatalog[]> };
  /** 这台设备的名字（不能用时报错里写）。 */
  deviceName?: () => string;
  /** Router 轨道 B 沙箱与活跃指令绑定守卫。 */
  sandboxGuard?: RouterSandboxGuard;
  /** Router 轨道 B 调用 `hub dispatch` 时的异步分派回调。 */
  onRouterDispatch?: (
    sessionId: SessionId,
    commandId: RouterCommandId,
    payload: RouterAgentDispatchInput,
  ) => Promise<{ text: string; data: unknown }>;
  /**
   * `hub self-reload [--build]`：登记空闲排空热重启（daemon/self-reload.ts），立即返回。只放行项目经理的会话。
   * 不给 = 这台守护进程不支持（没有外壳监管，退出后没人拉起），回 conflict。
   */
  selfReload?: (input: { sessionId: SessionId; build: boolean }) => { text: string; data: unknown };
  tokens: SessionTokens;
  logger?: boolean;
  /** 守护进程的日志（组装代码给）：500 和 reportHealth 出错各写一行。不给就只走 Fastify 的 logger。 */
  log?: (line: string) => void;
  /** 一个请求从连上到收完的上限，默认 HUB_REQUEST_TIMEOUT_MS；测试里调小，几秒就能看到半截请求被断开。 */
  requestTimeoutMs?: number;
  /** 多久查一次有没有超时的请求，默认 HUB_TIMEOUT_CHECK_MS。 */
  timeoutCheckMs?: number;
}

const BEARER = /^Bearer ([A-Za-z0-9_-]+)$/;

// ---- 请求体的规格 ----

const nameField = { type: "string", minLength: 1, maxLength: MAX_NAME_CHARS };
/** 字节上限另查（ajv 的 maxLength 按字符算）；这里的 maxLength 只是先挡一下，字符数不会比字节数多。 */
const pathField = { type: "string", minLength: 1, maxLength: MAX_PATH_BYTES };
const noArgs = { type: "object", additionalProperties: false, properties: {} };

const folderOnly = { type: "object", additionalProperties: false, required: ["folder"], properties: { folder: pathField } };
// hub worker …（M3）：编号是正整数；任务说明、打回的话按字节另查（BYTE_LIMITS）
const workerIdField = { type: "integer", minimum: 1 };
const taskField = { type: "string", minLength: 1, maxLength: MAX_TASK_BYTES };

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
  // null 是清除（hub project setup --clear）；字节数另查（BYTE_LIMITS），空的、带 NUL 由账本拒
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
    required: ["title", "task"],
    properties: {
      // 太长不拒，账本用 normalizeWorkerTitle 截断到 MAX_WORKER_TITLE_CHARS
      title: { type: "string", minLength: 1 },
      task: taskField,
      vendor: { type: "string", minLength: 1, maxLength: MAX_MODEL_CHARS },
      model: { type: "string", minLength: 1, maxLength: MAX_MODEL_CHARS },
      // 取值由账本按项目经理那家的清单查（vendors.ts），这里只管形状
      effort: { type: "string", minLength: 1, maxLength: MAX_MODEL_CHARS },
      // maxTimeMs 的范围（MIN_WORKER_MAX_TIME_MS 到 MAX_WORKER_MAX_TIME_MS）由账本查，报中文原因
      maxTimeMs: { type: "integer" },
      readonly: { type: "boolean" },
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
    properties: { workerId: workerIdField, incomplete: { type: "boolean" } },
  },
  "worker.list": noArgs,
  "worker.show": {
    type: "object",
    additionalProperties: false,
    required: ["workerId"],
    properties: { workerId: workerIdField, task: { type: "boolean" }, report: { oneOf: [{ type: "integer" }, { const: "latest" }] } },
  },
  // 关键词个数、长度、limit 的范围由账本查，报中文原因
  "worker.search": {
    type: "object",
    additionalProperties: false,
    required: ["keywords"],
    properties: { keywords: { type: "array", items: { type: "string" } }, limit: { type: "integer" } },
  },
  // last 的范围（1 到 WORKER_LOG_MAX_STEPS）由账本查，报中文原因
  "worker.log": {
    type: "object",
    additionalProperties: false,
    required: ["workerId"],
    properties: { workerId: workerIdField, last: { type: "integer" }, stats: { type: "boolean" } },
  },
  models: {
    type: "object",
    additionalProperties: false,
    properties: {
      vendor: { type: "string", minLength: 1, maxLength: MAX_MODEL_CHARS },
      refresh: { type: "boolean" },
    },
  },
  ask: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: { text: taskField, options: { type: "array", items: { type: "string" } } },
  },
  // hub schedule …（M6）：daily 的 HH:MM、间隔的范围、两个频率二选一由账本查（报中文原因）；任务说明按字节另查
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
  "router.ask": {
    type: "object",
    additionalProperties: false,
    required: ["question", "options"],
    properties: {
      question: { type: "string", minLength: 1, maxLength: MAX_TASK_BYTES },
      options: { type: "array", items: { type: "string" } },
      context: { type: "string", maxLength: MAX_TASK_BYTES },
      replaceItemId: workerIdField,
    },
  },
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
    },
  },
  "router.note": {
    type: "object",
    additionalProperties: false,
    anyOf: [{ required: ["text"] }, { required: ["clear"] }],
    properties: {
      text: { type: "string", minLength: 1, maxLength: ROUTER_PM_BRIEF_MAX_CHARS * 4 },
      clear: { type: "boolean" },
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
  "graph.ask": {
    type: "object",
    additionalProperties: false,
    required: ["nodeKey", "question"],
    properties: {
      nodeKey: { type: "string", minLength: 1, maxLength: MAX_NODE_KEY_CHARS * 2 },
      graphId: workerIdField,
      question: { type: "string", minLength: 1, maxLength: MAX_TASK_BYTES },
      options: { type: "array", items: { type: "string" } },
      recommended: { type: "string" },
      summaryMd: { type: "string", maxLength: MAX_TASK_BYTES },
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
};

/** 要查字符的字段：path 必须是绝对路径、不含 NUL；name 不含 NUL 和控制字符。 */
const FIELD_KINDS: Partial<Record<HubCommand, Record<string, "path" | "name">>> = {
  "project.create": { name: "name", folder: "path" },
  "project.attach": { folder: "path" },
  "project.detach": { folder: "path" },
  "worker.start": { title: "name" },
  "schedule.add": { name: "name" },
};
/** C0、DEL、C1 控制字符（含 NUL、换行、制表符）。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/u;

/** 按 UTF-8 字节算上限的字段。 */
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
    if (kind === "path" && !value.startsWith("/")) throw new HubError("invalid", `参数不对：${field} 必须是绝对路径（以 / 开头）`);
    if (kind === "path" && value.includes("\0")) throw new HubError("invalid", `参数不对：${field} 不能含 NUL 字符`);
    if (kind === "name" && CONTROL_CHARS.test(value)) throw new HubError("invalid", `参数不对：${field} 不能含 NUL 或控制字符`);
  }
}

function send(reply: FastifyReply, response: HubResponse): FastifyReply {
  return reply.code(response.ok ? 200 : HUB_ERROR_HTTP_STATUS[response.code]).send(response);
}

// ---- 请求体校验没过：按 schema 的错拼中文，写出字段名（英文原文只进日志）----

/** ajv 报错里用到的几项（Fastify 的 err.validation）。 */
interface SchemaIssue {
  keyword: string;
  instancePath: string;
  params: Record<string, unknown>;
}

const TYPE_NAMES: Record<string, string> = { string: "文字", integer: "整数", number: "数字", boolean: "true 或 false", object: "对象（JSON）", array: "列表", null: "null" };

const fieldOf = (issue: SchemaIssue): string => issue.instancePath.replace(/^\//, "").replaceAll("/", ".");

/** 一条 schema 错 → 一句中文（不含“参数不对：”前缀）。 */
function describeIssue(issue: SchemaIssue, all: readonly SchemaIssue[]): string {
  const field = fieldOf(issue);
  const target = field === "" ? "请求体" : field;
  const params = issue.params;
  switch (issue.keyword) {
    case "required": {
      // anyOf（几个里至少给一个）会连报每个分支的 required：合成一句“缺 a 或 b”
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
  // anyOf / oneOf 自己那一条没有字段信息，看它前面具体的几条
  const first = issues.find((i) => i.keyword !== "anyOf" && i.keyword !== "oneOf") ?? issues[0];
  return first === undefined ? "请求内容不对" : describeIssue(first, issues);
}

/** Fastify 自己的 4xx（JSON 坏了、内容类型不对、网址解不开……）→ 一句中文。 */
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

/** HubError、LedgerRequestError 的 message 是写给人的中文业务原因，原样回给 agent（和异常原文不是一回事）。 */
const reasonOf = (err: HubError | LedgerRequestError): string => err.message;

function fail(reply: FastifyReply, code: HubErrorCode, message: string): FastifyReply {
  return send(reply, { ok: false, code, message });
}

const UNAUTHORIZED_MESSAGE = "令牌不对或已作废：这个会话不能再用 hub";

export function createAgentApi(opts: AgentApiOptions): FastifyInstance {
  const { ledger, tokens } = opts;
  const probeWorkspace = opts.probeWorkspace ?? ((folder: string) => defaultProbeWorkspace(folder));
  const probePr = opts.probePr ?? ((cwd: string, branch: string) => defaultProbePr(cwd, branch));
  const findTranscript = opts.findTranscript ?? ((ref: TranscriptRef) => vendorTranscriptPath(ref));

  /** hubCall 之前要异步准备的东西：worker.start（没带 noWorktree、有项目）要探 git，worker.show 要查 PR，models 要查模型目录。 */
  const prepare = async (sessionId: SessionId, command: HubCommand, body: Record<string, unknown>): Promise<HubCallContext> => {
    const role = ledger.sessionRole(sessionId);
    if (role === null || !hubCommandAllowed(role, command)) return {};
    if (command === "models") {
      if (!opts.models) return {};
      const vendor = isAgentVendor(body.vendor) ? body.vendor : undefined;
      if (body.vendor !== undefined && vendor === undefined) return {};
      return { modelCatalogs: await opts.models.list({ refresh: body.refresh === true, ...(vendor ? { vendor } : {}) }) };
    }
    if (command === "worker.show") {
      const target = ledger.workerPrTarget(sessionId, body.workerId as number);
      const pr = target === null ? null : await probePr(target.cwd, target.branch);
      const ref = ledger.workerTranscriptTarget(sessionId, body.workerId as number);
      const transcript = ref === null ? null : findTranscript(ref);
      return { ...(pr === null ? {} : { pr }), transcript };
    }
    if (command !== "worker.start") return {};
    const context: HubCallContext = {};
    // 带 --vendor：这家在这台设备上能不能用（不带就是项目经理自己那家，正在用着，不查）
    if (opts.vendorUsable && isAgentVendor(body.vendor)) {
      const vendor = body.vendor;
      context.vendorStatus = { vendor, availability: await opts.vendorUsable(vendor), device: opts.deviceName?.() ?? "" };
    }
    if (body.noWorktree === true) return context;
    const folder = ledger.workerStartFolder(sessionId);
    if (folder !== null) context.workspace = await probeWorkspace(folder);
    return context;
  };
  const requestTimeoutMs = opts.requestTimeoutMs ?? HUB_REQUEST_TIMEOUT_MS;
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: HUB_MAX_BODY_BYTES,
    requestTimeout: requestTimeoutMs,
    // Node 在 headersTimeout（默认 60 秒）大于 requestTimeout 时把两个对调，请求头收完后的上限就成了 60 秒；
    // 检查间隔默认 30 秒。两个都压下来，半截请求才是 15 秒左右断开。
    http: { headersTimeout: requestTimeoutMs, connectionsCheckingInterval: opts.timeoutCheckMs ?? HUB_TIMEOUT_CHECK_MS },
    // close() 不等还连着的请求，直接断开，保证关得掉。
    forceCloseConnections: true,
    // 多余参数要报错，不能悄悄删掉；类型不对也不替它转换。
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
    // 路由之前的错（URL 解不开……）：onRequest 还没跑，也按 HubResponse 回 invalid。
    frameworkErrors: (err, _req, reply) => {
      void fail(reply, "invalid", `参数不对：${describeFramework(err)}`);
    },
  });
  const authOf = new WeakMap<FastifyRequest, { sessionId: SessionId; token: string }>();

  /** 报健康状态失败不能影响回答。 */
  const reportHealth = (error: string | null) => {
    try {
      ledger.reportHealth("agent-api", error);
    } catch (err) {
      app.log.error({ err }, "agent-api reportHealth failed");
      opts.log?.(`${LOG_PREFIX} agent 接口记健康状态失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 先认人：令牌不对的请求不看路由、不读请求体、不调账本。
  app.addHook("onRequest", async (req, reply) => {
    const match = BEARER.exec(req.headers.authorization ?? "");
    const token = match?.[1] ?? "";
    const sessionId = match === null ? null : tokens.resolve(token);
    if (sessionId === null) return fail(reply, "unauthorized", UNAUTHORIZED_MESSAGE);
    authOf.set(req, { sessionId, token });
  });

  app.setErrorHandler((err: FastifyError | HubError | LedgerRequestError, req, reply) => {
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
    // Fastify 自己的 4xx（JSON 坏了、内容类型不对……）：hub 只认 HUB_ERROR_HTTP_STATUS 里的状态，一律算 invalid。英文原文只进日志。
    if (status !== undefined && status >= 400 && status < 500) {
      req.log.info({ err }, "agent-api request rejected by fastify");
      return fail(reply, "invalid", `参数不对：${describeFramework(err as FastifyError)}`);
    }
    // 意外的错：原文、堆栈只进日志和接口健康状态；agent 只看到 internal 那句话
    req.log.error({ err }, "agent-api request failed");
    opts.log?.(`${LOG_PREFIX} hub 请求出错（${req.method} ${req.url.split("?", 1)[0]}）：${err.message}`);
    reportHealth(err.message);
    return fail(reply, "internal", API_ERRORS.internal.text);
  });

  app.setNotFoundHandler((req, reply) => fail(reply, "invalid", `未知命令：${req.method} ${req.url.split("?", 1)[0]}`));

  for (const command of HUB_COMMANDS) {
    app.post(hubPath(command), { schema: { body: BODY_SCHEMAS[command] } }, async (req, reply) => {
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
      const context = await prepare(auth.sessionId, command, body);
      // 收请求体、探 git 期间令牌可能已经作废（会话结束了）：调账本前再认一次。
      if (tokens.resolve(auth.token) !== auth.sessionId) return fail(reply, "unauthorized", UNAUTHORIZED_MESSAGE);
      // 请求体的形状已经按 BODY_SCHEMAS 查过，就是这个命令的 HubArgs。
      const result = ledger.hubCall(auth.sessionId, command, body as never, context);
      reportHealth(null);
      return send(reply, { ok: true, text: result.text, data: result.data });
    });
  }

  const selfReloadSchema = { type: "object", additionalProperties: false, properties: { build: { type: "boolean" } } };
  app.post(SELF_RELOAD_AGENT_PATH, { schema: { body: selfReloadSchema } }, async (req, reply) => {
    const auth = authOf.get(req);
    if (auth === undefined) throw new Error("agent-api: request reached self.reload without a session");
    // 只有项目经理能让整个守护进程重启：Worker（含只读）、总助一律 forbidden
    if (ledger.sessionRole(auth.sessionId) !== "pm") throw new LedgerRequestError("forbidden", "只有项目经理可以调用 hub self-reload");
    if (!opts.selfReload) throw new LedgerRequestError("conflict", SELF_RELOAD_UNSUPPORTED_MESSAGE);
    const result = opts.selfReload({ sessionId: auth.sessionId, build: (req.body as { build?: boolean }).build === true });
    reportHealth(null);
    return reply.code(200).send({ ok: true, text: result.text, data: result.data });
  });

  const routerDispatchSchema = {
    type: "object",
    additionalProperties: false,
    required: ["op", "device"],
    properties: {
      op: {
        type: "string",
        enum: ["pm", "worker-start", "worker-stop", "worker-send", "worker-end", "worker-list", "project-create"],
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

  app.post(ROUTER_DISPATCH_AGENT_PATH, { schema: { body: routerDispatchSchema } }, async (req, reply) => {
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
    reportHealth(null);
    return reply.code(200).send({ ok: true, text: result.text, data: result.data });
  });

  return app;
}

export interface AgentApiListenOptions extends AgentApiOptions {
  /** run/：没有就建，权限改成 0700。 */
  runDir: string;
  /** run/hub.sock：必须直接在 runDir 下。 */
  hubSock: string;
}

export interface RunningAgentApi {
  app: FastifyInstance;
  /** realpath 过的 socket 路径：写进 HUB_SOCK 和设置文件的就是它。 */
  socketPath: string;
  /** 停止监听；socket 文件随之删掉。 */
  close(): Promise<void>;
}

/**
 * 在 hubSock 上听（准备和失败收尾见 ../run-socket.ts 的 listenOnRunSocket）：run/ 建好并改成 0700，hub.sock 听上后改成 0600。
 * socket 文件在、但试连连不上，才当残留删掉；连得上说明有活实例，拒绝启动。
 */
export async function startAgentApi(opts: AgentApiListenOptions): Promise<RunningAgentApi> {
  if (resolve(dirname(opts.hubSock)) !== resolve(opts.runDir)) throw new Error(`hubSock must be directly inside runDir: ${opts.hubSock}`);
  const app = createAgentApi(opts);
  const socketPath = await listenOnRunSocket(
    opts.hubSock,
    (path) => app.listen({ path }).then(() => undefined),
    () => app.close(),
  );
  return { app, socketPath, close: () => app.close() };
}
