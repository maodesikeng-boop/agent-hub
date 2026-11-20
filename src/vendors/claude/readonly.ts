import { connectorToolAllowed, type ConnectorToolAnnotations, type ReadonlyPolicy } from "../../shared/index.ts";

export const MCP_STATUS_TIMEOUT_MS = 5000;
export const READONLY_DENY_MESSAGE = "这次是只读 Worker：只能读、搜、查，这个工具可能会改东西，被系统拒绝了。换别的办法，或者把结论写进汇报。";

// claude rewrites server names in tool names: chars outside [A-Za-z0-9_-] become _.
export function normalizeMcpServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// Server names may contain __, so split on mcp_server when it is present.
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
    if (connectorToolAllowed(this.#policy, parts.server, parts.tool, null)) this.#reply(requestId, input, true);
    else if (!connectorToolAllowed(this.#policy, parts.server, parts.tool, { readOnlyHint: true })) this.#reply(requestId, input, false);
    else if (this.#catalog.has(toolName)) this.#reply(requestId, input, connectorToolAllowed(this.#policy, parts.server, parts.tool, this.#catalog.get(toolName)));
    else {
      this.#waiting.push({ requestId, toolName, input, ...parts });
      this.#askStatus();
    }
    return true;
  }

  onControlResponse(obj: Record<string, unknown>): boolean {
    const response = obj.response;
    if (!isRecord(response) || this.#statusRequestId === null || response.request_id !== this.#statusRequestId) return false;
    if (response.subtype === "success") for (const [name, ann] of annotationsFromMcpStatus(response.response)) this.#catalog.set(name, ann);
    this.#finishStatus();
    return true;
  }

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
