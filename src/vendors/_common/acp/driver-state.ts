import { realpathSync } from "node:fs";
import type {
  AnyMessage,
  ClientCapabilities,
  ClientConnection,
  InitializeResponse,
  SessionConfigOption,
  SessionModeState,
} from "@agentclientprotocol/sdk/unstable";
import type { BaseBatch, BaseProc, BaseSessionState, StartupOutcome } from "../../../daemon/driver/base-driver.ts";
import type { ComposerCommand, ReadonlyPolicy, TokenUsage } from "../../../shared/index.ts";
import type { SessionDriverHost } from "../session-driver.ts";
import type { AcpDriverConfig, AcpTrackedToolCall } from "./types.ts";

export const ZERO_USAGE: TokenUsage = {
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  context: 0,
};

export function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export interface AcpBatch extends BaseBatch {
  userBlocks: Array<{ type: "text"; text: string }>;
}

export interface AcpProc extends BaseProc<StartupOutcome> {
  acpConn: ClientConnection;
  acpReadableController: ReadableStreamDefaultController<AnyMessage> | null;
  streamEnded: boolean;
  processScope: string;
  readonlyPolicy: ReadonlyPolicy | null;
  initResponse: InitializeResponse | null;
  acpSessionId: string | null;
  modes: SessionModeState | null;
  configOptions: SessionConfigOption[];
  swallowingReplay: boolean;
  pendingSystemPromptBlock: string | null;
  reinjectPromptFile: string | null;
  baseUsage: TokenUsage;
  latestContextUsed: number | null;
  turnSeq: number;
  textSegmentSeq: number;
  thinkingSeq: number;
  checklistSeq: number;
  textBuffer: string;
  textBufferBytes: number;
  textMessageId: string | null;
  inThinkingRun: boolean;
  activeTools: Map<string, AcpTrackedToolCall>;
  onPromptWritten: (() => void) | null;
}

export interface AcpSessionState extends BaseSessionState<AcpProc, AcpBatch> {
  hasConversation: boolean;
  cancelSent: boolean;
  cachedCommands: ComposerCommand[] | null;
  reinjectPending: boolean;
}

export type AcpSystemPromptInjection = NonNullable<NonNullable<AcpDriverConfig["session"]>["systemPromptInjection"]>;

export interface AcpDriverHost extends SessionDriverHost<AcpProc, AcpBatch, AcpSessionState> {
  readonly config: AcpDriverConfig;
  systemPromptInjection(): AcpSystemPromptInjection;
  clientCapabilities(): ClientCapabilities;
  reinjectAfterCompaction(st: AcpSessionState, proc: AcpProc): void;
}
