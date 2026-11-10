// codex 的声明：纯数据 + 纯函数，网页、hub 命令行、守护进程都引。不许 import node:*、src/daemon、别家文件夹（契约测试 S2）。
// 要拼绝对路径的（CODEX_HOME）在同目录的 paths.ts。
import { ENV_CODEX } from "../../shared/limits.ts";
import { PRODUCT_NAME } from "../../shared/names.ts";
import { blockedCommands, capitalize, defineVendor } from "../types.ts";

/** 思考程度：通用六档（luna 系到 max，其余支持到 ultra）。 */
const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
const MAX_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

const SESSION_BLOCKED = `会话由 ${PRODUCT_NAME} 管，这里不能用这个命令；项目经理要开新会话，请点右上角“开新会话”按钮`;
const MODEL_BLOCKED = "换模型、思考程度请在资料页改（Worker 的由项目经理派活时定）";
const ACCOUNT_BLOCKED = "账号相关的命令这里不能用，请在终端里打开 codex";
const SANDBOX_BLOCKED = `权限和沙箱由 ${PRODUCT_NAME} 管，这里不能用这个命令`;

/** ChatGPT.app 里带的 codex（相对 Applications 目录）：装在 /Applications 或用户目录的 ~/Applications 都要找。 */
const CHATGPT_APP_CODEX = "ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";

export default defineVendor({
  id: "codex",
  label: "Codex",
  cli: {
    command: "codex",
    envVar: ENV_CODEX,
    loginCommand: "codex login",
    // macOS 先看 ChatGPT.app 里带的（/Applications、~/Applications），别的系统看官方安装目录；最后都看插件带的
    fallbackPaths: ({ userHome, platform, linuxInstallDirs, join }) => {
      const plugin = join(userHome, ".codex", "plugins", ".plugin-appserver", "codex-cli", "bin", "codex");
      if (platform === "darwin") return [join("/Applications", CHATGPT_APP_CODEX), join(userHome, "Applications", CHATGPT_APP_CODEX), plugin];
      return [...linuxInstallDirs.map((dir) => join(dir, "codex")), plugin];
    },
  },
  // auth.json 是 codex 的令牌，.credentials.json 是 MCP OAuth 令牌的备用文件（keyring 不可用时，见 codex-rs/rmcp-client/src/oauth.rs）
  home: {
    dirs: [".codex"],
    readonlySecrets: [".codex/auth.json", ".codex/.credentials.json"],
    catalogWatchPaths: [".codex/models_cache.json", ".codex/auth.json", ".codex/.credentials.json", ".codex/config.toml", ".codex/version.json"],
    // 认证判断、模型目录指纹都跟着 CODEX_HOME 走
    configHome: { rel: ".codex", env: "CODEX_HOME" },
  },
  models: {
    // 2026-11-09 `codex app-server` model/list 的实际可见列表及各自支持的思考程度；拿不到名单时兜底
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
    flags: { model: "--model", effort: "-c" },
    shortName: (model) => {
      const gpt = /^gpt-(\d+(?:\.\d+)?)(?:-([a-z0-9]+(?:-[a-z0-9]+)*))?$/i.exec(model);
      if (!gpt) return null;
      return gpt[2] === undefined
        ? `GPT-${gpt[1]}`
        : `GPT-${gpt[1]} ${gpt[2].split("-").map((w) => capitalize(w.toLowerCase())).join(" ")}`;
    },
  },
  // account/rateLimits/updated 只带窗口长度、不带名字：长度见 QUOTA_WINDOWS（codex-protocol.ts 的 parseCodexRateLimits 按它归类），codex 自己不报“快用完”
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
    subagentTools: ["spawn_agent"],
    backgroundCommandTool: "后台命令参数",
  },
  failure: {
    serviceName: "Codex",
    rawHint: /^codex_not_found\b|\bcodex\b|openai|chatgpt/i,
    rawHintPriority: 1,
  },
  capabilities: {
    // 后台命令跑完不会自己开新轮叫醒 agent（docs/mid-turn-messages.md 第 10.3 节）
    backgroundWake: false,
    readonly: "driver",
    explicitDefaultModel: true,
  },
});
