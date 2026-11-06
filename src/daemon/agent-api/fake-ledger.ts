// 测试用的内存假账本：只实现 agent 接口用到的 hubCall、workerStartFolder、workerPrTarget 和 reportHealth，记下每次调用；可以让它们抛指定的错。
import type { HealthModule, HubArgs, HubCallContext, HubCommand, HubData, HubResult, Ledger, SessionId } from "../../shared/index.ts";

export interface FakeHubCall {
  sessionId: SessionId;
  command: HubCommand;
  args: unknown;
}

export class FakeHubLedger implements Pick<Ledger, "hubCall" | "reportHealth" | "workerStartFolder" | "workerPrTarget" | "workerTranscriptTarget"> {
  readonly calls: FakeHubCall[] = [];
  /** 每次 hubCall 收到的 context（和 calls 一一对应）。 */
  readonly contexts: HubCallContext[] = [];
  /** workerStartFolder 返回什么；默认 null（没有项目，agent 接口不探 git）。 */
  startFolder: string | null = null;
  /** workerPrTarget 返回什么；默认 null（不查 PR）。 */
  prTarget: { cwd: string; branch: string } | null = null;
  /** workerTranscriptTarget 返回什么；默认 null（找不到原始记录）。 */
  transcriptTarget: { vendor: string; vendorSessionId: string; cwd: string } | null = null;
  readonly healthReports: [HealthModule, string | null][] = [];
  /** 下一次（以及之后每次）调用抛它；null 表示正常返回。 */
  failWith: Error | null = null;
  /** reportHealth 记下之后抛它；null 表示不抛。 */
  healthFailWith: Error | null = null;

  hubCall<C extends HubCommand>(sessionId: SessionId, command: C, args: HubArgs<C>, context: HubCallContext = {}): HubResult<C> {
    this.calls.push({ sessionId, command, args });
    this.contexts.push(context);
    if (this.failWith !== null) throw this.failWith;
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

  reportHealth(module: HealthModule, error: string | null): void {
    this.healthReports.push([module, error]);
    if (this.healthFailWith !== null) throw this.healthFailWith;
  }
}
