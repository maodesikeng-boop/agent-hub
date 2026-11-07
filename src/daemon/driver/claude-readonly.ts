// 只读 Worker 的 claude 驱动部分（docs/readonly-worker-design.md 第 2.3、3 节）。
// 设置文件是 default 模式、放行了内置的读/命令/上网、拒绝了编辑工具（shared/claude-readonly-settings.ts）；剩下“要批准”的工具，
// claude 带着 --permission-prompt-tool stdio 发 can_use_tool 控制请求给我们，这里回话：
// - 连接器工具（mcp__<服务器>__<工具>）：按 mcp_status 里的 annotations 和策略判断（connectorToolAllowed，三家共用的那一处）；
// - 别的（Agent、Task、Skill……）：一律拒，带中文原因，模型拿到错误继续。
// annotations 不在 can_use_tool 里，要用 mcp_status 控制请求拿。每个会话进程在内存里放一张“工具名 → annotations”表，
// 第一次有连接器工具来问批准时问一次（那时它要调的服务器已经连上，0.1–0.3 毫秒），表里查不到的工具名再问一次；进程重启表就没了。
// 启动时不去问（用户全部连接器要等 6–15 秒，设计第 3 节）。
import { connectorToolAllowed, type ConnectorToolAnnotations, type ReadonlyPolicy } from "../../shared/index.ts";

/** mcp_status 最多等多久：到点按“没有 annotations”处理（没标记的拒、手动补充的放），不让这一轮卡死。 */
export const MCP_STATUS_TIMEOUT_MS = 5000;
/** 拒绝时给模型看的原因。 */
export const READONLY_DENY_MESSAGE = "这次是只读 Worker：只能读、搜、查，这个工具可能会改东西，被系统拒绝了。换别的办法，或者把结论写进汇报。";

/** claude 把服务名变成工具名里的写法：不是字母、数字、_、- 的字符换成 _（"claude.ai Slack" → "claude_ai_Slack"）。 */
export function normalizeMcpServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** mcp__<服务器>__<工具> 拆成服务器和工具：有 mcp_server 就按它拆（服务名里可以有 __），没有就在第一个 __ 处拆；不是连接器工具返回 null。 */
export function mcpToolNameParts(toolName: string, mcpServer: string | undefined): { server: string; tool: string } | null {
  const prefix = "mcp__";
  if (!toolName.startsWith(prefix)) return null;
  const rest = toolName.slice(prefix.length);
  if (mcpServer !== undefined && mcpServer !== "") {
    const server = normalizeMcpServerName(mcpServer);
    if (rest.startsWith(`${server}__`) && rest.length > server.length + 2) return { server, tool: rest.slice(server.length + 2) };
  }
  const cut = rest.indexOf("__");
  if (cut <= 0 || cut + 2 >= rest.length) return null;
  return { server: rest.slice(0, cut), tool: rest.slice(cut + 2) };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * mcp_status 的回应（response.response，形状见设计 1.1：mcpServers[].tools[].annotations 是 {readOnly, destructive, openWorld}）→
 * “完整工具名 → 通用形状的 annotations”。没有 annotations 的工具记 null（表示问过了、没标记）；残缺的条目跳过。
 */
export function annotationsFromMcpStatus(body: unknown): Map<string, ConnectorToolAnnotations | null> {
  const table = new Map<string, ConnectorToolAnnotations | null>();
  const servers = isRecord(body) && Array.isArray(body.mcpServers) ? body.mcpServers : [];
  for (const server of servers) {
    if (!isRecord(server) || typeof server.name !== "string" || !Array.isArray(server.tools)) continue;
    const serverName = normalizeMcpServerName(server.name);
    for (const tool of server.tools) {
      if (!isRecord(tool) || typeof tool.name !== "string") continue;
      const ann = tool.annotations;
      let value: ConnectorToolAnnotations | null = null;
      if (isRecord(ann)) {
        value = {};
        if (typeof ann.readOnly === "boolean") value.readOnlyHint = ann.readOnly;
        if (typeof ann.destructive === "boolean") value.destructiveHint = ann.destructive;
      }
      table.set(`mcp__${serverName}__${tool.name}`, value);
    }
  }
  return table;
}

interface Waiting {
  requestId: string;
  toolName: string;
  input: unknown;
  server: string;
  tool: string;
}

/**
 * 一个只读 claude 进程的批准判断。write：往 claude 的标准输入写一行（不含换行）。
 * 用法：驱动在读到 control_request 时调 onControlRequest，读到 control_response 时先问 onControlResponse（是 mcp_status 的回执就返回 true），进程退出调 dispose。
 */
export class ClaudeReadonlyGate {
  readonly #policy: ReadonlyPolicy;
  readonly #write: (line: string) => void;
  #catalog = new Map<string, ConnectorToolAnnotations | null>();
  #waiting: Waiting[] = [];
  #statusRequestId: string | null = null;
  #timer: NodeJS.Timeout | null = null;
  #seq = 0;
  #disposed = false;

  constructor(policy: ReadonlyPolicy, write: (line: string) => void) {
    this.#policy = policy;
    this.#write = write;
  }

  /** can_use_tool 控制请求：回话（可能要等 mcp_status）。不是 can_use_tool、缺字段的不管，返回 false（驱动当没看见）。 */
  onControlRequest(obj: Record<string, unknown>): boolean {
    const request = obj.request;
    if (!isRecord(request) || request.subtype !== "can_use_tool") return false;
    if (typeof obj.request_id !== "string" || obj.request_id === "" || typeof request.tool_name !== "string") return false;
    const requestId = obj.request_id;
    const toolName = request.tool_name;
    const input = request.input ?? {};
    const parts = mcpToolNameParts(toolName, typeof request.mcp_server === "string" ? request.mcp_server : undefined);
    if (parts === null) {
      this.#reply(requestId, input, false);
      return true;
    }
    // 手动补充（不看 annotations 就放行）、手动排除（标了只读也拒）不用等 annotations
    if (connectorToolAllowed(this.#policy, parts.server, parts.tool, null)) this.#reply(requestId, input, true);
    else if (!connectorToolAllowed(this.#policy, parts.server, parts.tool, { readOnlyHint: true })) this.#reply(requestId, input, false);
    else if (this.#catalog.has(toolName)) this.#reply(requestId, input, connectorToolAllowed(this.#policy, parts.server, parts.tool, this.#catalog.get(toolName)));
    else {
      this.#waiting.push({ requestId, toolName, input, ...parts });
      this.#askStatus();
    }
    return true;
  }

  /** control_response：是我们发的 mcp_status 的回执就处理并返回 true；别的返回 false。回了 error 当没有 annotations。 */
  onControlResponse(obj: Record<string, unknown>): boolean {
    const response = obj.response;
    if (!isRecord(response) || this.#statusRequestId === null || response.request_id !== this.#statusRequestId) return false;
    if (response.subtype === "success") for (const [name, ann] of annotationsFromMcpStatus(response.response)) this.#catalog.set(name, ann);
    this.#finishStatus();
    return true;
  }

  /** 进程退了：没答的丢掉，计时器清掉。 */
  dispose(): void {
    this.#disposed = true;
    this.#waiting = [];
    this.#statusRequestId = null;
    this.#clearTimer();
  }

  #askStatus(): void {
    if (this.#statusRequestId !== null || this.#disposed) return;
    const requestId = `readonly-mcp-status-${++this.#seq}`;
    this.#statusRequestId = requestId;
    this.#write(JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "mcp_status" } }));
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#finishStatus();
    }, MCP_STATUS_TIMEOUT_MS);
  }

  /** mcp_status 回来了（或到点了）：等着的都答，查不到的按没有 annotations 算。 */
  #finishStatus(): void {
    this.#statusRequestId = null;
    this.#clearTimer();
    const waiting = this.#waiting;
    this.#waiting = [];
    for (const w of waiting) this.#reply(w.requestId, w.input, connectorToolAllowed(this.#policy, w.server, w.tool, this.#catalog.get(w.toolName) ?? null));
  }

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #reply(requestId: string, input: unknown, allow: boolean): void {
    if (this.#disposed) return;
    const body = allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: READONLY_DENY_MESSAGE };
    this.#write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response: body } }));
  }
}
