// Pi 只给守护进程和脚本用的纯数据（不进网页包，见 daemon-types.ts 的 VendorPathsModule）：
// PATH 里找不到可执行文件时的兜底路径、父会话变量、30+ 模型商凭据变量剥离规则、官方安装与无头登录命令。
import type { VendorPathsModule } from "../daemon-types.ts";

// 官方安装脚本默认放 ~/.local/bin/pi；兼容 ~/.pi/bin/pi、mise/npm 常见用户级全局目录及 Linux 统一安装目录
export const fallbackPaths: VendorPathsModule["fallbackPaths"] = ({ userHome, platform, linuxInstallDirs, join }) => {
  const userBins = [
    join(userHome, ".local", "bin", "pi"),
    join(userHome, ".pi", "bin", "pi"),
    join(userHome, ".local", "share", "mise", "shims", "pi"),
    join(userHome, ".npm-global", "bin", "pi"),
  ];
  if (platform === "darwin") {
    return [...userBins, "/opt/homebrew/bin/pi", "/usr/local/bin/pi"];
  }
  return [...linuxInstallDirs.map((dir) => join(dir, "pi")), ...userBins];
};

// Pi 执行命令工具时注入 AI_AGENT=pi 等父会话标识；起任何厂商子进程或跑准备脚本前统一剥离
export const parentSessionEnv: VendorPathsModule["parentSessionEnv"] = [
  "AI_AGENT",
  "PI_CODING_AGENT",
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
];

// 对照本机 pi 1.5.0 `pi --help` 的 Environment Variables（2026-11-11 核过）：只列模型商的 API key 和专属 AI 令牌，按名字精确去掉。
// 不用 OPENAI_、GEMINI_ 这类宽前缀，也不用 /_API_KEY$/ 这种通配：OPENAI_BASE_URL、GOOGLE_GEMINI_BASE_URL 这些不是密钥，
// 仓库脚本自己的 *_API_KEY 也不归我们管。GH_TOKEN、GITHUB_TOKEN、AWS_ACCESS_KEY_ID、AWS_SECRET_ACCESS_KEY、AWS_SESSION_TOKEN、NPM_TOKEN
// 虽然 Pi 也认（Copilot、Bedrock），但它们是通用工程凭据，准备命令装私有依赖要用，照常传（setup.ts 的约定）。
// 带地区后缀的 Token Plan（QWEN_TOKEN_PLAN_*_API_KEY、XIAOMI_TOKEN_PLAN_*_API_KEY）以后会加新地区，用 pattern 拦。
export const credentialEnv: VendorPathsModule["credentialEnv"] = {
  names: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_OAUTH_TOKEN",
    "ANT_LING_API_KEY",
    "OPENAI_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "NVIDIA_API_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "CEREBRAS_API_KEY",
    "XAI_API_KEY",
    "FIREWORKS_API_KEY",
    "TOGETHER_API_KEY",
    "BASETEN_API_KEY",
    "OPENROUTER_API_KEY",
    "AI_GATEWAY_API_KEY",
    "ZAI_API_KEY",
    "ZAI_CODING_CN_API_KEY",
    "MISTRAL_API_KEY",
    "MINIMAX_API_KEY",
    "MOONSHOT_API_KEY",
    "OPENCODE_API_KEY",
    "KIMI_API_KEY",
    "META_API_KEY",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_API_TOKEN",
    "XIAOMI_API_KEY",
    "AWS_BEARER_TOKEN_BEDROCK",
    "COPILOT_GITHUB_TOKEN",
    "HF_TOKEN",
  ],
  pattern: /^(?:QWEN|XIAOMI)_TOKEN_PLAN_(?:[A-Z0-9]+_)?API_KEY$/,
};

export const installCommand: VendorPathsModule["installCommand"] = "curl -fsSL https://pi.dev/install.sh | sh";
export const headlessLoginCommand: VendorPathsModule["headlessLoginCommand"] = "pi";
