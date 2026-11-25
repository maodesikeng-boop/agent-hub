import { describe, expect, it } from "vitest";
import {
  ROUTER_COMMAND_MUTATION_KEY,
  buildPendingRouterTurns,
  pruneRouterCommandMutations,
  useRouterCommands,
  type RawRouterMutation,
  type RouterCommandVariables,
  type RouterCommandsState,
  type SendRouterCommandInput,
} from "./router-commands.ts";

describe("router-commands", () => {
  it("exposes the planned shared Router command contract", () => {
    expect(ROUTER_COMMAND_MUTATION_KEY).toEqual(["router-command"]);
    expect(typeof pruneRouterCommandMutations).toBe("function");
    expect(typeof buildPendingRouterTurns).toBe("function");
    expect(typeof useRouterCommands).toBe("function");
    type ContractTypes = [RawRouterMutation, RouterCommandVariables, RouterCommandsState, SendRouterCommandInput];
    const _typeCheck: ContractTypes | null = null;
    expect(_typeCheck).toBeNull();
  });

  it.todo("pruneRouterCommandMutations removes succeeded mutations once their clientId appears in confirmedClientIds");
  it.todo("pruneRouterCommandMutations evicts oldest non-pending mutations beyond ROUTER_STREAM_LIVE_MAX while preserving pending ones");
  it.todo("buildPendingRouterTurns omits mutations whose clientId is already present in liveTurns");
  it.todo("buildPendingRouterTurns deduplicates repeated retries for the same clientId, keeping the latest mutation state");
  it.todo("buildPendingRouterTurns turns succeeded mutations with command data into live RouterTurnEntry records");
  it.todo("buildPendingRouterTurns marks pending mutations as sending and errored mutations as send_failed with unsentError");
  it.todo("buildPendingRouterTurns returns prev by === reference when entry keys, statuses, commands, and errors are unchanged");
  it.todo("useRouterCommands dispatches POST /api/router/commands under ROUTER_COMMAND_MUTATION_KEY and returns the generated clientId");
  it.todo("useRouterCommands retries an unsent mutation after removing its failed cache entry");
  it.todo("useRouterCommands retries a failed server command via POST /api/router/commands/:id/retry and clears retry state once updatedAt advances");
});
