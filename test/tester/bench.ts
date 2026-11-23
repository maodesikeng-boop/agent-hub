// The resident test bench: its config file, the production guards, and clients for the two test computers.
// Invariant: no client is handed out until assertNotProduction passed for the loaded config and every instance answered
// with the test account and the test bot. The local computer reaches the remote one only through the mesh proxy
// (/d/<deviceId>/api/...), the same path a user's browser takes.
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { Message, StateSnapshot } from "../../src/shared/index.ts";
import { createInstanceClient, type ApiClient } from "./instance-client.ts";
import { createLocalInstance } from "./local-instance.ts";
import { createRemoteControl, type RemoteControl } from "./remote.ts";
import { TESTER_REMOTE_COMMAND_TIMEOUT_MS } from "./limits.ts";

/** Default bench root on the developer machine; BELLWOOD_TESTER_HOME overrides it. */
export const TESTER_HOME_ENV = "BELLWOOD_TESTER_HOME";
export const TESTER_HOME_DIR_NAME = ".bellwood-tester";
export const BENCH_CONFIG_FILE = "bench.json";

export interface LocalInstanceConfig {
  name: string;
  role: "local";
  /** AGENT_HUB_HOME of the local test daemon, under the bench root. */
  dataDir: string;
  /** HOME the local test daemon and its vendor CLIs see, so vendor config sync never touches the developer's own CLI config. */
  userHome: string;
  uiPort: number;
  meshPort: number;
  /** Env entries passed to the daemon, such as CODEX_HOME. A value `@secrets/<name>` is read from <root>/secrets/<name>. */
  env: Record<string, string>;
}

export interface RemoteInstanceConfig {
  name: string;
  role: "remote";
  deviceId: string;
  /** ssh alias whose key is restricted to the remote forced command; absent when the bench has no remote control. */
  sshAlias?: string;
}

export type InstanceConfig = LocalInstanceConfig | RemoteInstanceConfig;

/** Identifiers of the developer's real setup that the tester must never touch. Kept in bench.json, never in the repository. */
export interface ProductionGuards {
  dataDirs: string[];
  uiPorts: number[];
  meshPorts: number[];
  feishuAppIds: string[];
  githubLogins: string[];
}

export interface BenchConfig {
  version: 1;
  root: string;
  instances: InstanceConfig[];
  testAccount: { githubLogin: string };
  feishu?: { botAppId: string; driverAppId: string };
  /** Small git repository each test computer uses as its project's main folder. */
  sandboxProject: string;
  guards: ProductionGuards;
}

export class BenchConfigError extends Error {}
export class ProductionGuardError extends Error {}

/** Postcondition: the bench root from TESTER_HOME_ENV, else <home>/TESTER_HOME_DIR_NAME. */
export function benchRoot(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const override = env[TESTER_HOME_ENV]?.trim();
  return override ? resolve(override) : join(home, TESTER_HOME_DIR_NAME);
}

const port = z.number().int().min(1).max(65_535);
const nonEmpty = z.string().min(1);
const localSchema = z
  .object({ name: nonEmpty, role: z.literal("local"), dataDir: nonEmpty, userHome: nonEmpty, uiPort: port, meshPort: port, env: z.record(z.string(), z.string()) })
  .strict();
const remoteSchema = z.object({ name: nonEmpty, role: z.literal("remote"), deviceId: nonEmpty, sshAlias: nonEmpty.optional() }).strict();
const configSchema = z
  .object({
    version: z.literal(1),
    root: nonEmpty,
    instances: z
      .array(z.discriminatedUnion("role", [localSchema, remoteSchema]))
      .refine((list) => list.filter((i) => i.role === "local").length === 1, "exactly one local instance is required")
      .refine((list) => list.filter((i) => i.role === "remote").length <= 1, "at most one remote instance is allowed"),
    testAccount: z.object({ githubLogin: nonEmpty }).strict(),
    feishu: z.object({ botAppId: nonEmpty, driverAppId: nonEmpty }).strict().optional(),
    sandboxProject: nonEmpty,
    guards: z
      .object({ dataDirs: z.array(nonEmpty), uiPorts: z.array(port), meshPorts: z.array(port), feishuAppIds: z.array(nonEmpty), githubLogins: z.array(nonEmpty) })
      .strict(),
  })
  .strict();

/** Postcondition: a validated config. Throws BenchConfigError naming the first invalid field; unknown fields are errors too. */
export function parseBenchConfig(raw: unknown): BenchConfig {
  const parsed = configSchema.safeParse(raw);
  if (parsed.success) return parsed.data as BenchConfig;
  const issue = parsed.error.issues[0]!;
  const keys = issue.code === "unrecognized_keys" ? issue.keys : [];
  const path = [...issue.path, ...keys.slice(0, 1)].map(String).join(".") || "(root)";
  throw new BenchConfigError(`bench.json ${path}: ${issue.message}`);
}

/** The real path of the longest existing prefix plus the rest, lowercased, so symlinks and case cannot hide a match. */
function canonicalPath(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    rest.unshift(existing.slice(dirname(existing).length).replace(/^[\\/]/, ""));
    existing = dirname(existing);
  }
  const real = existsSync(existing) ? realpathSync.native(existing) : existing;
  return join(real, ...rest).toLowerCase();
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[a-z]:/i.test(rel));
}

function overlaps(a: string, b: string): boolean {
  return isWithin(a, b) || isWithin(b, a);
}

/**
 * Throws ProductionGuardError when any local instance's dataDir or userHome equals or contains a guarded data dir,
 * any port is guarded, the test bot app id is guarded, the test GitHub login is guarded,
 * or any local dataDir lies outside `root`. Path comparison is case-insensitive and resolves symlinks.
 */
export function assertNotProduction(config: BenchConfig): void {
  const guarded = config.guards.dataDirs.map(canonicalPath);
  const root = canonicalPath(config.root);
  const ports = new Set([...config.guards.uiPorts, ...config.guards.meshPorts]);
  for (const instance of config.instances) {
    if (instance.role !== "local") continue;
    for (const [field, value] of [["dataDir", instance.dataDir], ["userHome", instance.userHome]] as const) {
      const path = canonicalPath(value);
      const hit = guarded.find((g) => overlaps(path, g));
      if (hit !== undefined) throw new ProductionGuardError(`${instance.name}.${field} ${value} overlaps the guarded data directory ${hit}`);
    }
    if (!isWithin(canonicalPath(instance.dataDir), root)) throw new ProductionGuardError(`${instance.name}.dataDir ${instance.dataDir} is outside the bench root ${config.root}`);
    for (const [field, value] of [["uiPort", instance.uiPort], ["meshPort", instance.meshPort]] as const) {
      if (ports.has(value)) throw new ProductionGuardError(`${instance.name}.${field} ${value} is a guarded production port`);
    }
  }
  const appIds = new Set(config.guards.feishuAppIds);
  for (const id of [config.feishu?.botAppId, config.feishu?.driverAppId]) {
    if (id !== undefined && appIds.has(id)) throw new ProductionGuardError(`Feishu app ${id} is a guarded production app`);
  }
  const login = config.testAccount.githubLogin.toLowerCase();
  if (config.guards.githubLogins.some((g) => g.toLowerCase() === login)) throw new ProductionGuardError(`GitHub login ${config.testAccount.githubLogin} is a guarded production account`);
}

/** One test computer seen through its HTTP API. */
export interface InstanceClient {
  readonly name: string;
  readonly api: ApiClient;
  health(): Promise<{ ok: boolean }>;
  state(): Promise<StateSnapshot>;
  /** Postcondition: the id of the user message the daemon stored. */
  send(conversationId: number, text: string): Promise<number>;
  /** Postcondition: the first agent message after `afterMessageId`, or a rejection naming the timeout. */
  waitForReply(conversationId: number, afterMessageId: number, timeoutMs: number): Promise<Message>;
  /** Postcondition: the GitHub login (null while signed out) and device id the instance reports for its mesh account. */
  account(): Promise<{ githubLogin: string | null; deviceId: string | null }>;
}

/** Start, stop, and deploy one test computer. */
export interface InstanceControl {
  start(mode: "real" | "fake"): Promise<void>;
  stop(): Promise<void>;
  restart(mode: "real" | "fake"): Promise<void>;
  /** Precondition: `commit` is a full 40-character SHA reachable from the public repository. Postcondition: the instance runs that commit. */
  deploy(commit: string): Promise<void>;
  logs(lines: number): Promise<string>;
}

export interface LocalBenchInstance extends InstanceClient, InstanceControl {
  readonly config: LocalInstanceConfig;
  readonly mode: "real" | "fake" | null;
  /** The checkout the local instance runs. */
  readonly codeDir: string;
  /** The commit the local instance runs. */
  commit(): string;
}

export interface Bench {
  readonly config: BenchConfig;
  local(): LocalBenchInstance;
  /** Throws BenchConfigError when the bench has no remote computer. Control is present only with an ssh alias. */
  remote(): InstanceClient & Partial<RemoteControl>;
  hasRemote(): boolean;
  close(): Promise<void>;
}

/** The remote client checks the test account once before its first request, and again after a failed check. */
function guardedRemote(remote: RemoteInstanceConfig, localApi: ApiClient, expected: string): InstanceClient {
  const unguarded = createInstanceClient(remote.name, localApi.forDevice(remote.deviceId));
  let checked: Promise<void> | null = null;
  const before = (): Promise<void> =>
    (checked ??= assertTestAccount(unguarded, expected).catch((error: unknown) => {
      checked = null;
      throw error;
    }));
  return { ...createInstanceClient(remote.name, localApi.forDevice(remote.deviceId, before)), account: unguarded.account };
}

function remoteConfig(config: BenchConfig): RemoteInstanceConfig | undefined {
  return config.instances.find((i): i is RemoteInstanceConfig => i.role === "remote");
}

/** Refuses a signed-in instance whose login is not the test account; a signed-out instance cannot reach any account. */
export async function assertTestAccount(client: InstanceClient, expected: string): Promise<void> {
  const { githubLogin } = await client.account();
  if (githubLogin !== null && githubLogin.toLowerCase() !== expected.toLowerCase()) {
    throw new ProductionGuardError(`${client.name} is signed in as ${githubLogin}, not the test account ${expected}`);
  }
}

/**
 * Precondition: `config` passed assertNotProduction.
 * Postcondition: the local instance runs `codeDir` in `mode`, and both clients answered `account()` with config.testAccount.
 * Throws ProductionGuardError when an instance reports another GitHub login, and BenchConfigError when the local instance is
 * unreachable. An unreachable remote is left to preflight, and its client checks the account before its first call.
 */
export async function openBench(config: BenchConfig, options: { codeDir: string; mode: "real" | "fake" }): Promise<Bench> {
  assertNotProduction(config);
  const local = createLocalInstance(config, options.codeDir);
  try {
    await local.start(options.mode);
    await assertTestAccount(local, config.testAccount.githubLogin);
  } catch (error) {
    await local.stop();
    if (error instanceof ProductionGuardError) throw error;
    throw new BenchConfigError(`local test computer did not come up: ${error instanceof Error ? error.message : String(error)}`);
  }
  const remoteCfg = remoteConfig(config);
  const remoteClient = remoteCfg && guardedRemote(remoteCfg, local.api, config.testAccount.githubLogin);
  const control = remoteCfg?.sshAlias ? createRemoteControl({ sshAlias: remoteCfg.sshAlias, timeoutMs: TESTER_REMOTE_COMMAND_TIMEOUT_MS }) : undefined;
  return {
    config,
    local: () => local,
    remote: () => {
      if (remoteClient === undefined) throw new BenchConfigError("bench.json lists no remote instance");
      return { ...remoteClient, ...control, name: remoteClient.name, api: remoteClient.api };
    },
    hasRemote: () => remoteClient !== undefined,
    close: () => local.stop(),
  };
}
