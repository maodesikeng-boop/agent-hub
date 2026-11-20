import {
  LedgerRequestError,
  hubCommandAllowed,
  type AgentRole,
  type GraphPrTarget,
  type HealthModule,
  type HubArgs,
  type HubCallContext,
  type HubCommand,
  type HubData,
  type HubResult,
  type Ledger,
  type SessionId,
} from "../../shared/index.ts";
import type { HubFileArg } from "../../shared/deliverables.ts";
import type { SentFile } from "../../shared/sent-files.ts";

export interface FakeHubCall {
  sessionId: SessionId;
  command: HubCommand;
  args: unknown;
}

export class FakeHubLedger
  implements Pick<Ledger, "hubCall" | "sessionRole" | "reportHealth" | "workerStartFolder" | "workerPrTarget" | "graphPrTargets" | "workerTranscriptTarget" | "shareHubFiles">
{
  readonly calls: FakeHubCall[] = [];
  readonly contexts: HubCallContext[] = [];
  defaultRole: AgentRole | null = "pm";
  readonly sessionRoles = new Map<SessionId, AgentRole | null>();
  startFolder: string | null = null;
  prTarget: { cwd: string; branch: string } | null = null;
  graphTargets: GraphPrTarget[] = [];
  transcriptTarget: { vendor: string; vendorSessionId: string; cwd: string } | null = null;
  readonly healthReports: [HealthModule, string | null][] = [];
  failWith: Error | null = null;
  healthFailWith: Error | null = null;

  sessionRole(sessionId: SessionId): AgentRole | null {
    return this.sessionRoles.has(sessionId) ? (this.sessionRoles.get(sessionId) ?? null) : this.defaultRole;
  }

  hubCall<C extends HubCommand>(sessionId: SessionId, command: C, args: HubArgs<C>, context: HubCallContext = {}): HubResult<C> {
    this.calls.push({ sessionId, command, args });
    this.contexts.push(context);
    if (this.failWith !== null) throw this.failWith;
    const role = this.sessionRole(sessionId);
    if (role === null || (role !== "pm" && role !== "worker")) {
      throw new LedgerRequestError("forbidden", "这个会话不是项目经理或 Worker 的会话，不能用 hub");
    }
    if (!hubCommandAllowed(role, command)) {
      throw new LedgerRequestError("forbidden", `Worker 只能用 hub status，不能用 hub ${command.replace(".", " ")}：要做的事写进汇报，交给项目经理`);
    }
    return { text: `已执行 ${command}（会话 ${sessionId}）`, data: { sessionId } as unknown as HubData<C> };
  }

  workerStartFolder(_sessionId: SessionId): string | null {
    return this.startFolder;
  }

  workerTranscriptTarget(_sessionId: SessionId, _workerId: number): { vendor: string; vendorSessionId: string; cwd: string } | null {
    return this.transcriptTarget;
  }

  workerPrTarget(_sessionId: SessionId, _workerId: number): { cwd: string; branch: string } | null {
    return this.prTarget;
  }

  graphPrTargets(_sessionId: SessionId, _graphId?: number): GraphPrTarget[] {
    return this.graphTargets;
  }

  readonly sharedFileCalls: { sessionId: SessionId; paths: string[] }[] = [];

  async shareHubFiles(sessionId: SessionId, args: readonly HubFileArg[], _signal?: AbortSignal): Promise<SentFile[]> {
    this.sharedFileCalls.push({ sessionId, paths: args.map((a) => a.path) });
    return args.map((a, i) => ({ href: a.path, path: a.path, name: `f${i}`, mime: "application/octet-stream", id: `${i}`.padStart(16, "0"), size: 0, status: "saved", mtime: 0 }));
  }

  reportHealth(module: HealthModule, error: string | null): void {
    this.healthReports.push([module, error]);
    if (this.healthFailWith !== null) throw this.healthFailWith;
  }
}
