import { answerCodexAppApproval, parseCodexAppApprovalRequest } from "./app-approval.ts";
import { asObject, type CodexDriverHost, type Proc, type SessionState } from "./driver-state.ts";
import {
  buildJsonRpcResponse,
  decideCommandApproval,
  decideFileChangeApproval,
  decideMcpElicitation,
  extractFileChangePaths,
} from "./protocol.ts";

export function answerServerRequest(
  host: CodexDriverHost,
  st: SessionState,
  proc: Proc,
  id: number | string,
  method: string,
  rawParams: unknown,
): void {
  const params = asObject(rawParams) ?? {};
  const row = host.row(st);
  const context = {
    readonly: proc.readonly,
    writeScope: proc.writeScope,
    cwd: row?.cwd ?? proc.launched.cwd,
  };

  switch (method) {
    case "item/commandExecution/requestApproval": {
      const decision = decideCommandApproval(params, context);
      proc.child.stdin.write(buildJsonRpcResponse(id, { decision }) + "\n");
      return;
    }
    case "item/fileChange/requestApproval": {
      const itemId = typeof params.itemId === "string" ? params.itemId : "";
      const decision = decideFileChangeApproval(
        { ...params, paths: [...extractFileChangePaths(params), ...(proc.fileChangePaths.get(itemId) ?? [])] },
        context,
      );
      proc.child.stdin.write(buildJsonRpcResponse(id, { decision }) + "\n");
      return;
    }
    case "mcpServer/elicitation/request": {
      const approval = proc.appApprovals;
      if (approval !== null && proc.threadId !== null && params.threadId === proc.threadId) {
        const { state, gate, computerUseServers } = approval;
        const request = parseCodexAppApprovalRequest(params, {
          sessionId: st.id, requestId: id, processKey: state.processKey, computerUseServers,
        });
        if (request !== null) {
          void answerCodexAppApproval({ gate, state, request, requestId: id, write: (line) => {
            if (!proc.child.stdin.destroyed) proc.child.stdin.write(line + "\n");
          } }).catch((error: unknown) => host.log(`App approval response failed: ${String(error)}`));
          return;
        }
      }
      const answer = decideMcpElicitation(params, {
        readonly: proc.readonly,
        policy: proc.launchConfig.readonlyPolicy,
      });
      proc.child.stdin.write(buildJsonRpcResponse(id, answer) + "\n");
      return;
    }
    case "item/tool/requestUserInput": {
      proc.child.stdin.write(buildJsonRpcResponse(id, { answers: {} }) + "\n");
      return;
    }
    default: {
      proc.child.stdin.write(buildJsonRpcResponse(id, { decision: "decline" }) + "\n");
      return;
    }
  }
}
