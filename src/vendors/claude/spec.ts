// claude（Claude Code）的声明：纯数据 + 纯函数，网页、hub 命令行、守护进程都引。不许 import node:*、src/daemon、别家文件夹（契约测试 S2）。
import { PRODUCT_NAME } from "../../shared/names.ts";
import { blockedCommands, capitalize, defineVendor } from "../types.ts";

// 隐藏命令：按“为什么拦”分组，原因是给用户看的一句（docs/composer-commands.md 的 T1、T2、T7）
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
  // 2026-11-08 核对：~/.claude.json 存账号和 MCP 登录信息，~/.claude/.credentials.json 是 claude 的令牌（macOS 上在钥匙串时没有这个文件）
  home: {
    dirs: [".claude", ".claude.json"],
    readonlySecrets: [".claude.json", ".claude/.credentials.json"],
    catalogWatchPaths: [".claude.json", ".claude/.credentials.json", ".claude/settings.json"],
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
    routerDefault: { model: "haiku", effort: "low" },
    flags: { model: "--model", effort: "--effort" },
    // claude-sonnet-5-5、claude-opus-4-1-20250805、claude-sonnet-5-5[1m]、claude-3-5-sonnet-latest → Sonnet 5.5、Opus 4.1、Sonnet 5.5 1M、Sonnet 3.5
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
      // /clear 会换会话 ID，我们 --resume 的还是旧的（T7）
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
      // system/init 的 terminal_slash_commands 标出来的四个，加上 heapdump（往桌面写文件）
      ...blockedCommands(TERMINAL_BLOCKED, ["doctor", "checkup", "color", "focus", "reload-plugins", "heapdump"]),
    },
  },
  prompt: {
    subagentTools: ["Agent", "Task"],
    backgroundCommandTool: "Bash 工具的 `run_in_background`",
    // 两个都有时 claude 只读 CLAUDE.md（M0 实测）
    instructionFile: "CLAUDE.md",
    vendorOnlyTools: "claude 的后台任务",
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
      ToolSearch: "tool_search",
    },
  },
  capabilities: {
    // Bash run_in_background 跑完推 task_notification 自动叫醒 agent（docs/mid-turn-messages.md 第 10.1 节）
    backgroundWake: true,
    readonly: "settings",
  },
});
