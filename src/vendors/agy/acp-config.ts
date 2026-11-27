// Invariant: Antigravity ACP sessions always anchor primary cwd to row.cwd and pass auxiliary workspaces only via additionalDirectories.
import type { RequestPermissionRequest, SessionConfigOption } from "@agentclientprotocol/sdk/unstable";
import type {
  AgentSessionRow,
  ConnectorToolAnnotations,
  Driver,
  SessionCapabilities,
} from "../../shared/index.ts";
import type { AcpDriverOptions, AcpLaunchContext } from "../_common/acp/index.ts";

export interface AgyAcpDriverOptions extends Omit<AcpDriverOptions, "executablePath"> {
  executablePath?: string | (() => string);
  homeDir?: string;
}

export interface AgyWorkspaceHooksOptions {
  readonly: boolean;
  capabilities?: SessionCapabilities;
  platform?: NodeJS.Platform;
}

export const AGY_ACP_WRITE_TOOL_NAMES: readonly string[] = [
  "write_to_file",
  "edit_file",
  "sed_file",
  "replace_file_content",
  "multi_replace_file_content",
  "notebook_edit",
  "delete_file",
  "write_file",
  "create_file",
  "Write",
  "Edit",
  "MultiEdit",
];

/**
 * Precondition: context.files is prepared for a PM, Worker, or Router launch.
 * Postcondition: returns `agy acp` CLI flags including `--sandbox=false`, omits `--add-dir` and `--settings`,
 * and includes `--dangerously-skip-permissions` only when `context.files.readonly` is undefined.
 */
export function buildAgyAcpLaunchArgs(_context: AcpLaunchContext): string[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: launchWorkspace is an absolute path prepared by prepareAgyLaunchWorkspace.
 * Postcondition: returns a deduplicated list combining non-blank context.row.addDirs and launchWorkspace,
 * excluding context.row.cwd so primary cwd remains separate.
 */
export function buildAgyAcpAdditionalDirs(_context: AcpLaunchContext, _launchWorkspace: string): string[] {
  throw new Error("Not implemented");
}

/**
 * Precondition: options.readonly reflects whether the session is a read-only Worker.
 * Postcondition: returns an Antigravity `.agents/hooks.json` object that denies `schedule`,
 * denies MCP servers in `options.capabilities?.deny.mcp`, denies write tools and `invoke_subagent`
 * when `options.readonly` is true, and never emits a `PreToolUse` hook with `decision: "allow"`.
 */
export function buildAgyWorkspaceHooks(_options: AgyWorkspaceHooksOptions): Record<string, unknown> {
  throw new Error("Not implemented");
}

/**
 * Precondition: request is an ACP `session/request_permission` payload from `agy acp`.
 * Postcondition: returns `{ server, tool, annotations }` for `call_mcp_tool` or `mcp_<server>_<tool>` calls,
 * or `null` for non-MCP built-in tools.
 */
export function extractAgyAcpMcpTool(
  _request: RequestPermissionRequest,
): { server: string; tool: string; annotations?: ConnectorToolAnnotations | null } | null {
  throw new Error("Not implemented");
}

/**
 * Precondition: params.options are the ACP `configOptions` returned by `agy acp`.
 * Postcondition: splits legacy combined `model-effort` values (for example `gemini-3.8-flash-low`) and explicit
 * model and effort settings into ordered `session/set_config_option` updates targeting `model` and `thought_level`.
 */
export function resolveAgyAcpModelAndEffort(_params: {
  model: string | null;
  effort: string | null;
  options: readonly SessionConfigOption[];
}): Array<{ configId: string; value: string }> {
  throw new Error("Not implemented");
}

/**
 * Precondition: psArgs is a command line from the OS process table for a candidate stale PID.
 * Postcondition: returns true only for a Bellwood-launched `agy acp --sandbox=false` process matching
 * executablePath or `agy`, never matching an interactive user `agy` session.
 */
export function matchesAgyAcpStaleProcess(
  _psArgs: string,
  _row: AgentSessionRow,
  _executablePath: string,
): boolean {
  throw new Error("Not implemented");
}

/**
 * Precondition: options provide a session store and launch preparer for Antigravity sessions.
 * Postcondition: returns a Bellwood Driver backed by `createAcpDriver` running `agy acp` with primary
 * `cwd` fixed to `row.cwd`, auxiliary directories passed via `additionalDirectories`, and read-only
 * enforcement via the outer OS sandbox, ACP permission gate, and `.agents/hooks.json`.
 */
export function createAgyAcpDriver(_options: AgyAcpDriverOptions): Driver {
  throw new Error("Not implemented");
}
