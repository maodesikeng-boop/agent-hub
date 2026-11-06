// 权限（m3-plan 第 2.1、2.2 节）：项目经理和 Worker 的 --settings 文件、Worker 多设的环境变量，都只在这里定。
// 以后想让 Worker 默认和项目经理不一样、加回某条拒绝规则、M4 加权限钩子，只改这个文件。
// launch.ts 只调 buildSessionSettings 和 sessionEnv，两种角色走同一个函数。
import type { AgentRole } from "./domain.ts";
import { HUB_COMMAND } from "./names.ts";

/** 放行 hub 命令的规则（M2 起在 hub.ts，M3 W3 挪来和别的权限放一起，命令名用 names.ts 的）。 */
export const HUB_ALLOW_RULE = `Bash(${HUB_COMMAND}:*)`;

/**
 * 默认档（用户 11-03 定的）：auto，分类器替人审每一步，项目经理和 Worker 一样。不加拒绝规则（11-04 起提示词里也不写死“先问用户”清单，由 agent 按项目的 AGENTS.md 判断）。
 * 写进设置文件的 permissions.defaultMode，内容进 fingerprint，改了下一条消息前自动重启。
 */
export const DEFAULT_PERMISSION_MODE = "auto";
/** 派活时 --readonly：dontAsk，要批准的一律拒绝，读文件和只读命令照常能用。 */
export const READONLY_PERMISSION_MODE = "dontAsk";
export type PermissionMode = typeof DEFAULT_PERMISSION_MODE | typeof READONLY_PERMISSION_MODE;

/**
 * 只读档额外放行的东西。dontAsk 下要批准的一律拒绝，真 claude 实测（11-04）：WebSearch 和 Slack 的 slack_search_public
 * （声明了 readOnlyHint 也一样）都被拒，所以连接器的只读工具要自己列。以后连了新连接器、或新增了只读工具，往下面加一行就行。
 * 只放读、搜、查的；发消息、发邮件、写文件、改工单一律不列。键是连接器在 claude 里的服务名（mcp__<服务名>__<工具名>）。
 */
export const READONLY_WEB_ALLOW_RULES = ["WebSearch", "WebFetch"] as const;
/** 只读 git：-C 指到别的 worktree 也行（真 claude 实测 `:*` 写法在 -C 后的通配不生效，要写成 `git -C * log *`；git status/diff/log/show/blame/ls-files/branch 只看，不改仓库）。 */
export const READONLY_GIT_ALLOW_RULES = ["status", "diff", "log", "show", "blame", "ls-files", "rev-parse"].flatMap((sub) => [`Bash(git -C * ${sub})`, `Bash(git -C * ${sub} *)`]);
/** 只读 git 里会越界的参数：--output=<文件> 会写文件，--ext-diff 会跑仓库配置的外部程序。拒绝规则先于放行。 */
export const READONLY_GIT_DENY_RULES = ["Bash(git * --output*)", "Bash(git * --ext-diff*)"] as const;
export const READONLY_CONNECTOR_TOOLS: Readonly<Record<string, readonly string[]>> = {
  claude_ai_Slack: [
    "slack_search_public", "slack_search_public_and_private", "slack_search_channels", "slack_search_users", "slack_search_emojis",
    "slack_read_channel", "slack_read_thread", "slack_read_canvas", "slack_read_file", "slack_read_list", "slack_read_user_profile",
    "slack_list_channel_members", "slack_list_user_channels", "slack_get_reactions",
  ],
  claude_ai_Gmail: ["search_threads", "get_message", "get_thread", "get_draft", "list_drafts", "list_labels"],
  claude_ai_Google_Drive: ["search_files", "read_file_content", "get_file_metadata", "get_file_permissions", "list_recent_files"],
  claude_ai_Google_Docs: ["read_doc"],
  claude_ai_Google_Sheets: ["get_spreadsheet", "get_values"],
  claude_ai_Atlassian_Rovo: [
    "search", "fetch", "searchJiraIssuesUsingJql", "searchConfluenceUsingCql", "atlassianUserInfo", "getAccessibleAtlassianResources",
    "getJiraIssue", "getJiraIssueRemoteIssueLinks", "getJiraIssueTypeMetaWithFields", "getJiraProjectIssueTypesMetadata", "getVisibleJiraProjects",
    "getTransitionsForJiraIssue", "getIssueLinkTypes", "lookupJiraAccountId",
    "getConfluencePage", "getConfluencePageDescendants", "getConfluencePageFooterComments", "getConfluencePageInlineComments",
    "getConfluenceCommentChildren", "getConfluenceSpaces", "getPagesInConfluenceSpace",
    "getCompassComponent", "getCompassComponents", "getCompassCustomFieldDefinitions", "getTeamworkGraphContext", "getTeamworkGraphObject",
  ],
};

/** 只读档的放行规则：上网、读本项目的 worktrees/<项目编号>/（别的 Worker 的 worktree，审查要读）、只读 git、连接器只读工具。 */
export function readonlyAllowRules(projectWorktreesDir: string | undefined): string[] {
  const rules: string[] = [...READONLY_WEB_ALLOW_RULES];
  if (projectWorktreesDir !== undefined) {
    // 绝对路径 // 开头，特殊字符转义
    rules.push(`Read(/${projectWorktreesDir.replace(/\/+$/, "").replace(/[\\[\]*?]/g, "\\$&")}/**)`);
  }
  rules.push(...READONLY_GIT_ALLOW_RULES);
  for (const [server, tools] of Object.entries(READONLY_CONNECTOR_TOOLS)) for (const tool of tools) rules.push(`mcp__${server}__${tool}`);
  return rules;
}

/**
 * 系统数据目录 state/（数据库、令牌、性格设定文件 personas/）：Worker 不能写（2026-11-06 用户去掉了记忆文件那条限制，这条保留）。
 * stateDir 要 realpath 过（paths.ts 的 stateDir）。绝对路径的写法是 // 开头：/Users/u/.agent-hub/state → Edit(//Users/u/.agent-hub/state/**)。
 * 规则按 gitignore 的写法匹配，路径里的 \ [ ] * ? 前面加 \ 转义，当普通字符。
 */
export function stateDirDenyRule(stateDir: string): string {
  const escaped = stateDir.replace(/\/+$/, "").replace(/[\\[\]*?]/g, "\\$&");
  return `Edit(/${escaped}/**)`;
}

function normalizePathSegments(rawPath: string, homeDir?: string): { absolute: boolean; segments: string[]; normalized: string } {
  let p = rawPath.trim().replace(/\\/g, "/");
  if (homeDir && (p === "~" || p.startsWith("~/"))) {
    const cleanHome = homeDir.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    p = cleanHome + p.slice(1);
  }
  const absolute = p.startsWith("/");
  const segments: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else if (!absolute) {
        segments.push("..");
      }
    } else {
      segments.push(part);
    }
  }
  const normalized = (absolute ? "/" : "") + segments.join("/");
  return { absolute, segments, normalized };
}

/**
 * 供 AgyDriver 和 CodexDriver 判断某个路径是否在系统数据目录 stateDir 下（展开 ~、相对 cwd 解析、消掉 ..、不分大小写）。
 */
export function isStateDirPath(targetPath: string, stateDir: string, homeDir?: string, cwd?: string): boolean {
  const trimmedTarget = targetPath.trim().replace(/\\/g, "/");
  if (trimmedTarget === "" || stateDir.trim() === "") return false;
  const effectiveHome = homeDir ?? (typeof process !== "undefined" ? process.env.HOME : undefined);
  const resolvedTarget =
    cwd && cwd.trim() !== "" && !trimmedTarget.startsWith("/") && trimmedTarget !== "~" && !trimmedTarget.startsWith("~/")
      ? `${cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "")}/${trimmedTarget}`
      : trimmedTarget;
  const normLower = normalizePathSegments(resolvedTarget, effectiveHome).normalized.toLowerCase();
  const stateLower = normalizePathSegments(stateDir, effectiveHome).normalized.toLowerCase();
  return stateLower !== "" && stateLower !== "/" && (normLower === stateLower || normLower.startsWith(`${stateLower}/`));
}

const SHELL_WRITE_INDICATORS =
  />|>>|\b(tee|sed|awk|perl|python\d*|node|ruby|cp|mv|rm|touch|dd|truncate|patch|install|chmod|chown|sh|bash|zsh)\b/;

/** 命令行是否会写系统数据目录：提到 stateDir 下的路径，且不是 cat/head/tail/less/more/wc/stat/ls 这类只读命令。 */
export function commandWritesStateDir(command: string, stateDir: string, cwd?: string): boolean {
  const tokens = command
    .split(/[\s><|&;'"`()=]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.some((tok) => isStateDirPath(tok, stateDir, undefined, cwd))) return false;
  if (SHELL_WRITE_INDICATORS.test(command)) return true;
  return !/^\s*(cat|head|tail|less|more|wc|stat|ls)\b/.test(command);
}

/**
 * Worker 启动时多设的环境变量：关掉 Claude Code 的自动记忆（同一个仓库的所有 worktree 共用一个自动记忆目录，
 * Worker 写进去项目经理下次就会读到）。代价是 Worker 也读不到自动记忆。设置文件里再写 autoMemoryEnabled: false。
 */
export const WORKER_ENV: Readonly<Record<string, string>> = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };

export type SessionRole = Extract<AgentRole, "pm" | "worker">;

export interface SessionSettingsInput {
  role: SessionRole;
  /** WorkerRecord 的 readonly；项目经理一律 false。 */
  readonly: boolean;
  /** hub.sock 的真实路径（realpath 过：macOS 上 /var 其实是 /private/var，写错了沙箱放行不生效）。 */
  hubSock: string;
  /** 数据目录 state/ 的真实路径，Worker 的数据目录规则用。 */
  stateDir: string;
  /** 本项目的 worktrees/<项目编号>/ 真实路径；只读档放行读它。没有项目就不传。 */
  projectWorktreesDir?: string;
}

/** --settings 文件的内容。 */
export interface SessionSettings {
  permissions: { defaultMode: PermissionMode; allow: string[]; deny?: string[] };
  sandbox: { network: { allowUnixSockets: string[] } };
  autoMemoryEnabled?: false;
}

/**
 * 每个会话的 --settings 文件内容（M3 起取代 M2 的 buildHubSettings，那个已删）。用户全局 ~/.claude 的设置照常生效。
 * - 两种角色都有：默认档（readonly 时换成只读档，并多放行 readonlyAllowRules）、放行 hub、放行 hub.sock；
 * - Worker 再加 state/ 的拒绝规则和 autoMemoryEnabled: false。
 * 每次返回新对象。
 */
export function buildSessionSettings(input: SessionSettingsInput): SessionSettings {
  const settings: SessionSettings = {
    permissions: { defaultMode: input.readonly ? READONLY_PERMISSION_MODE : DEFAULT_PERMISSION_MODE, allow: [HUB_ALLOW_RULE] },
    sandbox: { network: { allowUnixSockets: [input.hubSock] } },
  };
  if (input.readonly) {
    settings.permissions.allow.push(...readonlyAllowRules(input.projectWorktreesDir));
    settings.permissions.deny = [...READONLY_GIT_DENY_RULES];
  }
  // 2026-11-06 用户去掉了“Worker 不能改记忆文件”的拒绝规则；系统数据目录 state/ 的保护保留
  if (input.role === "worker") {
    settings.permissions.deny = [...(settings.permissions.deny ?? []), stateDirDenyRule(input.stateDir)];
    settings.autoMemoryEnabled = false;
  }
  return settings;
}

/** 这个角色启动时要多设的环境变量（launch.ts 盖在 HUB_TOKEN 等之上）。项目经理没有。 */
export function sessionEnv(role: SessionRole): Readonly<Record<string, string>> {
  return role === "worker" ? WORKER_ENV : {};
}
