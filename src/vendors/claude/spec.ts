import { PRODUCT_NAME, PRODUCT_PLUGIN_NAME } from "../../shared/names.ts";
import { blockedCommands, capitalize, defineVendor } from "../types.ts";

const SESSION_BLOCKED = `会话由 ${PRODUCT_NAME} 管，这里不能用这个命令；项目经理要开新会话，请用资料页的“开新会话”按钮`;
const MODEL_BLOCKED = "换模型、思考程度请在资料页改（Worker 的由项目经理派活时定）";
const SETTINGS_BLOCKED = "这个命令会改 claude 自己的设置，这里不能用；要改请在终端里打开 claude";
const ACCOUNT_BLOCKED = "账号相关的命令这里不能用，请在终端里打开 claude";
const TERMINAL_BLOCKED = "这个命令只能在终端界面里用";

export default defineVendor({
  id: "claude",
  label: "Claude Code",
  cli: {
    command: "claude",
    envVar: "AGENT_HUB_CLAUDE",
    loginCommand: "claude auth login",
  },
  home: {
    dirs: [".claude", ".claude.json"],
    readonlySecrets: [".claude.json", ".claude/.credentials.json"],
    catalogWatchPaths: [".claude/.credentials.json", ".claude/settings.json"],
    catalogProbeStatePaths: [".claude.json"],
  },
  models: {
    bundled: [
      { id: "fable", label: "Fable" },
      { id: "opus", label: "Opus" },
      { id: "sonnet", label: "Sonnet" },
      { id: "haiku", label: "Haiku" },
    ],
    customModel: true,
    customModelExample: "claude-opus-5-5",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    effortLabels: { low: "Low", medium: "Medium", high: "High", xhigh: "Extra", max: "Max" },
    routerDefault: { model: "haiku", effort: "low" },
    flags: { model: "--model", effort: "--effort" },
    shortName: (model) => {
      const m =
        /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-(?:\d{8}|latest))?(?:\[(\d+[mk])\])?$/i.exec(model) ??
        /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-(?:\d{8}|latest))?(?:\[(\d+[mk])\])?$/i.exec(model);
      if (!m) return null;
      const isFamilyFirst = /^[a-z]+$/i.test(m[1]!);
      const family = capitalize((isFamilyFirst ? m[1]! : m[3]!).toLowerCase());
      const major = isFamilyFirst ? m[2]! : m[1]!;
      const minor = isFamilyFirst ? m[3] : m[2];
      const ctx = m[4] ? m[4].toUpperCase() : null;
      return [family, minor === undefined ? major : `${major}.${minor}`, ctx].filter(Boolean).join(" ");
    },
  },
  quota: { name: "Claude", windows: ["five_hour", "seven_day"], warningStatus: "allowed_warning" },
  composer: {
    commandPrefix: "/",
    compactCommand: "compact",
    blockedCommands: {
      // /clear switches the session ID, but we keep resuming the old one.
      ...blockedCommands(SESSION_BLOCKED, ["clear", "reset", "new", "resume", "exit", "quit", "rename", "name"]),
      ...blockedCommands(MODEL_BLOCKED, ["model", "effort", "fast", "advisor"]),
      ...blockedCommands(SETTINGS_BLOCKED, [
        "config",
        "settings",
        "output-style",
        "autocompact",
        "mcp",
        "agents",
        "auto-mode-setup",
        "import",
        "debug",
        "goal",
        "__remote-workflow",
        "workflow-launch-exec",
      ]),
      ...blockedCommands(ACCOUNT_BLOCKED, ["login", "logout", "usage-credits", "extra-usage", "design", "design-consent", "design-revoke"]),
      ...blockedCommands(TERMINAL_BLOCKED, ["doctor", "checkup", "color", "focus", "reload-plugins", "heapdump"]),
    },
  },
  prompt: {
    subagentTools: ["Agent", "Task"],
    backgroundCommandTool: "Bash 工具的 `run_in_background`",
    // With both files present, claude reads only CLAUDE.md.
    instructionFile: "CLAUDE.md",
    vendorOnlyTools: "claude 的后台任务",
    skillNamePrefix: `${PRODUCT_PLUGIN_NAME}:`,
  },
  failure: {
    serviceName: "Claude",
    rawHint: /^claude_not_found\b|\bclaude\b|anthropic/i,
  },
  tools: {
    actions: {
      Bash: "command",
      bash: "command",
      Read: "read",
      Edit: "edit",
      MultiEdit: "edit",
      NotebookEdit: "edit",
      Write: "write",
      Skill: "skill",
      Grep: "search",
      Glob: "search",
      WebSearch: "web_search",
      WebFetch: "web_fetch",
      Agent: "subagent",
      Task: "subagent",
      TodoWrite: "todo",
      TaskCreate: "todo",
      TaskUpdate: "todo",
      TaskList: "todo_read",
      TaskGet: "todo_read",
      ToolSearch: "tool_search",
    },
  },
  // Print mode hides the checklist tools unless this switch is set (claude 2.1.330).
  checklist: { sources: ["todo_tool"], enable: { env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" } }, promptTool: "`TaskCreate` / `TaskUpdate`" },
  skillSignals: {
    // Read output lines are 'N\t<text>'.
    outputField: "content",
    outputLinePrefix: /^\s*\d+\t/u,
    toolNameKeys: ["skill"],
  },
  capabilities: {
    builtInSandbox: {
      platforms: ["darwin", "linux"],
      computerUseCapabilities: [],
    },
    // A finished run_in_background command pushes task_notification and wakes the agent.
    backgroundWake: true,
    readonly: "settings",
    systemPrompt: "resident",
    skills: "native",
    isolation: { skill: "session", mcp: "session", connector: "session" },
    // skillOverrides cannot disable plugin skills; deny the Skill call instead (claude 2.1.326).
    pluginIsolation: { skill: "tool_deny" },
  },
});
