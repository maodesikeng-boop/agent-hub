import { describe, it } from "vitest";

describe("createDbTableRetention", () => {
  it.todo("purges PM conversation kind='tool' messages past PM_TOOL_MESSAGE_RETENTION_MS or above PM_TOOL_MESSAGES_MAX_PER_CONV without deleting text, ask, worker, or system messages");
  it.todo("purges terminal actions past ACTIONS_TERMINAL_RETENTION_MS or above ACTIONS_TERMINAL_MAX_ROWS while keeping pending and running actions");
  it.todo("purges hub_calls past HUB_CALLS_RETENTION_MS or above HUB_CALLS_MAX_ROWS");
  it.todo("clears consumed preamble and skills_section blobs on switched handovers and prunes old terminal handovers beyond HANDOVERS_MAX_PER_CONV while keeping the latest switched anchor");
  it.todo("prunes persona_changes beyond PERSONA_CHANGES_LIMIT per PM after clearing revert_of references");
  it.todo("trims session_steps for an ended Worker down to ENDED_WORKER_STEPS_KEEP newest rows");
  it.todo("respects maxRows per batch and reports more=true when additional rows remain");
});
