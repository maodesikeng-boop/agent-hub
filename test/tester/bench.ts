// The resident test bench: its config file, the production guards, and clients for the two test computers.
// Invariant: no client is handed out until assertNotProduction passed for the loaded config and every instance answered
// with the test account and the test bot. The local computer reaches the remote one only through the mesh proxy
// (/d/<deviceId>/api/...), the same path a user's browser takes.
import type { Message, StateSnapshot } from "../../src/shared/index.ts";

/** Default bench root on the developer machine; BELLWOOD_TESTER_HOME overrides it. */
export const TESTER_HOME_ENV = "BELLWOOD_TESTER_HOME";
export const TESTER_HOME_DIR_NAME = ".bellwood-tester";

export interface LocalInstanceConfig {
  name: string;
  role: "local";
  /** AGENT_HUB_HOME of the local test daemon, under the bench root. */
  dataDir: string;
  /** HOME the local test daemon and its vendor CLIs see, so vendor config sync never touches the developer's own CLI config. */
  userHome: string;
  uiPort: number;
  meshPort: number;
  /** Env entries passed to the daemon, such as CODEX_HOME. Values that are secrets name a file under <root>/secrets instead. */
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
  throw new Error("Not implemented");
}

/** Postcondition: a validated config. Throws BenchConfigError naming the first invalid field; unknown fields are errors too. */
export function parseBenchConfig(raw: unknown): BenchConfig {
  throw new Error("Not implemented");
}

/**
 * Throws ProductionGuardError when any local instance's dataDir or userHome equals or contains a guarded data dir,
 * any port is guarded, the test bot app id is guarded, the test GitHub login is guarded,
 * or any local dataDir lies outside `root`. Path comparison is case-insensitive and resolves symlinks.
 */
export function assertNotProduction(config: BenchConfig): void {
  throw new Error("Not implemented");
}

/** One test computer seen through its HTTP API. */
export interface InstanceClient {
  readonly name: string;
  health(): Promise<{ ok: boolean }>;
  state(): Promise<StateSnapshot>;
  /** Postcondition: the id of the user message the daemon stored. */
  send(conversationId: number, text: string): Promise<number>;
  /** Postcondition: the first agent message after `afterMessageId`, or a rejection naming the timeout. */
  waitForReply(conversationId: number, afterMessageId: number, timeoutMs: number): Promise<Message>;
  /** Postcondition: the GitHub login and device id the instance reports for its mesh account. */
  account(): Promise<{ githubLogin: string; deviceId: string }>;
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

export interface Bench {
  readonly config: BenchConfig;
  local(): InstanceClient & InstanceControl;
  remote(): InstanceClient & Partial<InstanceControl>;
  close(): Promise<void>;
}

/**
 * Precondition: `config` passed assertNotProduction.
 * Postcondition: the local instance runs `codeDir` in `mode`, and both clients answered `account()` with config.testAccount.
 * Throws ProductionGuardError when an instance reports another GitHub login, and BenchConfigError when an instance is unreachable.
 */
export async function openBench(config: BenchConfig, options: { codeDir: string; mode: "real" | "fake" }): Promise<Bench> {
  throw new Error("Not implemented");
}
