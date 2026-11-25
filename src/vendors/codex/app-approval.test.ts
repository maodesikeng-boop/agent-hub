import { describe, it } from "vitest";

describe("parseCodexAppApprovalRequest", () => {
  it.todo("maps a recorded Computer Use app elicitation to app id, display name, risk level, and capability mcp:cua_repl");
  it.todo("returns null when the server is not a mounted Computer Use server");
  it.todo("returns null when computerUseServers is empty because the process keeps Bellwood's outer sandbox");
  it.todo("returns null for audio recording, node_repl execution, url mode, and other connectors");
  it.todo("returns null when tool_params.app is missing or invalid");
});

describe("buildCodexAppApprovalResponse", () => {
  it.todo("answers the original JSON-RPC id with action and null content and _meta");
  it.todo("never includes a persist value");
});

describe("answerCodexAppApproval", () => {
  it.todo("writes accept after the gate allows the app");
  it.todo("writes nothing when serverRequest/resolved aborts the wait first");
  it.todo("writes nothing after the process exits");
});

describe("codex driver app approvals", () => {
  it.todo("routes Computer Use app elicitations to the gate only for vendor_only launches");
  it.todo("keeps declining every other elicitation for ordinary Workers");
  it.todo("reports processEnded with the process key when codex app-server exits");
});
