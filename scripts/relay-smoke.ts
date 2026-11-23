// Live smoke check for a deployed Bellwood relay (Cloudflare staging/production or local Node relay).
import { generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { WebSocket } from "ws";
import {
  RELAY_PATHS,
  RELAY_PROTOCOL_VERSION,
  base64UrlEncode,
  encodeRelayFrame,
  isRelayToken,
  newRelayToken,
  parseRelayServerFrame,
  relayControlMessage,
  type RelayHealthResponse,
  type RelayServerFrame,
} from "../src/relay/protocol.ts";
import { parseAccountId, type AccountId } from "../src/shared/mesh.ts";

const DEFAULT_SMOKE_ACCOUNT_ID = "acct_bellwoodsmoketestaaaaaaaaa";
const DEFAULT_TIMEOUT_MS = 10_000;
const HEALTH_POLL_INTERVAL_MS = 1_000;
const WS_CLOSE_POLICY = 1008;

export interface RelaySmokeOptions {
  relayUrl: string;
  expectSha?: string;
  waitMs?: number;
  timeoutMs?: number;
  accountId?: AccountId;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface RelaySmokeReport {
  origin: string;
  health: RelayHealthResponse;
  checks: string[];
}

export type ParsedSmokeCli =
  | { kind: "help" }
  | { kind: "run"; options: { relayUrl: string; expectSha?: string; waitMs: number; timeoutMs: number } };

const USAGE = [
  "Usage: node scripts/relay-smoke.ts --url <relay-origin> [--expect-sha <sha>] [--wait-ms <ms>] [--timeout-ms <ms>]",
  "  --url         Relay base URL (or RELAY_SMOKE_URL env var)",
  "  --expect-sha  Wait until GET /health reports buildSha === <sha>",
  "  --wait-ms     Max wait for /health propagation in milliseconds (default: 0)",
  "  --timeout-ms  Per-request and WebSocket timeout in milliseconds (default: 10000)",
].join("\n");

function parseNonNegativeInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid --${name} value: ${raw}`);
  return n;
}

function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  const n = parseNonNegativeInt(raw, fallback, name);
  if (n <= 0) throw new Error(`Invalid --${name} value: ${raw}`);
  return n;
}

export function parseSmokeCliArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): ParsedSmokeCli {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      url: { type: "string" },
      "expect-sha": { type: "string" },
      "wait-ms": { type: "string" },
      "timeout-ms": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) return { kind: "help" };
  const rawUrl = (values.url ?? env.RELAY_SMOKE_URL ?? "").trim();
  if (rawUrl === "") throw new Error("Missing --url (or RELAY_SMOKE_URL)");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid --url: ${rawUrl}`);
  }
  if (!/^https?:$/.test(parsedUrl.protocol)) throw new Error(`Unsupported relay protocol: ${parsedUrl.protocol}`);
  const expectSha = values["expect-sha"]?.trim();
  return {
    kind: "run",
    options: {
      relayUrl: parsedUrl.origin,
      ...(expectSha ? { expectSha } : {}),
      waitMs: parseNonNegativeInt(values["wait-ms"], 0, "wait-ms"),
      timeoutMs: parsePositiveInt(values["timeout-ms"], DEFAULT_TIMEOUT_MS, "timeout-ms"),
    },
  };
}

function isHealthResponse(value: unknown): value is RelayHealthResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.ok === true &&
    v.service === "bellwood-relay" &&
    v.protocolVersion === RELAY_PROTOCOL_VERSION &&
    (v.buildSha === null || typeof v.buildSha === "string") &&
    (v.versionId === null || typeof v.versionId === "string") &&
    (v.deployedAt === null || typeof v.deployedAt === "string")
  );
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  return fetchImpl(url, { ...init, signal });
}

export async function waitForRelayHealth(options: {
  origin: string;
  expectSha?: string;
  waitMs: number;
  timeoutMs: number;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}): Promise<RelayHealthResponse> {
  const deadline = options.now() + options.waitMs;
  let lastProblem = "no response yet";
  for (;;) {
    try {
      const res = await fetchWithTimeout(
        options.fetch,
        `${options.origin}${RELAY_PATHS.health}`,
        { method: "GET", headers: { "cache-control": "no-store" } },
        options.timeoutMs,
      );
      if (res.status !== 200) {
        lastProblem = `GET ${RELAY_PATHS.health} returned HTTP ${res.status}`;
      } else {
        const body = (await res.json()) as unknown;
        if (!isHealthResponse(body)) {
          lastProblem = `GET ${RELAY_PATHS.health} returned unexpected payload: ${JSON.stringify(body)}`;
        } else if (options.expectSha !== undefined && body.buildSha !== options.expectSha) {
          lastProblem = `GET ${RELAY_PATHS.health} reported buildSha=${JSON.stringify(body.buildSha)} (versionId=${JSON.stringify(body.versionId)}), expected ${options.expectSha}`;
        } else {
          return body;
        }
      }
    } catch (error) {
      lastProblem = `GET ${RELAY_PATHS.health} failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    const remaining = deadline - options.now();
    if (remaining <= 0) throw new Error(lastProblem);
    await options.sleep(Math.min(HEALTH_POLL_INTERVAL_MS, remaining));
  }
}

async function expectJsonError(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  expectedStatus: number,
  expectedError: string,
  timeoutMs: number,
): Promise<void> {
  const res = await fetchWithTimeout(fetchImpl, url, init, timeoutMs);
  if (res.status !== expectedStatus) {
    throw new Error(`${init.method ?? "GET"} ${url} returned HTTP ${res.status}, expected ${expectedStatus}`);
  }
  const body = (await res.json()) as { error?: unknown };
  if (body.error !== expectedError) {
    throw new Error(`${init.method ?? "GET"} ${url} returned error=${JSON.stringify(body.error)}, expected ${expectedError}`);
  }
}

function wsOriginOf(origin: string): string {
  return origin.replace(/^http/, "ws");
}

function withWebSocketTimeout(
  ws: WebSocket,
  label: string,
  timeoutMs: number,
  attach: (finish: (err?: Error) => void) => void,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.terminate();
      rejectPromise(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        ws.terminate();
        rejectPromise(err);
      } else {
        resolvePromise();
      }
    };

    ws.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
    attach(finish);
  });
}

function checkControlHandshake(origin: string, accountId: AccountId, timeoutMs: number): Promise<void> {
  const ws = new WebSocket(`${wsOriginOf(origin)}${RELAY_PATHS.control(accountId)}`, {
    perMessageDeflate: false,
    handshakeTimeout: timeoutMs,
  });
  const device = randomUUID() as `${string}-${string}-${string}-${string}-${string}`;
  const { privateKey } = generateKeyPairSync("ed25519");
  let sawUnknownDevice = false;

  return withWebSocketTimeout(ws, "Control WebSocket smoke", timeoutMs, (finish) => {
    ws.on("message", (data, isBinary) => {
      if (isBinary) return finish(new Error("Control WebSocket returned unexpected binary frame"));
      const frame: RelayServerFrame | null = parseRelayServerFrame(data.toString("utf8"));
      if (frame === null) return finish(new Error("Control WebSocket returned unparseable frame"));
      if (frame.type === "challenge") {
        if (!isRelayToken(frame.nonce)) return finish(new Error("Control challenge nonce is malformed"));
        const payload = relayControlMessage({ relayOrigin: origin, accountId, device, nonce: frame.nonce });
        const signature = base64UrlEncode(cryptoSign(null, payload, privateKey));
        ws.send(encodeRelayFrame({ type: "hello", device, version: RELAY_PROTOCOL_VERSION, signature }));
        return;
      }
      if (frame.type === "error" && frame.code === "unknown_device") {
        sawUnknownDevice = true;
        return;
      }
      finish(new Error(`Unexpected control frame during smoke: ${JSON.stringify(frame)}`));
    });
    ws.once("close", (code, reason) => {
      if (!sawUnknownDevice) {
        return finish(new Error(`Control WebSocket closed (${code} ${reason.toString("utf8")}) before unknown_device error`));
      }
      if (code !== WS_CLOSE_POLICY) {
        return finish(new Error(`Control WebSocket closed with code ${code}, expected ${WS_CLOSE_POLICY}`));
      }
      finish();
    });
  });
}

function checkChannelUpgrade(origin: string, accountId: AccountId, timeoutMs: number): Promise<void> {
  const channel = newRelayToken();
  const device = randomUUID();
  const session = newRelayToken();
  const url = `${wsOriginOf(origin)}${RELAY_PATHS.channel(accountId, channel)}?device=${device}&session=${session}`;
  const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: timeoutMs });

  return withWebSocketTimeout(ws, "Channel WebSocket smoke", timeoutMs, (finish) => {
    ws.once("unexpected-response", (req, res) => {
      req.destroy();
      if (res.statusCode === 401) {
        finish();
        return;
      }
      finish(new Error(`Channel WebSocket returned unexpected HTTP ${res.statusCode}`));
    });
    ws.once("close", (code) => {
      if (code !== WS_CLOSE_POLICY) {
        return finish(new Error(`Channel WebSocket closed with code ${code}, expected ${WS_CLOSE_POLICY}`));
      }
      finish();
    });
  });
}

export async function runRelaySmoke(options: RelaySmokeOptions): Promise<RelaySmokeReport> {
  const origin = new URL(options.relayUrl).origin;
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms) => delay(ms).then(() => undefined));
  const now = options.now ?? Date.now;
  const waitMs = options.waitMs ?? 0;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const accountId = options.accountId ?? parseAccountId(DEFAULT_SMOKE_ACCOUNT_ID)!;

  const checks: string[] = [];
  const health = await waitForRelayHealth({
    origin,
    ...(options.expectSha ? { expectSha: options.expectSha } : {}),
    waitMs,
    timeoutMs,
    fetch: fetchImpl,
    sleep,
    now,
  });
  checks.push(`GET ${RELAY_PATHS.health} -> 200 (protocolVersion=${health.protocolVersion}, buildSha=${health.buildSha ?? "null"})`);

  const headRes = await fetchWithTimeout(fetchImpl, `${origin}${RELAY_PATHS.health}`, { method: "HEAD", headers: { "cache-control": "no-store" } }, timeoutMs);
  if (headRes.status !== 200) throw new Error(`HEAD ${RELAY_PATHS.health} returned HTTP ${headRes.status}, expected 200`);
  checks.push(`HEAD ${RELAY_PATHS.health} -> 200`);

  await expectJsonError(fetchImpl, `${origin}/v1/nope`, { method: "GET" }, 404, "not_found", timeoutMs);
  checks.push("GET /v1/nope -> 404 not_found");

  await expectJsonError(fetchImpl, `${origin}${RELAY_PATHS.control(accountId)}`, { method: "GET" }, 426, "upgrade_required", timeoutMs);
  checks.push("GET control without Upgrade -> 426 upgrade_required");

  await expectJsonError(
    fetchImpl,
    `${origin}${RELAY_PATHS.register}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    400,
    "bad_frame",
    timeoutMs,
  );
  checks.push("POST /v1/register {} -> 400 bad_frame");

  await checkControlHandshake(origin, accountId, timeoutMs);
  checks.push("WSS control -> challenge -> signed hello -> unknown_device (1008)");

  await checkChannelUpgrade(origin, accountId, timeoutMs);
  checks.push("WSS channel -> unauthorized (1008)");

  return { origin, health, checks };
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseSmokeCliArgs(argv);
  if (parsed.kind === "help") {
    console.log(USAGE);
    return 0;
  }
  const report = await runRelaySmoke(parsed.options);
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`relay-smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
