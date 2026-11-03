// agent 接口（设计第 4.2、8.1、8.2 节；m2-plan 第 3 节接口约定第 4 条）：第二个 Fastify 实例，只监听 Unix socket run/hub.sock。
// 按会话令牌认人，按 JSON Schema 查请求体的形状和长度，再交给账本的 hubCall。规格见 shared/hub.ts 的注释。
import { chmodSync, lstatSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  HUB_COMMANDS,
  HUB_ERROR_HTTP_STATUS,
  HUB_MAX_BODY_BYTES,
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
  ledger: Pick<Ledger, "hubCall">;
  tokens: SessionTokens;
  logger?: boolean;
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

function checkByteLimits(command: HubCommand, body: Record<string, unknown>): void {
  for (const [field, limit] of Object.entries(BYTE_LIMITS[command] ?? {})) {
    const value = body[field];
    if (typeof value === "string" && Buffer.byteLength(value, "utf8") > limit) {
      throw new HubError("invalid", `参数不对：${field} 不能超过 ${limit} 字节`);
    }
  }
}

function send(reply: FastifyReply, response: HubResponse): FastifyReply {
  return reply.code(response.ok ? 200 : HUB_ERROR_HTTP_STATUS[response.code]).send(response);
}

function fail(reply: FastifyReply, code: HubErrorCode, message: string): FastifyReply {
  return send(reply, { ok: false, code, message });
}

export function createAgentApi(opts: AgentApiOptions): FastifyInstance {
  const { ledger, tokens } = opts;
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: HUB_MAX_BODY_BYTES,
    // 多余参数要报错，不能悄悄删掉；类型不对也不替它转换。
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });
  const sessionOf = new WeakMap<FastifyRequest, SessionId>();

  // 先认人：令牌不对的请求不看路由、不读请求体、不调账本。
  app.addHook("onRequest", async (req, reply) => {
    const match = BEARER.exec(req.headers.authorization ?? "");
    const sessionId = match === null ? null : tokens.resolve(match[1] ?? "");
    if (sessionId === null) return fail(reply, "unauthorized", "令牌不对或已作废：这个会话不能再用 hub");
    sessionOf.set(req, sessionId);
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
    return fail(reply, "internal", err.message);
  });

  app.setNotFoundHandler((req, reply) => fail(reply, "invalid", `未知命令：${req.method} ${req.url.split("?", 1)[0]}`));

  for (const command of HUB_COMMANDS) {
    app.post(hubPath(command), { schema: { body: BODY_SCHEMAS[command] } }, async (req, reply) => {
      const sessionId = sessionOf.get(req);
      if (sessionId === undefined) throw new Error("agent-api: request reached a route without a session");
      const body = req.body as Record<string, unknown>;
      checkByteLimits(command, body);
      // 请求体的形状已经按 BODY_SCHEMAS 查过，就是这个命令的 HubArgs。
      const result = ledger.hubCall(sessionId, command, body as never);
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

/** 残留的 socket（上次没正常关）删掉；那里是别的东西就报错，不替用户删。 */
function removeStaleSocket(socketPath: string): void {
  let stat;
  try {
    stat = lstatSync(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (!stat.isSocket()) throw new Error(`agent 接口的 socket 路径上已经有别的东西，不是 socket：${socketPath}。请确认后手动移走。`);
  unlinkSync(socketPath);
}

/**
 * 建 run/（0700）、realpath、查路径长度、删残留 socket、listen、socket 改成 0600。
 * listen 和 chmod 之间 socket 短暂是 umask 给的权限，但 run/ 已经是 0700，别人进不来。
 * 守护进程有锁文件，不会有两个实例同时跑，所以 socket 文件在就是残留的。
 */
export async function startAgentApi(opts: AgentApiListenOptions): Promise<RunningAgentApi> {
  if (resolve(dirname(opts.hubSock)) !== resolve(opts.runDir)) throw new Error(`hubSock must be directly inside runDir: ${opts.hubSock}`);
  mkdirSync(opts.runDir, { recursive: true, mode: RUN_DIR_MODE });
  chmodSync(opts.runDir, RUN_DIR_MODE);
  const socketPath = join(realpathSync.native(opts.runDir), basename(opts.hubSock));
  assertSocketPathFits(socketPath);
  removeStaleSocket(socketPath);

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
