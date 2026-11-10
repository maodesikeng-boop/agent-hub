// cursor（Cursor CLI / cursor-agent）的声明：纯数据 + 纯函数，网页、hub 命令行、守护进程都引。
// 不许 import node:*、src/daemon、别家文件夹（契约测试 S2）。
import { PRODUCT_NAME } from "../../shared/names.ts";
import { blockedCommands, capitalize, defineVendor } from "../types.ts";

/**
 * Cursor 的 ACP 会话只能选模型家族，思考程度和 Fast 由 Cursor 按家族预设（实测 set_config_option 拒收其余组合），
 * 仅保留单档以同时满足契约 S4（efforts 非空）与前端 efforts.length <= 1 自动隐藏思考程度选择器。
 */
const EFFORTS: readonly string[] = ["medium"];

const SESSION_BLOCKED = `会话由 ${PRODUCT_NAME} 管，这里不能用这个命令；项目经理要开新会话，请点右上角“开新会话”按钮`;
const MODEL_BLOCKED = "换模型请在资料页改（Worker 的由项目经理派活时定）";
const ACCOUNT_BLOCKED = "账号和用量相关的命令这里不能用，请在终端里打开 cursor-agent";
const SANDBOX_BLOCKED = `权限和沙箱由 ${PRODUCT_NAME} 管，这里不能用这个命令`;
const TERMINAL_BLOCKED = "交互式命令不能在后台会话跑，请在终端界面里打开 cursor-agent";

function shortCursorModelName(model: string): string | null {
  const bare = model.replace(/\[.*\]$/u, "").trim();
  if (bare === "" || bare === "default" || bare === "auto") return "Auto";
  const composer = /^composer-(\d+(?:\.\d+)?)(?:-(fast))?$/i.exec(bare);
  if (composer) {
    return composer[2] ? `Composer ${composer[1]} Fast` : `Composer ${composer[1]}`;
  }
  const grok = /^(?:cursor-)?grok-(\d+(?:\.\d+)?)(?:-(low|medium|high|xhigh))?(?:-(fast))?$/i.exec(bare);
  if (grok) {
    const suffix = [
      grok[2] ? (grok[2].toLowerCase() === "xhigh" ? "Extra High" : capitalize(grok[2].toLowerCase())) : null,
      grok[3] ? "Fast" : null,
    ]
      .filter(Boolean)
      .join(" ");
    return suffix ? `Grok ${grok[1]} ${suffix}` : `Grok ${grok[1]}`;
  }
  return null;
}

export default defineVendor({
  id: "cursor",
  label: "Cursor",
  cli: {
    command: "cursor-agent",
    envVar: "AGENT_HUB_CURSOR",
    loginCommand: "cursor-agent login",
  },
  // macOS 上登录凭据存于系统钥匙串，Linux 无钥匙环环境会回退到 ~/.cursor/auth.json 或 ~/.config/cursor/auth.json；
  // cli-config.json 与 agent-cli-state.json 记录本地默认模型与 CLI 状态。
  home: {
    dirs: [".cursor", ".config/cursor"],
    readonlySecrets: [".cursor/auth.json", ".config/cursor/auth.json"],
    catalogWatchPaths: [
      ".cursor/cli-config.json",
      ".cursor/agent-cli-state.json",
      ".cursor/auth.json",
      ".config/cursor/auth.json",
    ],
  },
  models: {
    // 各主流家族（ID 即 ACP 模型项的 name）；实时名单按家族归并后这几家排前面，探测不到时兜底。
    bundled: [
      { id: "composer-2.5", label: "Composer 2.5" },
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
      { id: "gpt-5.3-codex", label: "Codex 5.3" },
      { id: "gemini-4-carbon", label: "Gemini 4 Carbon" },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
      { id: "grok-4.7", label: "Grok 4.7" },
    ],
    customModel: true,
    customModelExample: "claude-opus-5-5",
    efforts: EFFORTS,
    shortName: shortCursorModelName,
  },
  composer: {
    commandPrefix: "/",
    compactCommand: "compact",
    blockedCommands: {
      ...blockedCommands(SESSION_BLOCKED, ["clear", "new", "resume", "fork", "quit", "exit"]),
      ...blockedCommands(ACCOUNT_BLOCKED, ["login", "logout", "usage"]),
      ...blockedCommands(MODEL_BLOCKED, ["model", "models", "mode", "plan", "ask"]),
      ...blockedCommands(SANDBOX_BLOCKED, ["sandbox", "permissions", "approvals"]),
      ...blockedCommands(TERMINAL_BLOCKED, ["mcp", "vim", "theme", "config", "settings", "doctor", "update"]),
    },
  },
  prompt: {
    instructionFile: "CLAUDE.md",
    subagentTools: ["Task"],
    backgroundCommandTool: "后台终端参数",
    vendorOnlyTools: "Cursor 的交互提问与计划审批工具",
  },
  failure: {
    serviceName: "Cursor",
    rawHint: /^cursor_not_found\b|\bcursor-agent\b|\bcursor\b/i,
    // Cursor 会调用 Claude、GPT、Gemini 等各家模型，报错常包含对应模型名，提高优先级先按 cursor 特征词归类。
    rawHintPriority: 2,
  },
  // Cursor 会话记录格式不透明，跨厂商换代不直接读取原始记录文件。
  handover: { transcriptPortable: false },
  tools: {
    actions: {
      Bash: "command",
      bash: "command",
      Shell: "command",
      run_command: "command",
      exec_command: "command",
      run_terminal_cmd: "command",
      execute: "command",
      Read: "read",
      read: "read",
      read_file: "read",
      Write: "write",
      write_file: "write",
      Edit: "edit",
      edit: "edit",
      edit_file: "edit",
      str_replace: "edit",
      edit_notebook: "edit",
      apply_patch: "edit",
      delete_file: "edit",
      delete: "edit",
      move: "edit",
      Grep: "search",
      Glob: "search",
      grep: "search",
      glob: "search",
      grep_search: "search",
      list_dir: "search",
      file_search: "search",
      codebase_search: "search",
      search: "search",
      WebSearch: "web_search",
      web_search: "web_search",
      search_web: "web_search",
      WebFetch: "web_fetch",
      fetch: "web_fetch",
      Task: "subagent",
      TodoWrite: "todo",
      update_todos: "todo",
    },
  },
  capabilities: {
    backgroundWake: false,
    readonly: "os_sandbox",
    // 包进外层 OS 沙箱时必须关闭 cursor-agent 自带沙箱（--sandbox disabled），避免嵌套 sandbox_apply 报 exit 71。
    ownSandboxOffArgs: ["--sandbox", "disabled"],
  },
});
