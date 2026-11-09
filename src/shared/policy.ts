// 权限（m3-plan 第 2.1、2.2 节）：项目经理和 Worker 的 --settings 文件、Worker 多设的环境变量，都只在这里定。
// 以后想让 Worker 默认和项目经理不一样、加回某条拒绝规则、M4 加权限钩子，只改这个文件。
// launch.ts 只调 buildSessionSettings 和 sessionEnv，两种角色走同一个函数。
import type { AgentRole } from "./domain.ts";
import { CLAUDE_READONLY_PERMISSION_MODE, claudeReadonlyPermissions, claudeReadonlySandbox, type ClaudeReadonlySandbox } from "./claude-readonly-settings.ts";
import { HUB_COMMAND } from "./names.ts";
import type { ReadonlyPolicy } from "./readonly-policy.ts";

/** 放行 hub 命令的规则（M2 起在 hub.ts，M3 W3 挪来和别的权限放一起，命令名用 names.ts 的）。 */
const HUB_ALLOW_RULE = `Bash(${HUB_COMMAND}:*)`;

/**
 * 默认档（用户 11-03 定的）：auto，分类器替人审每一步，项目经理和 Worker 一样。不加拒绝规则（11-04 起提示词里也不写死“先问用户”清单，由 agent 按项目的 AGENTS.md 判断）。
 * 写进设置文件的 permissions.defaultMode，内容进 fingerprint，改了下一条消息前自动重启。
 */
export const DEFAULT_PERMISSION_MODE = "auto";
/** 取代 dontAsk 的只读档（default + 驱动接 can_use_tool）在 claude-readonly-settings.ts 的 CLAUDE_READONLY_PERMISSION_MODE。 */
type PermissionMode = typeof DEFAULT_PERMISSION_MODE | typeof CLAUDE_READONLY_PERMISSION_MODE;

/**
 * 系统数据目录 state/（数据库、令牌、性格设定）的 Edit 拒绝规则：Worker 都带上，是可写范围（write-scope.ts）的兜底——
 * 有 OS 沙箱时数据目录本来就写不了，这条多余但无害；没有（不是 macOS）时编辑工具至少还写不了 state/（shell 管不住）。
 * stateDir 要 realpath 过。绝对路径的写法是 // 开头：/Users/u/.agent-hub/state → Edit(//Users/u/.agent-hub/state/**)。
 * 规则按 gitignore 的写法匹配，路径里的 \ [ ] * ? 前面加 \ 转义，当普通字符。
 */
export function stateDirDenyRule(stateDir: string): string {
  const escaped = stateDir.replace(/\/+$/, "").replace(/[\\[\]*?]/g, "\\$&");
  return `Edit(/${escaped}/**)`;
}

/**
 * Worker 启动时多设的环境变量：关掉 Claude Code 的自动记忆（同一个仓库的所有 worktree 共用一个自动记忆目录，
 * Worker 写进去项目经理下次就会读到）。代价是 Worker 也读不到自动记忆。设置文件里再写 autoMemoryEnabled: false。
 */
export const WORKER_ENV: Readonly<Record<string, string>> = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };

export type SessionRole = Extract<AgentRole, "pm" | "worker">;

/** 只读 Worker 的 claude 翻译要的东西（claude-readonly-settings.ts）：统一策略，加这个会话工作目录和 add-dir 的真实路径（沙箱 denyWrite 盖住它们）。 */
interface SessionReadonlyInput {
  policy: ReadonlyPolicy;
  denyWrite: string[];
}

export interface SessionSettingsInput {
  role: SessionRole;
  /**
   * 只读 Worker 才给（claude 用自带沙箱落实只读，见 claude-readonly-settings.ts）；项目经理、普通 Worker 不给。
   * 给了就整个换成只读档：default 模式、放行读和命令、拒绝编辑工具、claude 自带沙箱，不再看 osSandboxed（这时进程不包外层沙箱，嵌套会 exit 71）。
   */
  readonly?: SessionReadonlyInput;
  /** hub.sock 的真实路径（realpath 过：macOS 上 /var 其实是 /private/var，写错了沙箱放行不生效）。 */
  hubSock: string;
  /** 数据目录 state/ 的真实路径：Worker 的 stateDirDenyRule 用。 */
  stateDir: string;
  /**
   * Worker 的进程会包进 OS 沙箱（daemon/driver/write-scope.ts 的 osSandboxAvailable，macOS 上是）：
   * 是的话关掉 claude 自带的沙箱（sandbox.enabled: false）——macOS 沙箱不能嵌套，开着 Bash 全部 exit 71。只读 Worker 不适用（见 readonly）。
   */
  osSandboxed: boolean;
}

/** --settings 文件的内容。 */
export interface SessionSettings {
  permissions: { defaultMode: PermissionMode; allow: string[]; deny?: string[] };
  sandbox: PlainSandbox | ClaudeReadonlySandbox;
  autoMemoryEnabled?: false;
}

/** 项目经理、普通 Worker 的 sandbox 段：只放行 hub.sock；包进 OS 沙箱的 Worker 再加 enabled: false。 */
interface PlainSandbox {
  enabled?: false;
  network: { allowUnixSockets: string[] };
}

/**
 * 每个会话的 --settings 文件内容（M3 起取代 M2 的 buildHubSettings，那个已删）。用户全局 ~/.claude 的设置照常生效。
 * - 两种角色都有：默认档、放行 hub、放行 hub.sock；
 * - Worker 再加 autoMemoryEnabled: false 和 state/ 的拒绝规则（兜底，见 stateDirDenyRule）。数据目录不能写主要不靠设置文件：
 *   权限规则管不住 shell，由驱动层按 LaunchFiles.writeScope 落实（daemon/driver/write-scope.ts）；包进 OS 沙箱的 Worker
 *   再写 sandbox.enabled: false（--settings 压过用户和项目设置，用户自己开了 claude 的沙箱也关掉）；
 * - 只读 Worker（readonly）：权限和沙箱都换成 claude-readonly-settings.ts 翻译出来的（hub 的放行规则照加），不写 state/ 的规则（编辑工具本来就全拒）。
 * 每次返回新对象。
 */
export function buildSessionSettings(input: SessionSettingsInput): SessionSettings {
  if (input.readonly) {
    const { allow, deny } = claudeReadonlyPermissions(input.readonly.policy);
    return {
      permissions: { defaultMode: CLAUDE_READONLY_PERMISSION_MODE, allow: [HUB_ALLOW_RULE, ...allow], deny },
      sandbox: claudeReadonlySandbox(input.readonly.policy, { denyWrite: input.readonly.denyWrite, hubSock: input.hubSock }),
      autoMemoryEnabled: false,
    };
  }
  const sandbox: PlainSandbox = { network: { allowUnixSockets: [input.hubSock] } };
  const settings: SessionSettings = { permissions: { defaultMode: DEFAULT_PERMISSION_MODE, allow: [HUB_ALLOW_RULE] }, sandbox };
  // 2026-11-06 用户去掉了“Worker 不能改记忆文件”的拒绝规则；数据目录的保护在 writeScope（见上）
  if (input.role === "worker") {
    settings.permissions.deny = [...(settings.permissions.deny ?? []), stateDirDenyRule(input.stateDir)];
    settings.autoMemoryEnabled = false;
    if (input.osSandboxed) sandbox.enabled = false;
  }
  return settings;
}

/** 这个角色启动时要多设的环境变量（launch.ts 盖在 HUB_TOKEN 等之上）。项目经理没有。 */
export function sessionEnv(role: SessionRole): Readonly<Record<string, string>> {
  return role === "worker" ? WORKER_ENV : {};
}

/**
 * 后台写交接复制出来的那份 claude（daemon/handover/claude.ts）的 --settings：在项目经理的设置上叠三层，技术上不让它动任何东西
 * （提示词里也说了“不调用工具”，这里不靠提示词）。不能改工具清单、模型、系统提示词（前缀变了吃不到缓存），所以只动权限和钩子。
 * 2026-11-07 真 claude 2.1.314 实测（复制那份让它 Write、Bash 写文件、Edit 改文件）：不加时三样都写成了；叠上这三层三样都被拦，
 * 连用户设置里放行过的 Bash(echo:*)、Write、Edit 也拦得住；第一个请求的缓存命中不加是 97.8%（读 77306/共 79020），叠上后 97.6%（77306/79231）。
 * 反例：拒绝规则写整个工具（Bash、Bash(*)）会把工具从清单里拿掉，缓存读数掉到 0，所以 Bash 只靠钩子和 dontAsk 管。
 * - PreToolUse 钩子拦下所有工具调用（退出码 2）：压过任何放行规则；disableAllHooks: false 盖过用户设置里关钩子的；
 * - 权限档换成 dontAsk：钩子没跑时（托管策略只许托管钩子），没放行的工具一律拒绝；
 * - Edit(//**) 拒绝：编辑工具（Edit、Write、NotebookEdit）哪里都写不了，压过任何放行规则。
 * 都在 claude 进程里管、不靠 OS 沙箱，Linux 上一样。剩下的缺口：钩子没跑、且用户或项目设置里放行了会写文件的 shell 命令。
 */
export const FORK_PERMISSION_MODE = "dontAsk";
/** 只写带范围的拒绝规则：整工具的规则会把工具从清单里拿掉，缓存就没了（见上）。 */
export const FORK_DENY_RULES: readonly string[] = ["Edit(//**)"];
/** 拦下所有工具调用的 PreToolUse 钩子：退出码 2 是拦下，标准错误的话交给模型。 */
export const FORK_DENY_ALL_HOOK = {
  matcher: "*",
  hooks: [{ type: "command", command: "echo '这是复制出来只写交接的一份：不能调用任何工具，直接把交接写成这一轮的回复。' >&2; exit 2" }],
} as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const arrayOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** 复制那份的设置：项目经理的设置（设置文件读出来的对象）叠上上面三层，别的照留。返回新对象，不改 base。 */
export function buildForkSettings(settings: object): Record<string, unknown> {
  const base = settings as Record<string, unknown>;
  const permissions = isRecord(base.permissions) ? base.permissions : {};
  const hooks = isRecord(base.hooks) ? base.hooks : {};
  return {
    ...base,
    permissions: { ...permissions, defaultMode: FORK_PERMISSION_MODE, deny: [...arrayOf(permissions.deny), ...FORK_DENY_RULES] },
    hooks: { ...hooks, PreToolUse: [...arrayOf(hooks.PreToolUse), FORK_DENY_ALL_HOOK] },
    disableAllHooks: false,
  };
}
