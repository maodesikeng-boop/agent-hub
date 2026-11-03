// agent 接口（设计第 4.2、8.1、8.2 节；m2-plan 第 3 节接口约定第 4 条）：第二个 Fastify 实例，只监听 Unix socket run/hub.sock。
// 按会话令牌认人，按 JSON Schema 查请求体的形状和长度，再交给账本的 hubCall。规格见 shared/hub.ts 的注释。
import { chmodSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  HUB_COMMANDS,
  HUB_ERROR_HTTP_STATUS,
  HUB_MAX_BODY_BYTES,
  HUB_REQUEST_TIMEOUT_MS,
  HUB_SOCKET_PROBE_MS,
  HUB_TIMEOUT_CHECK_MS,
  LedgerRequestError,
  MAX_DESCRIPTION_CHARS,
  MAX_HANDOFF_BYTES,
  MAX_NAME_CHARS,
  MAX_PATH_BYTES,
  MAX_PERSONA_BYTES,
  MAX_REASON_CHARS,
  PM_MODES,
  hubPath,
  type HubCommand,
  type HubErrorCode,
  type HubResponse,
  type Ledger,
  type SessionId,
  type SessionTokens,
} from "../../shared/index.ts";
import { assertSocketPathFits } from "../../shared/paths.ts";

export interface AgentApiOptions {
  /** reportHealth：500 记一次 "agent-api" 失败，成功一次清零；400–409 不算。 */
  ledger: Pick<Ledger, "hubCall" | "reportHealth">;
  tokens: SessionTokens;
  logger?: boolean;
  /** 守护进程的日志（组装代码给）：500 和 reportHealth 出错各写一行。不给就只走 Fastify 的 logger。 */
  log?: (line: string) => void;
  /** 一个请求从连上到收完的上限，默认 HUB_REQUEST_TIMEOUT_MS；测试里调小，几秒就能看到半截请求被断开。 */
  requestTimeoutMs?: number;
  /** 多久查一次有没有超时的请求，默认 HUB_TIMEOUT_CHECK_MS。 */
  timeoutCheckMs?: number;
}

const RUN_DIR_MODE = 0o700;
const SOCKET_MODE = 0o600;
const BEARER = /^Bearer ([A-Za-z0-9_-]+)$/;

// ---- 请求体的规格 ----

const nameField = { type: "string", minLength: 1, maxLength: MAX_NAME_CHARS };
/** 字节上限另查（ajv 的 maxLength 按字符算）；这里的 maxLength 只是先挡一下，字符数不会比字节数多。 */
const pathField = { type: "string", minLength: 1, maxLength: MAX_PATH_BYTES };
const noArgs = { type: "object", additionalProperties: false, properties: {} };

const BODY_SCHEMAS: Record<HubCommand, object> = {
  status: noArgs,
  "pm.list": noArgs,
  "project.create": {
    type: "object",
    additionalProperties: false,
    required: ["name", "folder"],
    properties: { name: nameField, folder: pathField, description: { type: "string", maxLength: MAX_DESCRIPTION_CHARS } },
  },
  "project.attach": {
    type: "object",
    additionalProperties: false,
    required: ["project", "folder"],
    properties: { project: nameField, folder: pathField },
  },
  "project.detach": {
    type: "object",
    additionalProperties: false,
    required: ["project", "folder"],
    properties: { project: nameField, folder: pathField },
  },
  "project.assign": {
    type: "object",
    additionalProperties: false,
    required: ["project", "to", "handoff"],
    properties: { project: nameField, to: nameField, handoff: { type: "string", minLength: 1, maxLength: MAX_HANDOFF_BYTES } },
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
};

/** 要查字符的字段：path 必须是绝对路径、不含 NUL；name 不含 NUL 和控制字符。 */
const FIELD_KINDS: Partial<Record<HubCommand, Record<string, "path" | "name">>> = {
  "project.create": { name: "name", folder: "path" },
  "project.attach": { project: "name", folder: "path" },
  "project.detach": { project: "name", folder: "path" },
  "project.assign": { project: "name", to: "name" },
};
/** C0、DEL、C1 控制字符（含 NUL、换行、制表符）。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/u;

/** 按 UTF-8 字节算上限的字段。 */
const BYTE_LIMITS: Partial<Record<HubCommand, Record<string, number>>> = {
  "project.create": { folder: MAX_PATH_BYTES },
  "project.attach": { folder: MAX_PATH_BYTES },
  "project.detach": { folder: MAX_PATH_BYTES },
  "project.assign": { handoff: MAX_HANDOFF_BYTES },
  "persona.edit": { text: MAX_PERSONA_BYTES },
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

function fail(reply: FastifyReply, code: HubErrorCode, message: string): FastifyReply {
  return send(reply, { ok: false, code, message });
}

const UNAUTHORIZED_MESSAGE = "令牌不对或已作废：这个会话不能再用 hub";

export function createAgentApi(opts: AgentApiOptions): FastifyInstance {
  const { ledger, tokens } = opts;
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
      void fail(reply, "invalid", `参数不对：${err.message}`);
    },
  });
  const authOf = new WeakMap<FastifyRequest, { sessionId: SessionId; token: string }>();

  /** 报健康状态失败不能影响回答。 */
  const reportHealth = (error: string | null) => {
    try {
      ledger.reportHealth("agent-api", error);
    } catch (err) {
      app.log.error({ err }, "agent-api reportHealth failed");
      opts.log?.(`agent-hub: agent 接口记健康状态失败：${err instanceof Error ? err.message : String(err)}`);
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
    if (err instanceof HubError || err instanceof LedgerRequestError) return fail(reply, err.code, err.message);
    if ((err as FastifyError).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return fail(reply, "invalid", `参数不对：请求体不能超过 ${HUB_MAX_BODY_BYTES} 字节`);
    }
    if ((err as FastifyError).validation !== undefined) return fail(reply, "invalid", `参数不对：${err.message}`);
    const status = (err as FastifyError).statusCode;
    // Fastify 自己的 4xx（JSON 坏了、内容类型不对……）：hub 只认 HUB_ERROR_HTTP_STATUS 里的状态，一律算 invalid。
    if (status !== undefined && status >= 400 && status < 500) return fail(reply, "invalid", `参数不对：${err.message}`);
    req.log.error({ err }, "agent-api request failed");
    opts.log?.(`agent-hub: hub 请求出错（${req.method} ${req.url.split("?", 1)[0]}）：${err.message}`);
    reportHealth(err.message);
    return fail(reply, "internal", err.message);
  });

  app.setNotFoundHandler((req, reply) => fail(reply, "invalid", `未知命令：${req.method} ${req.url.split("?", 1)[0]}`));

  for (const command of HUB_COMMANDS) {
    app.post(hubPath(command), { schema: { body: BODY_SCHEMAS[command] } }, async (req, reply) => {
      const auth = authOf.get(req);
      if (auth === undefined) throw new Error("agent-api: request reached a route without a session");
      const body = req.body as Record<string, unknown>;
      checkFields(command, body);
      // 收请求体期间令牌可能已经作废（会话结束了）：调账本前再认一次。
      if (tokens.resolve(auth.token) !== auth.sessionId) return fail(reply, "unauthorized", UNAUTHORIZED_MESSAGE);
      // 请求体的形状已经按 BODY_SCHEMAS 查过，就是这个命令的 HubArgs。
      const result = ledger.hubCall(auth.sessionId, command, body as never);
      reportHealth(null);
      return send(reply, { ok: true, text: result.text, data: result.data });
    });
  }

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

/** 试连一次：连得上返回 true；ECONNREFUSED、ENOENT（没人监听）返回 false；别的错原样抛。 */
function socketIsLive(socketPath: string): Promise<boolean> {
  return new Promise((done, fail) => {
    const socket = createConnection(socketPath);
    const finish = (result: boolean | Error) => {
      socket.destroy();
      if (result instanceof Error) fail(result);
      else done(result);
    };
    socket.setTimeout(HUB_SOCKET_PROBE_MS, () => finish(true));
    socket.once("connect", () => finish(true));
    socket.once("error", (err: NodeJS.ErrnoException) => {
      finish(err.code === "ECONNREFUSED" || err.code === "ENOENT" ? false : err);
    });
  });
}

/** 残留的 socket（上次没正常关）删掉；还有人在监听就拒绝启动；那里是别的东西就报错，不替用户删。 */
async function removeStaleSocket(socketPath: string): Promise<void> {
  let stat;
  try {
    stat = lstatSync(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (!stat.isSocket()) throw new Error(`agent 接口的 socket 路径上已经有别的东西，不是 socket：${socketPath}。请确认后手动移走。`);
  if (await socketIsLive(socketPath)) throw new Error(`已有守护进程在跑：${socketPath} 上有人在监听，不能再启动一个。`);
  unlinkSync(socketPath);
}

/**
 * 建 run/（0700）、realpath、查路径长度、删残留 socket、listen、socket 改成 0600。
 * listen 和 chmod 之间 socket 短暂是 umask 给的权限，但 run/ 已经是 0700，别人进不来。
 * socket 文件在、但试连连不上，才当残留删掉；连得上说明有活实例，拒绝启动。
 */
export async function startAgentApi(opts: AgentApiListenOptions): Promise<RunningAgentApi> {
  if (resolve(dirname(opts.hubSock)) !== resolve(opts.runDir)) throw new Error(`hubSock must be directly inside runDir: ${opts.hubSock}`);
  mkdirSync(opts.runDir, { recursive: true, mode: RUN_DIR_MODE });
  chmodSync(opts.runDir, RUN_DIR_MODE);
  const socketPath = join(realpathSync.native(opts.runDir), basename(opts.hubSock));
  assertSocketPathFits(socketPath);
  await removeStaleSocket(socketPath);

  const app = createAgentApi(opts);
  try {
    await app.listen({ path: socketPath });
    chmodSync(socketPath, SOCKET_MODE);
  } catch (err) {
    await app.close();
    throw err;
  }
  return { app, socketPath, close: () => app.close() };
}
