// Pi（@earendil-works/pi-coding-agent）的声明：纯数据 + 纯函数，网页、hub 命令行、守护进程都引。
// 不许 import node:*、src/daemon、别家文件夹（契约测试 S2）。
// 只给守护进程用的路径与凭据变量在同目录的 paths.ts。
import { PRODUCT_NAME } from "../../shared/names.ts";
import { blockedCommands, capitalize, defineVendor } from "../types.ts";

/** Pi 支持的完整思考档位（--thinking <level>，Pi 会自动按模型的 thinkingLevelMap 钳位到最接近的支持档位）。 */
const EFFORTS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DEEPSEEK_PRO_EFFORTS: readonly string[] = ["off", "high", "max"];
const DEEPSEEK_FLASH_EFFORTS: readonly string[] = ["off", "low", "high", "max"];
const GPT_EFFORTS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const GEMINI_EFFORTS: readonly string[] = ["off", "minimal", "low", "medium", "high"];

const SESSION_BLOCKED = `会话由 ${PRODUCT_NAME} 管，这里不能用这个命令；项目经理要开新会话，请点右上角“开新会话”按钮`;
const MODEL_BLOCKED = "换模型、思考程度请在资料页改（Worker 的由项目经理派活时定）";
const ACCOUNT_BLOCKED = "账号相关的命令这里不能用，请在终端里打开 pi 用 /login 登录";
const SETTINGS_BLOCKED = `设置和权限由 ${PRODUCT_NAME} 管，这里不能用这个命令`;
const TERMINAL_BLOCKED = "这是终端专用的命令，网页里不能用";

/** 把 <provider>/<model> 缩成可读短名；认不出家族时去掉 provider 前缀原样回退。 */
function formatPiShortModel(model: string): string | null {
  const slash = model.indexOf("/");
  const bare = slash >= 0 ? model.slice(slash + 1) : model;
  if (bare === "") return null;

  const deepseek = /^deepseek-(.+)$/i.exec(bare);
  if (deepseek) {
    const rest = deepseek[1]!
      .split("-")
      .map((part) => (/^v\d+(?:\.\d+)?$/i.test(part) ? part.toUpperCase() : capitalize(part.toLowerCase())))
      .join(" ");
    return `DeepSeek ${rest}`;
  }

  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-(?:\d{8}|latest))?$/i.exec(bare);
  if (claude) {
    const ver = claude[3] === undefined ? claude[2]! : `${claude[2]}.${claude[3]}`;
    return `Claude ${capitalize(claude[1]!.toLowerCase())} ${ver}`;
  }

  const gpt = /^gpt-(\d+(?:\.\d+)?)(?:-([a-z0-9]+(?:-[a-z0-9]+)*))?$/i.exec(bare);
  if (gpt) {
    return gpt[2] === undefined
      ? `GPT-${gpt[1]}`
      : `GPT-${gpt[1]} ${gpt[2].split("-").map((w) => capitalize(w.toLowerCase())).join(" ")}`;
  }

  const gemini = /^gemini-(\d+(?:\.\d+)?)-([a-z0-9]+(?:-[a-z0-9]+)*)$/i.exec(bare);
  if (gemini) {
    return `Gemini ${gemini[1]} ${gemini[2]!.split("-").map((w) => capitalize(w.toLowerCase())).join(" ")}`;
  }

  return slash >= 0 ? bare : null;
}

export default defineVendor({
  id: "pi",
  label: "Pi",
  cli: {
    command: "pi",
    envVar: "AGENT_HUB_PI",
    loginCommand: "pi",
  },
  // auth.json 存 /login 的 OAuth 与 API key，models.json 可含内联 apiKey，只读 Worker 跨家禁读；
  // settings.json 与 models-store.json 不含密钥，仅参与模型目录指纹监视。
  home: {
    dirs: [".pi/agent"],
    readonlySecrets: [".pi/agent/auth.json", ".pi/agent/models.json"],
    catalogWatchPaths: [
      ".pi/agent/auth.json",
      ".pi/agent/models.json",
      ".pi/agent/settings.json",
      ".pi/agent/models-store.json",
    ],
    configHome: { rel: ".pi/agent", env: "PI_CODING_AGENT_DIR" },
  },
  models: {
    // 2026-11-11 本机 pi 1.5.0 内置代表性模型（含 DeepSeek 旗舰与轻量模型）；未配凭据或探测失败时兜底
    bundled: [
      { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", efforts: DEEPSEEK_PRO_EFFORTS },
      { id: "deepseek/deepseek-flash", label: "DeepSeek V4.1 Flash", efforts: DEEPSEEK_FLASH_EFFORTS },
      { id: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5", efforts: EFFORTS },
      { id: "anthropic/claude-opus-5-5", label: "Claude Opus 5.5", efforts: EFFORTS },
      { id: "openai/gpt-5.4", label: "GPT-5.4", efforts: GPT_EFFORTS },
      { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", efforts: GEMINI_EFFORTS },
    ],
    customModel: true,
    customModelExample: "如 deepseek/deepseek-v4-pro",
    efforts: EFFORTS,
    routerDefault: { model: "deepseek/deepseek-flash", effort: "off" },
    flags: { model: "--model", effort: "--thinking" },
    shortName: formatPiShortModel,
  },
  composer: {
    commandPrefix: "/",
    compactCommand: "compact",
    blockedCommands: {
      ...blockedCommands(SESSION_BLOCKED, ["clear", "new", "resume", "fork", "clone", "tree", "import", "quit", "exit", "name"]),
      ...blockedCommands(ACCOUNT_BLOCKED, ["login", "logout"]),
      ...blockedCommands(MODEL_BLOCKED, ["model", "thinking", "scoped-models"]),
      ...blockedCommands(SETTINGS_BLOCKED, ["settings", "trust", "mcp", "reload"]),
      ...blockedCommands(TERMINAL_BLOCKED, ["hotkeys", "changelog", "copy", "export", "share", "bug"]),
    },
  },
  prompt: {
    subagentTools: [],
    backgroundCommandTool: "后台命令",
  },
  failure: {
    serviceName: "Pi",
    rawHint: /^pi_not_found\b|\bpi-coding-agent\b|\bspawn pi\b|\bpi:/i,
    // Pi 转接 30+ 模型商（报错原文里常带 anthropic/openai/gemini/deepseek 模型名），显式命中 Pi 特征时优先认 Pi
    rawHintPriority: 2,
  },
  // 会话记录是 ~/.pi/agent/sessions/--<cwd>--/<timestamp>_<id>.jsonl 纯文本，跨厂商交接可读
  handover: { transcriptPortable: true },
  tools: {
    actions: {
      bash: "command",
      powershell: "command",
      codemode: "command",
      read: "read",
      edit: "edit",
      write: "write",
      grep: "search",
      find: "search",
      ls: "search",
      tool_search: "tool_search",
    },
  },
  capabilities: {
    backgroundWake: false,
    readonly: "os_sandbox",
    // --append-system-prompt <prompt.md>（protocol.ts）：进 pi 的系统提示词，压缩不裁
    systemPrompt: "resident",
    // 任务图手册：--skill <启动目录>/skills（scope: temporary；2026-11-12 pi 1.5.2 实测）
    skills: "native",
  },
});
