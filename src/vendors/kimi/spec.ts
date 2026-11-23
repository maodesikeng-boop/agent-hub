import { PRODUCT_NAME } from "../../shared/names.ts";
import { blockedCommands, defineVendor } from "../types.ts";

export const KIMI_HOME_REL = ".kimi-code";
export const KIMI_HOME_ENV = "KIMI_CODE_HOME";

// The ACP thinking option offers "off" plus the model's supported efforts, or "on" for toggle-only models.
const EFFORTS: readonly string[] = ["off", "on", "low", "medium", "high", "xhigh", "max"];

const SESSION_BLOCKED = `会话由 ${PRODUCT_NAME} 管，这里不能用这个命令；项目经理要开新会话，请点右上角“开新会话”按钮`;
const MODEL_BLOCKED = "换模型、思考程度请在资料页改（Worker 的由项目经理派活时定）";
const ACCOUNT_BLOCKED = "账号相关的命令这里不能用，请在终端里运行 kimi login";
const SANDBOX_BLOCKED = `权限和沙箱由 ${PRODUCT_NAME} 管，这里不能用这个命令`;
const TERMINAL_BLOCKED = "交互式命令不能在后台会话跑，请在终端界面里打开 kimi";

export default defineVendor({
  id: "kimi",
  label: "Kimi Code",
  cli: {
    command: "kimi",
    envVar: "AGENT_HUB_KIMI",
    loginCommand: "kimi login",
  },
  home: {
    dirs: [KIMI_HOME_REL],
    // yolo auto-approves every tool, so read-only Workers hide every MCP source; plugins/installed.json lists plugin MCP servers.
    readonlySecrets: [
      `${KIMI_HOME_REL}/credentials`,
      `${KIMI_HOME_REL}/credentials/mcp`,
      `${KIMI_HOME_REL}/config.toml`,
      `${KIMI_HOME_REL}/mcp.json`,
      `${KIMI_HOME_REL}/plugins/installed.json`,
    ],
    catalogWatchPaths: [`${KIMI_HOME_REL}/config.toml`, `${KIMI_HOME_REL}/credentials`],
    configHome: { rel: KIMI_HOME_REL, env: KIMI_HOME_ENV },
  },
  models: {
    bundled: [{ id: "kimi-code/k3", label: "Kimi K3" }],
    customModel: true,
    customModelExample: "如 kimi-code/k3",
    efforts: EFFORTS,
    effortLabels: { off: "Off", on: "On", low: "Low", medium: "Medium", high: "High", xhigh: "Xhigh", max: "Max" },
    routerDefault: { model: "kimi-code/k3", effort: "off" },
    shortName: (model) => {
      const k = /^(?:[\w.:-]+\/)?(?:kimi-)?k(\d+(?:\.\d+)?)(-[a-z0-9-]+)?$/i.exec(model.trim());
      if (!k) return null;
      const suffix = k[2] ? ` ${k[2].slice(1).split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")}` : "";
      return `Kimi K${k[1]}${suffix}`;
    },
  },
  composer: {
    commandPrefix: "/",
    compactCommand: "compact",
    blockedCommands: {
      ...blockedCommands(SESSION_BLOCKED, ["new", "clear", "resume", "fork", "sessions", "exit", "quit"]),
      ...blockedCommands(ACCOUNT_BLOCKED, ["login", "logout"]),
      ...blockedCommands(MODEL_BLOCKED, ["model", "thinking", "plan"]),
      ...blockedCommands(SANDBOX_BLOCKED, ["yolo", "auto", "permissions"]),
      ...blockedCommands(TERMINAL_BLOCKED, ["settings", "config", "theme", "editor", "mcp-config", "plugins"]),
    },
  },
  prompt: {
    subagentTools: ["Agent"],
    backgroundCommandTool: "`Bash` 工具的 `run_in_background`",
    vendorOnlyTools: "Kimi 的 AskUserQuestion 提问与 EnterPlanMode 计划工具",
  },
  failure: {
    serviceName: "Kimi Code",
    rawHint: /^kimi_not_found\b|\bkimi\b|\bmoonshot\b/i,
  },
  handover: { transcriptPortable: false },
  tools: {
    actions: {
      Bash: "command",
      Read: "read",
      ReadMediaFile: "read",
      Write: "write",
      Edit: "edit",
      Glob: "search",
      Grep: "search",
      WebSearch: "web_search",
      FetchURL: "web_fetch",
      Agent: "subagent",
      Skill: "skill",
      SetTodoList: "todo",
    },
  },
  skillSignals: {
    outputField: "content",
    outputLinePrefix: /^\s*\d+(?:\t|[:|] ?)/u,
    toolNameKeys: ["skill", "name"],
  },
  capabilities: {
    backgroundWake: false,
    readonly: "os_sandbox",
    // Kimi ACP has no systemPrompt capability and sends no compaction updates.
    systemPrompt: "first_message",
    // Skills load only from KIMI_CODE_HOME and ~/.agents, not from a per-session directory.
    skills: "read_file",
    isolation: { skill: "shared", mcp: "shared", connector: "shared" },
  },
});
