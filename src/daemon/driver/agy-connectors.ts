// agy 只读 Worker 的连接器清单（readonly-agy.ts 用它生成拒绝规则、做兜底检查）：
// agy 的 init 和它缓存的工具定义都不带 annotations（设计 1.2 节），所以读 agy 的 MCP 配置，自己向每个服务器问一次 tools/list 拿 readOnlyHint。
// - 配置：~/.gemini/config/mcp_config.json 的 mcpServers（stdio 有 command/args/env，远程有 url/serverUrl/httpUrl）；
//   ~/.gemini/antigravity-cli/mcp/<服务器>/ 里有缓存、但配置里找不到的服务器（插件带的）问不到，记为不可用（整个拒）；
// - 问不到清单的（起不来、超时、要 OAuth 认证）一律当不可用：只读 Worker 里拒，不放行未知的东西；
// - 不在启动路径上做重活：结果按配置内容缓存 AGY_CONNECTOR_CACHE_MS，同一时刻多个会话共用一次查询；每个服务器最多等 AGY_CONNECTOR_LIST_TIMEOUT_MS。
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGY_CONNECTOR_CACHE_MS, AGY_CONNECTOR_LIST_TIMEOUT_MS, type ConnectorToolAnnotations } from "../../shared/index.ts";
import type { AgyConnectorCatalog } from "./readonly-agy.ts";

/** MCP 服务器的启动方式（agy 的 mcp_config.json 里一项）。 */
export interface McpServerSpec {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  serverUrl?: string;
  httpUrl?: string;
  headers?: Record<string, string>;
}

export interface McpListedTool {
  name: string;
  annotations?: ConnectorToolAnnotations | null;
}

/** 向一个服务器问工具清单；失败（起不来、超时、协议错）抛错。 */
export type ListMcpTools = (name: string, spec: McpServerSpec, timeoutMs: number) => Promise<McpListedTool[]>;

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_LIST_PAGES = 20;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** tools/list 回应里的 result → 工具清单（annotations 只留 readOnlyHint、destructiveHint 两个布尔）。 */
export function parseToolsList(result: unknown): { tools: McpListedTool[]; nextCursor: string | null } {
  const r = isRecord(result) ? result : {};
  const raw = Array.isArray(r.tools) ? r.tools : [];
  const tools: McpListedTool[] = [];
  for (const t of raw) {
    if (!isRecord(t) || typeof t.name !== "string" || t.name === "") continue;
    const a = isRecord(t.annotations) ? t.annotations : null;
    const annotations: ConnectorToolAnnotations | null =
      a === null
        ? null
        : {
            ...(typeof a.readOnlyHint === "boolean" ? { readOnlyHint: a.readOnlyHint } : {}),
            ...(typeof a.destructiveHint === "boolean" ? { destructiveHint: a.destructiveHint } : {}),
          };
    tools.push({ name: t.name, annotations });
  }
  return { tools, nextCursor: typeof r.nextCursor === "string" && r.nextCursor !== "" ? r.nextCursor : null };
}

/** stdio：起进程，换行分隔的 JSON-RPC：initialize → notifications/initialized → tools/list（翻页）。 */
function listViaStdio(name: string, spec: McpServerSpec, timeoutMs: number): Promise<McpListedTool[]> {
  return new Promise((resolve, reject) => {
    if (typeof spec.command !== "string" || spec.command === "") return reject(new Error(`${name}: 没有 command`));
    const child = spawn(spec.command, spec.args ?? [], {
      cwd: homedir(),
      env: { ...process.env, ...(spec.env ?? {}) },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const tools: McpListedTool[] = [];
    let done = false;
    let nextId = 1;
    let pages = 0;
    let buffered = "";
    const finish = (error: Error | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      if (error) reject(error);
      else resolve(tools);
    };
    const timer = setTimeout(() => finish(new Error(`${name}: ${timeoutMs}ms 内没回应`)), timeoutMs);
    const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    const requestList = (cursor: string | null) => send({ id: nextId++, method: "tools/list", params: cursor === null ? {} : { cursor } });
    child.on("error", (e) => finish(e));
    child.on("exit", () => finish(new Error(`${name}: 进程退出了`)));
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      for (let nl = buffered.indexOf("\n"); nl >= 0; nl = buffered.indexOf("\n")) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isRecord(msg) || typeof msg.id !== "number") continue;
        if (isRecord(msg.error)) return finish(new Error(`${name}: ${String(msg.error.message ?? "错误")}`));
        if (msg.id === 1) {
          send({ method: "notifications/initialized" });
          requestList(null);
        } else {
          const page = parseToolsList(msg.result);
          tools.push(...page.tools);
          if (page.nextCursor === null || ++pages >= MAX_LIST_PAGES) return finish(null);
          requestList(page.nextCursor);
        }
      }
    });
    send({ id: nextId++, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "agent-hub", version: "1" } } });
  });
}

/** 取一个 JSON-RPC 回应：Content-Type 是 text/event-stream 时从 data: 行里找，否则整个 body 是 JSON。 */
async function rpcBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const msg: unknown = JSON.parse(line.slice(5));
        if (isRecord(msg) && ("result" in msg || "error" in msg)) return msg;
      } catch {
        // 不是 JSON 的 data 行跳过
      }
    }
    throw new Error("事件流里没有回应");
  }
  const msg: unknown = JSON.parse(text);
  if (!isRecord(msg)) throw new Error("回应不是 JSON 对象");
  return msg;
}

/** 远程（streamable HTTP）：initialize 拿 Mcp-Session-Id，再 tools/list（翻页）。要 OAuth 认证的服务器会 401，当不可用。 */
async function listViaHttp(name: string, spec: McpServerSpec, timeoutMs: number): Promise<McpListedTool[]> {
  const url = spec.url ?? spec.serverUrl ?? spec.httpUrl;
  if (typeof url !== "string" || url === "") throw new Error(`${name}: 没有 url`);
  const signal = AbortSignal.timeout(timeoutMs);
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...(spec.headers ?? {}) };
  const post = async (message: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...message }), signal });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const session = res.headers.get("mcp-session-id");
    if (session !== null) headers["mcp-session-id"] = session;
    const msg = await rpcBody(res);
    if (isRecord(msg.error)) throw new Error(`${name}: ${String(msg.error.message ?? "错误")}`);
    return msg;
  };
  await post({ id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "agent-hub", version: "1" } } });
  await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), signal }).catch(() => {});
  const tools: McpListedTool[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < MAX_LIST_PAGES; i++) {
    const page = parseToolsList((await post({ id: 2 + i, method: "tools/list", params: cursor === null ? {} : { cursor } })).result);
    tools.push(...page.tools);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return tools;
}

/** 默认的问法：有 command 走 stdio，有 url 走 HTTP。 */
export const listMcpTools: ListMcpTools = (name, spec, timeoutMs) =>
  typeof spec.command === "string" && spec.command !== "" ? listViaStdio(name, spec, timeoutMs) : listViaHttp(name, spec, timeoutMs);

/** agy 的 MCP 配置：{ mcpServers: { <名字>: <启动方式> } }；读不了或格式不对当空。 */
export function readAgyMcpServers(homeDir: string, readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): Record<string, McpServerSpec> {
  try {
    const parsed: unknown = JSON.parse(readFile(join(homeDir, ".gemini", "config", "mcp_config.json")));
    const servers = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
    return Object.fromEntries(Object.entries(servers).filter((e): e is [string, McpServerSpec] => isRecord(e[1])));
  } catch {
    return {};
  }
}

/** agy 缓存过工具定义的服务器名（~/.gemini/antigravity-cli/mcp/<名字>/）：配置里没有的也算知道有。 */
export function readAgyCachedMcpServerNames(homeDir: string, listDir: (path: string) => string[] = (p) => readdirSync(p)): string[] {
  try {
    return listDir(join(homeDir, ".gemini", "antigravity-cli", "mcp"));
  } catch {
    return [];
  }
}

export interface AgyConnectorResolverOptions {
  homeDir?: string;
  listTools?: ListMcpTools;
  timeoutMs?: number;
  cacheMs?: number;
  now?: () => number;
  readServers?: (homeDir: string) => Record<string, McpServerSpec>;
  cachedServerNames?: (homeDir: string) => string[];
}

/** 向所有已知的 MCP 服务器问工具清单：问不到的进 unlistable（整个拒）。不会抛错。 */
export async function buildAgyConnectorCatalog(
  servers: Record<string, McpServerSpec>,
  cachedNames: readonly string[],
  listTools: ListMcpTools,
  timeoutMs: number,
): Promise<AgyConnectorCatalog> {
  const catalog: AgyConnectorCatalog = { servers: {}, unlistable: [] };
  await Promise.all(
    Object.entries(servers).map(async ([name, spec]) => {
      try {
        const tools = await listTools(name, spec, timeoutMs);
        catalog.servers[name] = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? null]));
      } catch {
        catalog.unlistable.push(name);
      }
    }),
  );
  for (const name of cachedNames) if (!(name in servers)) catalog.unlistable.push(name);
  catalog.unlistable.sort();
  return catalog;
}

/**
 * 给驱动用的清单解析器：每次调用返回现在的清单。结果按配置内容缓存（配置变了、过期了才重新问），
 * 并发的调用共用同一次查询。
 */
export function createAgyConnectorResolver(options: AgyConnectorResolverOptions = {}): () => Promise<AgyConnectorCatalog> {
  const homeDir = options.homeDir ?? homedir();
  const listTools = options.listTools ?? listMcpTools;
  const timeoutMs = options.timeoutMs ?? AGY_CONNECTOR_LIST_TIMEOUT_MS;
  const cacheMs = options.cacheMs ?? AGY_CONNECTOR_CACHE_MS;
  const now = options.now ?? Date.now;
  const readServers = options.readServers ?? ((h) => readAgyMcpServers(h));
  const cachedNames = options.cachedServerNames ?? ((h) => readAgyCachedMcpServerNames(h));
  let cached: { key: string; at: number; value: Promise<AgyConnectorCatalog> } | null = null;
  return () => {
    const servers = readServers(homeDir);
    const names = cachedNames(homeDir);
    const key = JSON.stringify([servers, names]);
    if (cached !== null && cached.key === key && now() - cached.at < cacheMs) return cached.value;
    const value = buildAgyConnectorCatalog(servers, names, listTools, timeoutMs);
    cached = { key, at: now(), value };
    return value;
  };
}
