// deepseek（官方 DeepSeek Harness，命令行 dsh）的声明：纯数据 + 纯函数，网页、hub 命令行、守护进程都引。
// 不许 import node:*、src/daemon、别家文件夹（契约测试 S2）。
// 沙箱与模型配置：通过 daemon.ts 的 launchFiles 生成 Cordis overlay patch JSON 文件，
// 由 driver.ts 在启动参数中传 `--profile acp --patch <file>` 关闭内置 Seatbelt/bwrap 沙箱（设为 danger-full-access），
// 模型与思考程度走 ACP session/set_config_option（不设命令行 flags）。
import { PRODUCT_NAME } from "../../shared/names.ts";
import { blockedCommands, capitalize, defineVendor } from "../types.ts";

/** DeepSeek Harness 数据目录（相对用户主目录，可通过环境变量 DSH_HOME 覆盖）。 */
export const DEEPSEEK_HOME_REL = ".dsh";

/**
 * 思考程度：与 @deepseek-ai/dsh-llm-deepseek 0.2.2-rc.1 的 REASONING_EFFORT_OPTIONS 实测对齐
 * （configId 为 reasoning_effort，支持 off / low / high / max 四档，默认 high，无 medium）。
 */
const EFFORTS: readonly string[] = ["off", "low", "high", "max"];

const SESSION_BLOCKED = `会话由 ${PRODUCT_NAME} 管，这里不能用这个命令；项目经理要开新会话，请点右上角“开新会话”按钮`;
const MODEL_BLOCKED = "换模型、思考程度请在资料页改（Worker 的由项目经理派活时定）";
const ACCOUNT_BLOCKED = "账号相关的命令这里不能用，请在终端里打开 dsh";
const SANDBOX_BLOCKED = `权限和沙箱由 ${PRODUCT_NAME} 管，这里不能用这个命令`;

/** 若传入的是 dsh-acp 的 JSON 二元组字符串（如 `["deepseek-official","deepseek-v4-pro"]`），取出模型名部分。 */
function unwrapTupleModel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[")) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[1] === "string" && parsed[1].trim() !== "") {
      return parsed[1].trim();
    }
  } catch {
    // 非 JSON 二元组按原字符串处理
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
  // 2026-11-11 核对 @deepseek-ai/dsh@0.2.2-rc.1：
  // ~/.dsh/.credentials.yaml 存 API key 与网页登录 grant（0600），~/.dsh/.env 是备用环境变量文件；
  // catalog.ts 走零子进程本地凭据探测（绝不拉起 dsh 新建持久空会话），catalogWatchPaths 盯本地凭据与配置变更。
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
    // 与 @deepseek-ai/dsh-llm-deepseek 的 DEFAULT_MODELS 对齐
    bundled: [
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", efforts: EFFORTS },
      { id: "deepseek-flash", label: "DeepSeek V4.1 Flash", efforts: EFFORTS },
    ],
    customModel: true,
    customModelExample: "如 deepseek-v4-pro",
    efforts: EFFORTS,
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
  // 会话记录是 Zstandard 压缩帧（sessions/<cwd>/<ts>_<uuid>.v4.jsonl.zstd），别家读不了明文
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
  capabilities: {
    backgroundWake: false,
    readonly: "os_sandbox",
  },
});
