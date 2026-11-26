import { PRODUCT_NAME } from "../../shared/names.ts";
import { blockedCommands, capitalize, defineVendor } from "../types.ts";

export const AGY_CLI_HOME_REL = ".gemini/antigravity-cli";
export const AGY_LEGACY_HOME_REL = ".gemini/antigravity";
export const AGY_MCP_CONFIG_REL = ".gemini/config/mcp_config.json";

const STANDARD_EFFORTS: readonly string[] = ["low", "medium", "high"];
const EFFORTS: readonly string[] = [...STANDARD_EFFORTS, "xhigh"];

const SESSION_BLOCKED = `会话由 ${PRODUCT_NAME} 管，这里不能用这个命令；项目经理要开新会话，请点右上角“开新会话”按钮`;
const MODEL_BLOCKED = "换模型、思考程度请在资料页改（Worker 的由项目经理派活时定）";
const ACCOUNT_BLOCKED = "账号相关的命令这里不能用，请在终端里打开 agy";
const TERMINAL_BLOCKED = "交互式命令不能在后台会话跑，请在终端界面里打开 agy";

export default defineVendor({
  id: "agy",
  label: "Antigravity",
  cli: {
    command: "agy",
    envVar: "AGENT_HUB_AGY",
    loginCommand: "agy",
  },
  home: {
    dirs: [".gemini"],
    readonlySecrets: [".gemini/oauth_creds.json", ".gemini/mcp-oauth-tokens.json"],
    catalogWatchPaths: [AGY_CLI_HOME_REL, `${AGY_CLI_HOME_REL}/settings.json`, AGY_LEGACY_HOME_REL, AGY_MCP_CONFIG_REL, ".gemini/oauth_creds.json", ".gemini/mcp-oauth-tokens.json"],
  },
  models: {
    bundled: [
      { id: "gemini-4-argon", label: "Gemini 4 Argon", efforts: STANDARD_EFFORTS },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: STANDARD_EFFORTS },
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", efforts: STANDARD_EFFORTS },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", efforts: STANDARD_EFFORTS },
      { id: "gpt-oss-120b", label: "GPT-OSS 120B", efforts: ["medium"] },
    ],
    customModel: true,
    customModelExample: "如 gemini-4-argon",
    efforts: EFFORTS,
    effortLabels: { low: "Low", medium: "Medium", high: "High", xhigh: "Extra", max: "Max" },
    routerDefault: { model: "gemini-3.8-flash", effort: "low" },
    effortInModelId: true,
    flags: { model: "--model", effort: "--effort" },
    shortName: (model) => {
      const gemini = /^gemini-(\d+(?:\.\d+)?)-([a-z0-9]+(?:-[a-z0-9]+)*)$/i.exec(model);
      if (gemini) return `Gemini ${gemini[1]} ${gemini[2]!.split("-").map((w) => capitalize(w.toLowerCase())).join(" ")}`;
      const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-(?:\d{8}|latest))?(?:\[(\d+[mk])\])?$/i.exec(model);
      if (claude) {
        const ver = claude[3] === undefined ? claude[2]! : `${claude[2]}.${claude[3]}`;
        const ctx = claude[4] ? ` ${claude[4].toUpperCase()}` : "";
        return `Claude ${capitalize(claude[1]!.toLowerCase())} ${ver}${ctx}`;
      }
      const gptOss = /^gpt-oss-(\d+b)$/i.exec(model);
      if (gptOss) return `GPT-OSS ${gptOss[1]!.toUpperCase()}`;
      return null;
    },
  },
  // Quota is only available from a separate `agy -p "/usage"` run.
  quota: {
    name: "Antigravity",
    windows: ["five_hour", "seven_day"],
    fetched: {
      args: ["-p", "/usage"],
      groups: [
        { key: "gemini", name: "Gemini", match: "Gemini Models" },
        { key: "claude_gpt", name: "Claude and GPT", match: "Claude and GPT models" },
      ],
      windows: { "Five Hour Limit Remaining": "five_hour", "Weekly Limit Remaining": "seven_day" },
    },
  },
  composer: {
    commandPrefix: "/",
    compactCommand: "compact",
    blockedCommands: {
      ...blockedCommands(SESSION_BLOCKED, ["clear", "resume"]),
      ...blockedCommands(ACCOUNT_BLOCKED, ["logout", "login"]),
      ...blockedCommands(MODEL_BLOCKED, ["model", "effort", "mode"]),
      ...blockedCommands(TERMINAL_BLOCKED, ["update", "doctor", "color", "focus"]),
    },
  },
  prompt: {
    instructionFile: "CLAUDE.md",
    subagentTools: ["invoke_subagent"],
    backgroundCommandTool: "`run_command` 的 `WaitMsBeforeAsync`",
    vendorOnlyTools: "agy 的 `WaitMsBeforeAsync`",
  },
  failure: {
    serviceName: "Antigravity",
    rawHint: /^agy_not_found\b|\bagy\b|antigravity/i,
    // agy runs Claude and GPT models, so its errors often name other vendors' models.
    rawHintPriority: 2,
  },
  handover: { transcriptPortable: false },
  tools: {
    actions: {
      run_command: "command",
      read_file: "read",
      view_file: "read",
      view_file_outline: "read",
      view_code_item: "read",
      write_to_file: "write",
      write_file: "write",
      edit_file: "edit",
      replace_file_content: "edit",
      multi_replace_file_content: "edit",
      grep_search: "search",
      find_by_name: "search",
      list_dir: "search",
      search_web: "web_search",
      read_url_content: "web_fetch",
      invoke_subagent: "subagent",
      call_mcp_tool: "connector",
      list_resources: "connector_resource",
      read_resource: "connector_resource",
    },
  },
  checklist: { sources: [] },
  skillSignals: {
    outputField: "output",
    // read_file output has no body ('14 lines, 310 bytes'), so match on the Path argument.
    readByPath: { read_file: { ok: /^\d+ lines?, \d+ bytes?$/u, fromStart: { StartLine: 1, ByteOffset: 0 } } },
  },
  capabilities: {
    builtInSandbox: {
      platforms: ["darwin"],
      computerUseCapabilities: [],
    },
    // Finished background commands do not wake the agent, and results are lost once the idle process exits.
    backgroundWake: false,
    readonly: "os_sandbox",
    systemPrompt: "resident",
    // Hard links, because agy does not follow symlinked skills.
    skills: "native",
    isolation: { skill: "shared", mcp: "tool_deny", connector: "shared" },
    // agy's terminal sandbox cannot nest inside the OS sandbox.
    ownSandboxOffArgs: ["--settings", JSON.stringify({ enableTerminalSandbox: false })],
  },
});
