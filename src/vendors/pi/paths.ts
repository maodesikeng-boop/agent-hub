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

// Pi 支持 30+ 模型商的环境变量（含 DEEPSEEK_API_KEY 等各类 *_API_KEY 与云厂商密钥），准备命令跑仓库脚本前一律去掉
export const credentialEnv: VendorPathsModule["credentialEnv"] = {
  names: [
    "DEEPSEEK_API_KEY",
    "HF_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "COPILOT_GITHUB_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
    "CLOUDFLARE_API_TOKEN",
    "AI_GATEWAY_API_KEY",
    "OPENCODE_API_KEY",
  ],
  prefixes: [
    "DEEPSEEK_",
    "ANTHROPIC_",
    "OPENAI_",
    "AZURE_OPENAI_",
    "GEMINI_",
    "GOOGLE_GENERATIVE_AI_",
    "OPENROUTER_",
    "XAI_",
    "GROQ_",
    "MISTRAL_",
    "CEREBRAS_",
    "FIREWORKS_",
    "TOGETHER_",
    "BASETEN_",
    "NVIDIA_",
    "MINIMAX_",
    "MOONSHOT_",
    "KIMI_",
    "ZAI_",
    "QWEN_",
    "XIAOMI_",
  ],
  pattern: /_API_KEY$/,
};

export const installCommand: VendorPathsModule["installCommand"] = "curl -fsSL https://pi.dev/install.sh | sh";
export const headlessLoginCommand: VendorPathsModule["headlessLoginCommand"] = "pi";
