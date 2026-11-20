// agy init and its cached tool definitions omit annotations, so ask each MCP server for tools/list to get readOnlyHint.
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { LRUCache } from "lru-cache";
import {
  type ConnectorToolAnnotations,
  type ReadonlyPolicy,
} from "../../shared/index.ts";
import { AGY_CONNECTOR_CACHE_MS, AGY_CONNECTOR_LIST_TIMEOUT_MS, AGY_CONNECTOR_RETRY_MS } from "./limits.ts";
import { agyCliDataDir, agyDataPaths, agyHomePaths } from "./paths.ts";
import { buildChildEnv } from "../../daemon/driver/protocol.ts";
import { spawnOwnedProcess } from "../../daemon/platform/index.ts";
import { trackChild } from "../../daemon/process-ledger.ts";
import { connectorProbeSandboxInput, type AgyConnectorCatalog } from "./readonly.ts";
import type { ReadonlySandboxInput, ScopedSpawn, SpawnCommand } from "../../daemon/driver/write-scope.ts";

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

interface McpProbeLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  cleanup: () => void;
}
export type McpProbeLauncher = (base: SpawnCommand, extraEnv: Record<string, string>) => McpProbeLaunch | null;

export type ListMcpTools = (name: string, spec: McpServerSpec, timeoutMs: number, launcher?: McpProbeLauncher) => Promise<McpListedTool[]>;

const PROBE_ENV_STRIPPED_PREFIX = "HUB_";

export interface ReadonlyProbeLauncherOptions {
  policy: ReadonlyPolicy;
  homeDir: string;
  baseEnv: Record<string, string | undefined>;
  extraEnv?: Record<string, string>;
  wrap: (base: SpawnCommand, input: ReadonlySandboxInput) => ScopedSpawn;
}

export function createReadonlyProbeLauncher(options: ReadonlyProbeLauncherOptions): McpProbeLauncher {
  return (base, extraEnv) => {
    const tmpDir = mkdtempSync(join(realpathSync(tmpdir()), "agent-hub-probe-"));
    const cleanup = () => rmSync(tmpDir, { recursive: true, force: true });
    const wrapped = options.wrap(base, connectorProbeSandboxInput({ homeDir: realpathSync(options.homeDir), tmpDir, policy: options.policy }));
    if (!wrapped.osSandboxed) {
      cleanup();
      return null;
    }
    const workerEnv = buildChildEnv(options.baseEnv, options.extraEnv);
    const env = Object.fromEntries(Object.entries(workerEnv).filter(([k]) => !k.startsWith(PROBE_ENV_STRIPPED_PREFIX)));
    return {
      command: wrapped.command,
      args: wrapped.args,
      env: {
        ...env,
        TMPDIR: tmpDir,
        ...(process.platform === "win32" ? { TEMP: tmpDir, TMP: tmpDir } : {}),
        ...extraEnv,
      },
      cleanup,
    };
  };
}

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_LIST_PAGES = 20;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

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

function listViaStdio(name: string, spec: McpServerSpec, timeoutMs: number, launcher: McpProbeLauncher | undefined): Promise<McpListedTool[]> {
  return new Promise((resolve, reject) => {
    if (typeof spec.command !== "string" || spec.command === "") return reject(new Error(`${name}: 没有 command`));
    const launch = launcher?.({ command: spec.command, args: spec.args ?? [] }, spec.env ?? {}) ?? null;
    if (launch === null) return reject(new Error(`${name}: 没有 OS 沙箱，不起本地服务器探测`));
    let spawned: { child: ChildProcess; detached: boolean };
    try {
      spawned = spawnOwnedProcess(launch.command, launch.args, {
        cwd: homedir(),
        env: launch.env,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch (err) {
      return reject(err);
    }
    const child = spawned.child as ChildProcess & { stdin: NonNullable<ChildProcess["stdin"]>; stdout: NonNullable<ChildProcess["stdout"]> };
    trackChild(child, "probe:agy-mcp", { detached: spawned.detached });
    const tools: McpListedTool[] = [];
    let done = false;
    let nextId = 1;
    let pages = 0;
    let buffered = "";
    const finish = (error: Error | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); // Kill the whole process group; npx spawns children.
      } catch {
        child.kill("SIGKILL");
      }
      launch.cleanup();
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

async function rpcBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const msg: unknown = JSON.parse(line.slice(5));
        if (isRecord(msg) && ("result" in msg || "error" in msg)) return msg;
      } catch {
      }
    }
    throw new Error("事件流里没有回应");
  }
  const msg: unknown = JSON.parse(text);
  if (!isRecord(msg)) throw new Error("回应不是 JSON 对象");
  return msg;
}

// Servers that require OAuth answer 401 and count as unavailable.
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

export const listMcpTools: ListMcpTools = (name, spec, timeoutMs, launcher) =>
  typeof spec.command === "string" && spec.command !== "" ? listViaStdio(name, spec, timeoutMs, launcher) : listViaHttp(name, spec, timeoutMs);

export function readAgyMcpServers(homeDir: string, readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): Record<string, McpServerSpec> {
  try {
    const parsed: unknown = JSON.parse(readFile(agyHomePaths(homeDir).mcpConfigFile));
    const servers = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
    return Object.fromEntries(Object.entries(servers).filter((e): e is [string, McpServerSpec] => isRecord(e[1])));
  } catch {
    return {};
  }
}

export function readAgyCachedMcpServerNames(homeDir: string, listDir: (path: string) => string[] = (p) => readdirSync(p)): string[] {
  try {
    return listDir(agyDataPaths(agyCliDataDir(homeDir)).mcpCacheDir);
  } catch {
    return [];
  }
}

export interface AgyConnectorResolverOptions {
  homeDir?: string;
  listTools?: ListMcpTools;
  launcher?: McpProbeLauncher;
  timeoutMs?: number;
  cacheMs?: number;
  retryMs?: number;
  now?: () => number;
  readServers?: (homeDir: string) => Record<string, McpServerSpec>;
  cachedServerNames?: (homeDir: string) => string[];
}

export async function buildAgyConnectorCatalog(
  servers: Record<string, McpServerSpec>,
  cachedNames: readonly string[],
  listTools: ListMcpTools,
  timeoutMs: number,
  launcher?: McpProbeLauncher,
): Promise<AgyConnectorCatalog> {
  const catalog: AgyConnectorCatalog = { servers: {}, unlistable: [] };
  await Promise.all(
    Object.entries(servers).map(async ([name, spec]) => {
      try {
        const tools = await listTools(name, spec, timeoutMs, launcher);
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

export function createAgyConnectorResolver(options: AgyConnectorResolverOptions = {}): () => Promise<AgyConnectorCatalog> {
  const homeDir = options.homeDir ?? homedir();
  const listTools = options.listTools ?? listMcpTools;
  const timeoutMs = options.timeoutMs ?? AGY_CONNECTOR_LIST_TIMEOUT_MS;
  const cacheMs = options.cacheMs ?? AGY_CONNECTOR_CACHE_MS;
  const retryMs = Math.min(options.retryMs ?? AGY_CONNECTOR_RETRY_MS, cacheMs);
  const now = options.now ?? Date.now;
  const readServers = options.readServers ?? ((h) => readAgyMcpServers(h));
  const cachedNames = options.cachedServerNames ?? ((h) => readAgyCachedMcpServerNames(h));
  const cache = new LRUCache<string, { at: number; ttl: number; value: Promise<AgyConnectorCatalog> }>({ max: 1 });
  return () => {
    const servers = readServers(homeDir);
    const names = cachedNames(homeDir);
    const key = JSON.stringify([servers, names]);
    const cached = cache.get(key);
    if (cached !== undefined && now() - cached.at < cached.ttl) return cached.value;
    const value = buildAgyConnectorCatalog(servers, names, listTools, timeoutMs, options.launcher);
    const entry = { at: now(), ttl: cacheMs, value };
    cache.set(key, entry);
    void value.then(
      (catalog) => {
        if (catalog.unlistable.some((name) => Object.hasOwn(servers, name))) entry.ttl = retryMs;
      },
      () => {},
    );
    return value;
  };
}
