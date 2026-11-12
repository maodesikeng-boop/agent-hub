// 测试用的内存假账本：只实现 agent 接口用到的 hubCall、sessionRole、workerStartFolder、workerPrTarget 和 reportHealth，记下每次调用；可以让它们抛指定的错。
import {
  LedgerRequestError,
  hubCommandAllowed,
  type AgentRole,
  type HealthModule,
  type HubArgs,
  type HubCallContext,
  type HubCommand,
  type HubData,
  type HubResult,
  type Ledger,
  type SessionId,
} from "../../shared/index.ts";

export interface FakeHubCall {
  sessionId: SessionId;
  command: HubCommand;
  args: unknown;
}

export class FakeHubLedger implements Pick<Ledger, "hubCall" | "sessionRole" | "reportHealth" | "workerStartFolder" | "workerPrTarget" | "graphPrTargets" | "workerTranscriptTarget"> {
  readonly calls: FakeHubCall[] = [];
  /** 每次 hubCall 收到的 context（和 calls 一一对应）。 */
  readonly contexts: HubCallContext[] = [];
  /** 各会话的角色；没单设的默认按 defaultRole（"pm"）算，设为 null 表示会话不存在。 */
  defaultRole: AgentRole | null = "pm";
  readonly sessionRoles = new Map<SessionId, AgentRole | null>();
  /** workerStartFolder 返回什么；默认 null（没有项目，agent 接口不探 git）。 */
  startFolder: string | null = null;
  /** workerPrTarget 返回什么；默认 null（不查 PR）。 */
  prTarget: { cwd: string; branch: string } | null = null;
  /** graphPrTargets 返回什么；默认空数组（不查 PR）。 */
  graphTargets: Array<{ cwd: string; branch: string }> = [];
  /** workerTranscriptTarget 返回什么；默认 null（找不到原始记录）。 */
  transcriptTarget: { vendor: string; vendorSessionId: string; cwd: string } | null = null;
  readonly healthReports: [HealthModule, string | null][] = [];
  /** 下一次（以及之后每次）调用抛它；null 表示正常返回。 */
  failWith: Error | null = null;
  /** reportHealth 记下之后抛它；null 表示不抛。 */
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
    // 假账本不关心 data 的具体形状，测试只看 text 和账本收到了什么。
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

  graphPrTargets(_sessionId: SessionId, _graphId?: number): { cwd: string; branch: string }[] {
    return this.graphTargets;
  }

  reportHealth(module: HealthModule, error: string | null): void {
    this.healthReports.push([module, error]);
    if (this.healthFailWith !== null) throw this.healthFailWith;
  }
}
