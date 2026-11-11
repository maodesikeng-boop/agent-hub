// agy（Antigravity）的声明：纯数据 + 纯函数，网页、hub 命令行、守护进程都引。不许 import node:*、src/daemon、别家文件夹（契约测试 S2）。
// 要拼绝对路径的（数据目录下的会话库、MCP 配置文件）和只给守护进程用的路径（PATH 里找不到时去哪找）在同目录的 paths.ts。
import { PRODUCT_NAME } from "../../shared/names.ts";
import { blockedCommands, capitalize, defineVendor } from "../types.ts";

/** agy 的数据目录、旧版数据目录、MCP 配置文件（相对用户主目录）。 */
export const AGY_CLI_HOME_REL = ".gemini/antigravity-cli";
export const AGY_LEGACY_HOME_REL = ".gemini/antigravity";
export const AGY_MCP_CONFIG_REL = ".gemini/config/mcp_config.json";

/** 思考程度：和 Antigravity 软件一样三档（实测 xhigh、max 被 agy 拒绝）。 */
const EFFORTS: readonly string[] = ["low", "medium", "high"];

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
  // 数据在 ~/.gemini（antigravity、antigravity-cli；macOS 上登录令牌在钥匙串 Library/Keychains，Linux 在钥匙环），
  // oauth_creds.json 是 gemini 系的令牌文件，mcp-oauth-tokens.json 是 MCP OAuth 令牌（gemini-cli docs/tools/mcp-server.md）
  home: {
    dirs: [".gemini"],
    readonlySecrets: [".gemini/oauth_creds.json", ".gemini/mcp-oauth-tokens.json"],
    catalogWatchPaths: [AGY_CLI_HOME_REL, AGY_LEGACY_HOME_REL, AGY_MCP_CONFIG_REL, ".gemini/oauth_creds.json", ".gemini/mcp-oauth-tokens.json"],
  },
  models: {
    // 2026-11-06 `agy models` 的实际内容去掉档位后的样子（docs/model-catalog.md）；拿不到名单时兜底
    bundled: [
      { id: "gemini-4-argon", label: "Gemini 4 Argon", efforts: EFFORTS },
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: EFFORTS },
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", efforts: EFFORTS },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", efforts: EFFORTS },
      { id: "gpt-oss-120b", label: "GPT-OSS 120B", efforts: ["medium"] },
    ],
    customModel: true,
    customModelExample: "如 gemini-4-argon",
    efforts: EFFORTS,
    routerDefault: { model: "gemini-3.8-flash", effort: "low" },
    effortInModelId: true,
    flags: { model: "--model", effort: "--effort" },
    // 不带档位的模型名（档位另外显示）：gemini-4-argon、gemini-3.8-flash、claude-opus-5-5、gpt-oss-120b → Gemini 4 Argon、Gemini 3.8 Flash、Claude Opus 5.5、GPT-OSS 120B
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
  // 事件流（stream-json）里没有额度，只有另起进程跑 `agy -p "/usage"` 才拿得到（分“Gemini”“Claude and GPT”两组）：
  // 只在用户打开额度面板时问一次、结果缓存（FETCHED_QUOTA_FRESH_MS），不在后台轮询
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
    // 保留迁移前公共提示词的触发条件：CLAUDE.md 与 AGENTS.md 并存时提醒。
    instructionFile: "CLAUDE.md",
    subagentTools: ["invoke_subagent"],
    backgroundCommandTool: "`run_command` 的 `WaitMsBeforeAsync`",
    vendorOnlyTools: "agy 的 `WaitMsBeforeAsync`",
  },
  failure: {
    serviceName: "Antigravity",
    rawHint: /^agy_not_found\b|\bagy\b|antigravity/i,
    // agy 跑 claude、gpt 的模型，报错里常带别家的模型名：先认 agy
    rawHintPriority: 2,
  },
  // 会话记录是 sqlite 库（conversations/<id>.db），别家读不了
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
      // 连接器（MCP）：参数带 ServerName / ToolName（docs/readonly-worker-design.md），状态写“Calling Linear: list issues”
      call_mcp_tool: "connector",
      list_resources: "connector_resource",
      read_resource: "connector_resource",
    },
  },
  capabilities: {
    // 后台命令跑完不会叫醒 agent，闲置关进程后结果还会丢（docs/mid-turn-messages.md 第 10.2 节）
    backgroundWake: false,
    readonly: "os_sandbox",
    // 包进 OS 沙箱时关掉自带的终端沙箱（不能嵌套）
    ownSandboxOffArgs: ["--settings", JSON.stringify({ enableTerminalSandbox: false })],
  },
});
