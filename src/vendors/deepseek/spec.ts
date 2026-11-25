import { PRODUCT_NAME } from "../../shared/names.ts";
import { blockedCommands, capitalize, defineVendor } from "../types.ts";

export const DEEPSEEK_HOME_REL = ".dsh";

// dsh reasoning_effort supports off, low, high, and max (default high, no medium).
const EFFORTS: readonly string[] = ["off", "low", "high", "max"];

const SESSION_BLOCKED = `会话由 ${PRODUCT_NAME} 管，这里不能用这个命令；项目经理要开新会话，请点右上角“开新会话”按钮`;
const MODEL_BLOCKED = "换模型、思考程度请在资料页改（Worker 的由项目经理派活时定）";
const ACCOUNT_BLOCKED = "账号相关的命令这里不能用，请在终端里打开 dsh";
const SANDBOX_BLOCKED = `权限和沙箱由 ${PRODUCT_NAME} 管，这里不能用这个命令`;

function unwrapTupleModel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[")) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[1] === "string" && parsed[1].trim() !== "") {
      return parsed[1].trim();
    }
  } catch {
  }
  return trimmed;
}

export default defineVendor({
  id: "deepseek",
  label: "DeepSeek",
  cli: {
    command: "dsh",
    envVar: "AGENT_HUB_DEEPSEEK",
    loginCommand: "dsh",
  },
  home: {
    dirs: [DEEPSEEK_HOME_REL],
    readonlySecrets: [`${DEEPSEEK_HOME_REL}/.credentials.yaml`, `${DEEPSEEK_HOME_REL}/.env`, `${DEEPSEEK_HOME_REL}/mcp.json`],
    catalogWatchPaths: [
      `${DEEPSEEK_HOME_REL}/.credentials.yaml`,
      `${DEEPSEEK_HOME_REL}/.env`,
      `${DEEPSEEK_HOME_REL}/cordis.patch.yml`,
    ],
    configHome: { rel: DEEPSEEK_HOME_REL, env: "DSH_HOME" },
  },
  models: {
    bundled: [
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", efforts: EFFORTS },
      { id: "deepseek-flash", label: "DeepSeek V4.1 Flash", efforts: EFFORTS },
    ],
    customModel: true,
    customModelExample: "如 deepseek-v4-pro",
    efforts: EFFORTS,
    effortLabels: { off: "Off", low: "Low", high: "High", max: "Max" },
    routerDefault: { model: "deepseek-flash", effort: "off" },
    shortName: (rawModel) => {
      const bare = unwrapTupleModel(rawModel);
      const withoutProvider = bare.includes("/") ? bare.slice(bare.lastIndexOf("/") + 1) : bare;
      const versioned = /^deepseek-v(\d+(?:\.\d+)?)(?:-([a-z0-9]+(?:-[a-z0-9]+)*))?$/i.exec(withoutProvider);
      if (versioned) {
        const suffix = versioned[2]
          ? ` ${versioned[2].split("-").map((w) => capitalize(w.toLowerCase())).join(" ")}`
          : "";
        return `DeepSeek V${versioned[1]}${suffix}`;
      }
      const named = /^deepseek-([a-z0-9]+(?:-[a-z0-9]+)*)$/i.exec(withoutProvider);
      if (named) {
        return `DeepSeek ${named[1]!.split("-").map((w) => capitalize(w.toLowerCase())).join(" ")}`;
      }
      return null;
    },
  },
  composer: {
    commandPrefix: "/",
    compactCommand: "compact",
    blockedCommands: {
      ...blockedCommands(SESSION_BLOCKED, ["clear", "reset", "new", "resume", "exit", "quit"]),
      ...blockedCommands(ACCOUNT_BLOCKED, ["login", "logout"]),
      ...blockedCommands(MODEL_BLOCKED, ["model", "effort"]),
      ...blockedCommands(SANDBOX_BLOCKED, ["permission", "permissions", "sandbox"]),
    },
  },
  prompt: {
    subagentTools: ["subagent", "subagent_fork"],
    backgroundCommandTool: "`bash` 工具的 `run_in_background`",
  },
  failure: {
    serviceName: "DeepSeek",
    rawHint: /^deepseek_not_found\b|\bdeepseek\b|\bdsh\b/i,
  },
  handover: { transcriptPortable: false },
  tools: {
    actions: {
      bash: "command",
      pwsh: "command",
      read: "read",
      read_image: "read",
      write: "write",
      edit: "edit",
      apply_patch: "edit",
      glob: "search",
      grep: "search",
      skill: "skill",
      subagent: "subagent",
      subagent_fork: "subagent",
      todo_write: "todo",
      web_search: "web_search",
      web_fetch: "web_fetch",
    },
  },
  checklist: { sources: ["todo_tool"] },
  skillSignals: {
    // read output lines are 'N: <text>'.
    outputField: "content",
    outputLinePrefix: /^\d+: /u,
    toolNameKeys: ["name"],
  },
  capabilities: {
    backgroundWake: false,
    readonly: "os_sandbox",
    systemPrompt: "resident",
    skills: "native",
    isolation: { skill: "session", mcp: "session", connector: "shared" },
  },
});
