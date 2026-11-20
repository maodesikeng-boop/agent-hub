import { PRODUCT_NAME } from "../../shared/names.ts";
import { blockedCommands, capitalize, defineVendor } from "../types.ts";

export const OPENCODE_CONFIG_REL = ".config/opencode";
export const OPENCODE_DATA_REL = ".local/share/opencode";
export const OPENCODE_STATE_REL = ".local/state/opencode";
const OPENCODE_INSTALL_REL = ".opencode";

// OpenCode ACP exposes model variants as the effort option; "default" keeps the model's own variant.
const EFFORTS: readonly string[] = ["default", "low", "medium", "high", "max"];

const SESSION_BLOCKED = `会话由 ${PRODUCT_NAME} 管，这里不能用这个命令；项目经理要开新会话，请点右上角“开新会话”按钮`;
const MODEL_BLOCKED = "换模型、思考程度请在资料页改（Worker 的由项目经理派活时定）";
const ACCOUNT_BLOCKED = "账号相关的命令这里不能用，请在终端里运行 opencode auth login";
const TERMINAL_BLOCKED = "交互式命令不能在后台会话跑，请在终端界面里打开 opencode";

function shortOpenCodeModelName(model: string): string | null {
  const slash = model.lastIndexOf("/");
  const bare = slash >= 0 ? model.slice(slash + 1) : model;
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/i.exec(bare);
  if (claude) {
    const version = claude[3] === undefined ? claude[2]! : `${claude[2]}.${claude[3]}`;
    return `Claude ${capitalize(claude[1]!.toLowerCase())} ${version}`;
  }
  const gpt = /^gpt-(\d+(?:\.\d+)?)(?:-([a-z0-9-]+))?$/i.exec(bare);
  if (gpt) return gpt[2] === undefined ? `GPT-${gpt[1]}` : `GPT-${gpt[1]} ${gpt[2].split("-").map(capitalize).join(" ")}`;
  const kimi = /^kimi-k(\d+(?:\.\d+)?)$/i.exec(bare);
  if (kimi) return `Kimi K${kimi[1]}`;
  return slash >= 0 && bare !== "" ? bare : null;
}

export default defineVendor({
  id: "opencode",
  label: "OpenCode",
  cli: {
    command: "opencode",
    envVar: "AGENT_HUB_OPENCODE",
    loginCommand: "opencode auth login",
  },
  home: {
    dirs: [OPENCODE_CONFIG_REL, OPENCODE_DATA_REL, OPENCODE_STATE_REL, OPENCODE_INSTALL_REL],
    // V2 keeps provider accounts in opencode.db; auth.json is the V1 file it migrates from.
    readonlySecrets: [
      `${OPENCODE_DATA_REL}/auth.json`,
      `${OPENCODE_DATA_REL}/opencode.db`,
      `${OPENCODE_DATA_REL}/opencode.db-wal`,
      `${OPENCODE_DATA_REL}/mcp-auth.json`,
    ],
    catalogWatchPaths: [
      `${OPENCODE_CONFIG_REL}/opencode.json`,
      `${OPENCODE_CONFIG_REL}/opencode.jsonc`,
      `${OPENCODE_DATA_REL}/auth.json`,
    ],
  },
  models: {
    bundled: [
      { id: "opencode/claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "opencode/claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "opencode/gpt-6.2-sol", label: "GPT-6.2 Sol" },
      { id: "opencode/kimi-k3", label: "Kimi K3" },
      { id: "opencode/gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    ],
    customModel: true,
    customModelExample: "如 anthropic/claude-sonnet-5-5",
    efforts: EFFORTS,
    routerDefault: { model: "opencode/gemini-3.8-flash", effort: "default" },
    shortName: shortOpenCodeModelName,
  },
  composer: {
    commandPrefix: "/",
    compactCommand: "compact",
    blockedCommands: {
      ...blockedCommands(SESSION_BLOCKED, ["new", "clear", "sessions", "resume", "share", "unshare", "exit", "quit"]),
      ...blockedCommands(ACCOUNT_BLOCKED, ["connect", "login", "logout"]),
      ...blockedCommands(MODEL_BLOCKED, ["models", "model", "agents", "variants"]),
      ...blockedCommands(TERMINAL_BLOCKED, ["editor", "themes", "init", "undo", "redo", "mcps", "help"]),
    },
  },
  prompt: {
    subagentTools: ["subagent"],
    backgroundCommandTool: "`shell` 工具的后台参数",
    vendorOnlyTools: "OpenCode 的 question 提问工具",
  },
  failure: {
    serviceName: "OpenCode",
    rawHint: /^opencode_not_found\b|\bopencode\b/i,
    // OpenCode model IDs embed other vendors' names (opencode/claude-…, opencode/kimi-…).
    rawHintPriority: 1,
  },
  handover: { transcriptPortable: false },
  tools: {
    actions: {
      shell: "command",
      read: "read",
      write: "write",
      edit: "edit",
      patch: "edit",
      glob: "search",
      grep: "search",
      list: "search",
      skill: "skill",
      subagent: "subagent",
      webfetch: "web_fetch",
      websearch: "web_search",
      todowrite: "todo",
    },
  },
  skillSignals: {
    // ACP content blocks carry the read output as numbered lines ("N: text" or "N|text").
    outputField: "content",
    outputLinePrefix: /^\s*\d+(?:\t|[:|] ?)/u,
    toolNameKeys: ["name"],
  },
  capabilities: {
    backgroundWake: false,
    readonly: "os_sandbox",
    // OpenCode ACP has no systemPrompt capability; the driver re-injects after compaction_update.
    systemPrompt: "first_message",
    skills: "native",
    // OPENCODE_CONFIG_CONTENT can deny skill and MCP tool permissions but cannot disconnect configured servers.
    isolation: { skill: "tool_deny", mcp: "tool_deny", connector: "shared" },
  },
});
