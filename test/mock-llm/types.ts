// Invariant: domain types stay decoupled from raw HTTP/SSE wire frames.
import type { AgentVendor } from "../../src/shared/index.ts";
import type { Client, RunningDaemon } from "../e2e/harness.ts";

export type MockLlmDialect =
  | "anthropic-messages"
  | "openai-responses"
  | "openai-chat-completions"
  | "gemini-generate-content";

export interface MockLlmToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface MockLlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface MockLlmTurn {
  text?: string;
  textDeltas?: readonly string[];
  thinking?: string;
  toolCalls?: readonly MockLlmToolCall[];
  usage?: MockLlmUsage;
  httpError?: {
    status: number;
    body?: unknown;
    retryAfterSec?: number;
  };
  streamAbortAfterChunk?: number;
  waitForGate?: string;
}

export interface MockLlmScript {
  turns?: readonly MockLlmTurn[];
  defaultTurn?: MockLlmTurn;
  matchers?: readonly {
    whenLastUserContains: string;
    turn: MockLlmTurn;
  }[];
}

export interface RecordedLlmRequest {
  seq: number;
  receivedAt: number;
  method: string;
  path: string;
  dialect: MockLlmDialect | "unknown";
  headers: Readonly<Record<string, string>>;
  body: unknown;
  rawBytes: number;
  truncated: boolean;
}

export interface MockLlmServerOptions {
  script?: MockLlmScript;
  maxRecordedRequests?: number;
  maxRequestBodyBytes?: number;
}

export interface MockLlmServer {
  readonly url: string;
  readonly port: number;
  setScript(script: MockLlmScript): void;
  openGate(name: string): void;
  requests(filter?: { dialect?: MockLlmDialect }): readonly RecordedLlmRequest[];
  clearRequests(): void;
  waitForRequests(
    count: number,
    options?: { timeoutMs?: number; dialect?: MockLlmDialect },
  ): Promise<readonly RecordedLlmRequest[]>;
  close(): Promise<void>;
}

export type VendorEndpointSupport = "full" | "unsupported_protocol";

export interface ProvisionVendorInput {
  homeDir: string;
  mockBaseUrl: string;
  model?: string;
}

export interface ProvisionedVendorConfig {
  env: Readonly<Record<string, string>>;
  configFiles: readonly string[];
  model: string;
}

export interface VendorMockAdapter {
  readonly vendor: AgentVendor;
  readonly support: VendorEndpointSupport;
  readonly dialect: MockLlmDialect | null;
  readonly defaultModel: string;
  readonly reason: string;
  provision(input: ProvisionVendorInput): ProvisionedVendorConfig;
}

export interface RealCliProbeStatus {
  vendor: AgentVendor;
  support: VendorEndpointSupport;
  installed: boolean;
  executablePath: string | null;
  reason: string;
}

export interface IsolatedHomeConfig {
  rootDir: string;
  homeDir: string;
  dataDir: string;
  workDir: string;
  env: Record<string, string>;
  cleanup(): void;
}

export interface PrefixDiff {
  fromIndex: number;
  toIndex: number;
  field: "system" | "tools" | "cache_key" | "messages";
  detail: string;
  firstMessageDiffIndex?: number;
}

export interface PrefixStabilityResult {
  stable: boolean;
  dialect: MockLlmDialect | "unknown";
  checkedPairs: number;
  diffs: readonly PrefixDiff[];
}

export interface NormalizedModelContext {
  dialect: MockLlmDialect | "unknown";
  model: string | null;
  system: string;
  toolNames: readonly string[];
  messages: readonly { role: string; text: string }[];
}

export interface NormalizedDriverEvent {
  type: string;
  keys: readonly string[];
  summary: string;
}

export interface JsonSchemaTreeDiff {
  added: readonly string[];
  removed: readonly string[];
  changed: readonly string[];
}

export interface RealCliDaemonOptions {
  vendor: AgentVendor;
  script?: MockLlmScript;
  model?: string;
  persona?: string;
  executablePath?: string;
  daemonEnv?: Readonly<Record<string, string>>;
}

export interface RealCliSessionHandle {
  readonly vendor: AgentVendor;
  readonly mock: MockLlmServer;
  readonly isolated: IsolatedHomeConfig;
  readonly daemon: RunningDaemon;
  readonly client: Client;
  readonly pmId: number;
  readonly conversationId: number;
  sendAndWait(text: string, options?: { timeoutMs?: number }): Promise<{ messageId: number; replies: readonly string[] }>;
  restartDaemon(): Promise<void>;
  close(): Promise<void>;
}
