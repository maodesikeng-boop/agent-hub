import type { VendorPathsModule } from "../daemon-types.ts";

export const fallbackPaths: VendorPathsModule["fallbackPaths"] = ({ userHome, platform, linuxInstallDirs, join }) => {
  if (platform === "win32") {
    return [
      join(userHome, ".local", "bin", "pi.exe"),
      join(userHome, ".pi", "bin", "pi.exe"),
      join(userHome, "AppData", "Roaming", "npm", "pi.cmd"),
    ];
  }
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

// pi sets AI_AGENT=pi in tool subprocesses.
export const parentSessionEnv: VendorPathsModule["parentSessionEnv"] = [
  "AI_AGENT",
  "PI_CODING_AGENT",
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
];

// Exact names from pi 1.5.0 --help; prefixes would strip non-secret vars such as OPENAI_BASE_URL.
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
export const windowsInstallCommand: VendorPathsModule["windowsInstallCommand"] = "irm https://pi.dev/install.ps1 | iex";
export const headlessLoginCommand: VendorPathsModule["headlessLoginCommand"] = "pi";
