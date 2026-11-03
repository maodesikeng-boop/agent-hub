// 权限（m3-plan 第 2.1、2.2 节）：项目经理和 Worker 的 --settings 文件、Worker 多设的环境变量，都只在这里定。
// 以后想让 Worker 默认和项目经理不一样、加回某条拒绝规则、M4 加权限钩子，只改这个文件。
// launch.ts 只调 buildSessionSettings 和 sessionEnv，两种角色走同一个函数。
import type { AgentRole } from "./domain.ts";
import { HUB_ALLOW_RULE } from "./hub.ts";

/**
 * 默认档（用户 11-03 定的）：auto，分类器替人审每一步，项目经理和 Worker 一样。不加拒绝规则：
 * 推送、合并、装软件之前先问用户，写在提示词里（prompt.ts 的 ASK_FIRST_RULES），不靠规则拦。
 * 写进设置文件的 permissions.defaultMode，内容进 fingerprint，改了下一条消息前自动重启。
 */
export const DEFAULT_PERMISSION_MODE = "auto";
/** 派活时 --readonly：dontAsk，要批准的一律拒绝，读文件和只读命令照常能用。 */
export const READONLY_PERMISSION_MODE = "dontAsk";
export type PermissionMode = typeof DEFAULT_PERMISSION_MODE | typeof READONLY_PERMISSION_MODE;

/**
 * Worker 不能写记忆（唯一的硬限制，m3-plan 第 2.2 节），路径固定的那几条：
 * 工作目录里任何一层的约定文件（只写文件名就是任何深度）、项目的 .claude/、用户级的 ~/.claude/。
 * Edit 规则也管 Write 工具和 Bash 里认得出的 sed、tee、重定向；拒绝规则在所有档下都先于别的规则。
 * 数据目录的 state/ 跟着数据目录走，见 stateDirDenyRule。
 */
export const WORKER_MEMORY_DENY_RULES = [
  "Edit(AGENTS.md)",
  "Edit(CLAUDE.md)",
  "Edit(CLAUDE.local.md)",
  "Edit(.claude/**)",
  "Edit(~/.claude/**)",
] as const;

/**
 * 数据目录的 state/（性格设定文件 personas/、数据库、令牌）：stateDir 要 realpath 过（paths.ts 的 stateDir）。
 * 绝对路径的写法是 // 开头：/Users/u/.agent-hub/state → Edit(//Users/u/.agent-hub/state/**)。
 */
export function stateDirDenyRule(stateDir: string): string {
  return `Edit(/${stateDir.replace(/\/+$/, "")}/**)`;
}

/** Worker 的全部记忆规则。 */
export function workerMemoryDenyRules(stateDir: string): string[] {
  return [...WORKER_MEMORY_DENY_RULES, stateDirDenyRule(stateDir)];
}

/**
 * Worker 启动时多设的环境变量：关掉 Claude Code 的自动记忆（同一个仓库的所有 worktree 共用一个自动记忆目录，
 * Worker 写进去项目经理下次就会读到）。代价是 Worker 也读不到自动记忆。设置文件里再写 autoMemoryEnabled: false。
 */
export const WORKER_ENV: Readonly<Record<string, string>> = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };

export type SessionRole = Extract<AgentRole, "pm" | "worker">;

export interface SessionSettingsInput {
  role: SessionRole;
  /** 工单的 readonly；项目经理一律 false。 */
  readonly: boolean;
  /** hub.sock 的真实路径（realpath 过：macOS 上 /var 其实是 /private/var，写错了沙箱放行不生效）。 */
  hubSock: string;
  /** 数据目录 state/ 的真实路径，Worker 的记忆规则用。 */
  stateDir: string;
}

/** --settings 文件的内容。 */
export interface SessionSettings {
  permissions: { defaultMode: PermissionMode; allow: string[]; deny?: string[] };
  sandbox: { network: { allowUnixSockets: string[] } };
  autoMemoryEnabled?: false;
}

/**
 * 每个会话的 --settings 文件内容（取代 M2 的 hub.ts buildHubSettings）。用户全局 ~/.claude 的设置照常生效。
 * - 两种角色都有：默认档（readonly 时换成只读档）、放行 hub、放行 hub.sock；
 * - Worker 再加记忆规则和 autoMemoryEnabled: false。最后无条件加，不管 readonly 怎么写。
 * 每次返回新对象。
 */
export function buildSessionSettings(input: SessionSettingsInput): SessionSettings {
  const settings: SessionSettings = {
    permissions: { defaultMode: input.readonly ? READONLY_PERMISSION_MODE : DEFAULT_PERMISSION_MODE, allow: [HUB_ALLOW_RULE] },
    sandbox: { network: { allowUnixSockets: [input.hubSock] } },
  };
  if (input.role === "worker") {
    settings.permissions.deny = workerMemoryDenyRules(input.stateDir);
    settings.autoMemoryEnabled = false;
  }
  return settings;
}

/** 这个角色启动时要多设的环境变量（launch.ts 盖在 HUB_TOKEN 等之上）。项目经理没有。 */
export function sessionEnv(role: SessionRole): Readonly<Record<string, string>> {
  return role === "worker" ? WORKER_ENV : {};
}
