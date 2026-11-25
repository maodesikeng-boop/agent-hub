import { PRODUCT_NAME } from "../../shared/names.ts";
import { blockedCommands, capitalize, defineVendor } from "../types.ts";

const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
const MAX_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

const SESSION_BLOCKED = `会话由 ${PRODUCT_NAME} 管，这里不能用这个命令；项目经理要开新会话，请点右上角“开新会话”按钮`;
const MODEL_BLOCKED = "换模型、思考程度请在资料页改（Worker 的由项目经理派活时定）";
const ACCOUNT_BLOCKED = "账号相关的命令这里不能用，请在终端里打开 codex";
const SANDBOX_BLOCKED = `权限和沙箱由 ${PRODUCT_NAME} 管，这里不能用这个命令`;

export default defineVendor({
  id: "codex",
  label: "Codex",
  cli: {
    command: "codex",
    envVar: "AGENT_HUB_CODEX",
    loginCommand: "codex login",
  },
  home: {
    dirs: [".codex"],
    readonlySecrets: [".codex/auth.json", ".codex/.credentials.json"],
    catalogWatchPaths: [".codex/models_cache.json", ".codex/auth.json", ".codex/.credentials.json", ".codex/config.toml", ".codex/version.json"],
    configHome: { rel: ".codex", env: "CODEX_HOME" },
  },
  models: {
    bundled: [
      { id: "gpt-6.1-sol", label: "GPT-6.1-Sol", efforts: EFFORTS },
      { id: "gpt-6-astra", label: "GPT-6-Astra", efforts: EFFORTS },
      { id: "gpt-6.1-terra", label: "GPT-6.1 Terra", efforts: EFFORTS },
      { id: "gpt-6-sol", label: "GPT-6-Sol", efforts: EFFORTS },
      { id: "gpt-6-luna", label: "GPT-6-Luna", efforts: MAX_EFFORTS },
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", efforts: EFFORTS },
      { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", efforts: EFFORTS },
      { id: "gpt-5.6-luna", label: "GPT-5.6-Luna", efforts: MAX_EFFORTS },
    ],
    customModel: true,
    customModelExample: "如 gpt-6.1-sol",
    efforts: EFFORTS,
    effortLabels: { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" },
    routerDefault: { model: "gpt-6-luna", effort: "low" },
    flags: { model: "--model", effort: "-c" },
    shortName: (model) => {
      const gpt = /^gpt-(\d+(?:\.\d+)?)(?:-([a-z0-9]+(?:-[a-z0-9]+)*))?$/i.exec(model);
      if (!gpt) return null;
      return gpt[2] === undefined
        ? `GPT-${gpt[1]}`
        : `GPT-${gpt[1]} ${gpt[2].split("-").map((w) => capitalize(w.toLowerCase())).join(" ")}`;
    },
  },
  // account/rateLimits/updated has window lengths but no names, and codex never reports a warning status.
  quota: { name: "Codex", windows: ["five_hour", "seven_day", "thirty_day"] },
  composer: {
    commandPrefix: "/",
    compactCommand: "compact",
    blockedCommands: {
      ...blockedCommands(SESSION_BLOCKED, ["clear", "new", "resume", "fork", "quit", "exit"]),
      ...blockedCommands(ACCOUNT_BLOCKED, ["login", "logout"]),
      ...blockedCommands(MODEL_BLOCKED, ["model"]),
      ...blockedCommands(SANDBOX_BLOCKED, ["approvals", "permissions", "sandbox"]),
    },
  },
  prompt: {
    instructionFile: "CLAUDE.md",
    subagentTools: ["spawn_agent"],
    backgroundCommandTool: "后台命令参数",
    vendorOnlyTools: "codex 的 apply_patch",
  },
  failure: {
    serviceName: "Codex",
    rawHint: /^codex_not_found\b|\bcodex\b|openai|chatgpt/i,
    rawHintPriority: 1,
  },
  tools: {
    actions: {
      commandExecution: "command",
      exec_command: "command",
      fileChange: "edit",
      apply_patch: "edit",
      webSearch: "web_search",
      web_search: "web_search",
      mcpToolCall: "connector",
      list_mcp_resources: "connector_resource",
      list_mcp_resource_templates: "connector_resource",
      read_mcp_resource: "connector_resource",
      // Older versions call it collabToolCall.
      collabAgentToolCall: "subagent",
      collabToolCall: "subagent",
    },
  },
  // update_plan is off by default in app-server (codex-cli 0.169.0).
  checklist: { sources: ["plan_update"], enable: { args: ["-c", "tools.update_plan.enabled=true"] } },
  skillSignals: {
    // commandExecution output is in item.aggregatedOutput.
    outputField: "aggregatedOutput",
    userTriggers: ["/", "$"],
  },
  capabilities: {
    builtInSandbox: {
      platforms: ["darwin", "linux", "win32"],
      computerUseCapabilities: ["mcp:cua_repl"],
      computerUsePlugins: ["unified-computer-use@openai-bundled", "computer-use@openai-bundled"],
    },
    // Finished background commands do not start a new turn to wake the agent.
    backgroundWake: false,
    readonly: "driver",
    explicitDefaultModel: true,
    systemPrompt: "resident",
    skills: "native",
    isolation: { skill: "session", mcp: "session", connector: "session" },
  },
});
