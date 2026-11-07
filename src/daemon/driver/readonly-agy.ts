// 只读 agy Worker 的翻译层（docs/readonly-worker-design.md 第 2.3、4、7 节）：把 shared/readonly-policy.ts 的统一定义翻成 agy 的东西。
// agy 没有原生的只读命令行，也不按 readOnlyHint 拦连接器（2026-11-07 S4 实测：非只读的 rw_save、没标记的 plain_tool 照样被调用），所以三层：
// 1. --mode plan + --settings 的 permissions 规则：放行读、命令、读网页，拒 write_file、读密钥、非只读的连接器工具（规则 mcp(<服务器>/<工具>)）；
// 2. 外层只读 OS 沙箱（write-scope.ts 的 readonlySeatbeltProfile）：整个进程树哪里都写不了，会话私有临时目录和 agy 自己的运行时目录除外；
// 3. 连接器兜底（checkAgyConnectorCall）：驱动看到 mcp 工具开始调用时，不在放行范围的马上打断（规则没拦住、清单里没有的服务器）。
//    远程连接器（发 Slack、改工单）外层沙箱挡不住，所以连接器必须在调用前按 readOnlyHint 拦：清单从 MCP 服务器自己的 tools/list 拿（agy-connectors.ts）。
// 没有 OS 沙箱的机器上派只读 agy 直接报错（设计第 8 节第 5 条）：没有外层沙箱，命令行写文件挡不住。
import { realpathSync } from "node:fs";
import {
  connectorToolAllowed,
  type ConnectorToolAnnotations,
  type ReadonlyPolicy,
} from "../../shared/index.ts";
import type { ReadonlySandboxInput } from "./write-scope.ts";

/** 没有 OS 沙箱时派只读 agy 的报错（派活和驱动启动两处都用）。 */
export const READONLY_AGY_NEEDS_SANDBOX_MESSAGE =
  "只读的 agy Worker 需要 OS 沙箱（目前只有 macOS 有）：agy 没有自带的只读命令行，没有外层沙箱它的命令行写文件挡不住。这台机器上请改用 claude 或 codex 的只读 Worker。";

/** 只读 agy 放行的内置工具：读文件、跑命令、读网页（命令里的写由外层沙箱挡）。 */
export const AGY_READONLY_ALLOW_RULES: readonly string[] = ["read_file(*)", "command(*)", "read_url(*)"];
/** 只读 agy 直接拒的内置工具：写文件。显式 deny 只报错、不结束这一轮（设计 1.2 节实测）。 */
export const AGY_READONLY_DENY_RULES: readonly string[] = ["write_file(*)"];

/** agy 运行时要写的子目录，相对 ~/.gemini/antigravity-cli（只放子目录和具体文件，不放 settings.json、config/）。bin：run_command 每次重写里面的 agentapi 脚本（S4 实测不放命令全挂）。 */
export const AGY_RUNTIME_DIRS: readonly string[] = ["conversations", "brain", "cache", "log", "presence", "updater", "crashes", "annotations", "implicit", "bin", "mcp"];
/** agy 运行时要写的具体文件，相对 ~/.gemini/antigravity-cli；后面的 * 是任意后缀（-wal、-shm）。 */
export const AGY_RUNTIME_FILES: readonly string[] = ["cli.log", "conversation_summaries.db*", "jetbox_summaries_proto.pb", "last_check.timestamp"];
/** 同上，相对 ~/.gemini/antigravity。 */
export const AGY_RUNTIME_FILES_LEGACY: readonly string[] = ["conversation_summaries.db*", "agyhub_summaries_proto.pb"];
/** 通用缓存目录，相对用户主目录（设计第 8 节第 3 条：放开，uv、npx 这类 MCP 服务器要写）。 */
export const READONLY_CACHE_DIRS: readonly string[] = [".cache", "Library/Caches", ".npm"];

/**
 * 通用禁读清单里、agy 自己要读的路径，相对用户主目录：agy 的 Google 登录存在 macOS 钥匙串里（Go keyring，程序自己打开 ~/Library/Keychains 里的文件再问 securityd），
 * 外层沙箱禁读它 agy 就报 “Authentication required” 整轮没回复（2026-11-07 S4 实测）。所以只对 agy 的外层沙箱放开读，写照旧不放（钥匙串的写由 securityd 做，不在本进程）。
 * 代价：只读 agy 的命令行能读到钥匙串文件（内容是加密的，取明文要 securityd 授权，无头下过不了）；agy 的权限规则那层仍然拒读。
 */
export const AGY_READABLE_SECRET_HOME_PATHS: readonly string[] = ["Library/Keychains"];

function trimSlash(p: string): string {
  return p.replace(/\/+$/, "");
}

/** realpath 没有这个路径（还没建、不存在）就原样用。agy 的规则按真实路径比（/tmp → /private/tmp）。 */
export function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** 正则里的元字符前面加反斜杠。 */
export function escapeRegex(s: string): string {
  return s.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&");
}

/** 路径里带 * 的（任意后缀）转成 sandbox-exec 的正则：^<路径>$，* → [^/]*。 */
function fileRegex(path: string): string {
  return `^${path.split("*").map(escapeRegex).join("[^/]*")}$`;
}

/**
 * 外层只读沙箱的参数（write-scope.ts 的 readonlySeatbeltProfile 吃它）：
 * 可写的只有会话私有临时目录、agy 运行时目录和文件、通用缓存目录；密钥禁读。路径都 realpath 过。
 */
export function agyReadonlySandboxInput(input: { homeDir: string; tmpDir: string; policy: ReadonlyPolicy; realpath?: (p: string) => string }): ReadonlySandboxInput {
  const real = input.realpath ?? realpathOrSelf;
  const home = trimSlash(real(input.homeDir));
  const cli = `${home}/.gemini/antigravity-cli`;
  const legacy = `${home}/.gemini/antigravity`;
  const needed = new Set(AGY_READABLE_SECRET_HOME_PATHS.map((d) => `${home}/${d}`));
  return {
    tmpDir: real(input.tmpDir),
    writableDirs: [...AGY_RUNTIME_DIRS.map((d) => `${cli}/${d}`), ...READONLY_CACHE_DIRS.map((d) => `${home}/${d}`)],
    writableFileRegexes: [...AGY_RUNTIME_FILES.map((f) => fileRegex(`${cli}/${f}`)), ...AGY_RUNTIME_FILES_LEGACY.map((f) => fileRegex(`${legacy}/${f}`))],
    secretPaths: input.policy.secretPaths.map(real).filter((p) => !needed.has(trimSlash(p))),
    secretGlobs: [...input.policy.secretGlobs],
  };
}

// ---- 连接器 ----

/** 一个 MCP 服务器里每个工具的声明（服务器自报）；不可用的服务器（起不来、超时、要认证）没有工具清单，整个拒。 */
export interface AgyConnectorCatalog {
  /** 服务器名 → 工具名 → annotations（没有 annotations 是 null）。 */
  servers: Record<string, Record<string, ConnectorToolAnnotations | null>>;
  /** 知道有、但问不到工具清单的服务器名（起不来、超时、要认证、配置里没有启动方式）。 */
  unlistable: string[];
}

export const EMPTY_AGY_CONNECTOR_CATALOG: AgyConnectorCatalog = { servers: {}, unlistable: [] };

/** 策略里 "<服务器>/<工具>"（没有 / 的当整个服务器）写成 agy 的规则 mcp(<服务器>/<工具>)，服务器和工具都是 * 就是 mcp(*)。 */
export function agyMcpRule(rule: string): string {
  const slash = rule.indexOf("/");
  const server = slash < 0 ? rule : rule.slice(0, slash);
  const tool = slash < 0 ? "*" : rule.slice(slash + 1);
  return server === "*" && tool === "*" ? "mcp(*)" : `mcp(${server}/${tool})`;
}

export interface AgyConnectorRules {
  allow: string[];
  deny: string[];
}

/**
 * 连接器的 agy 规则：
 * - deny：手动排除的；清单里每个 connectorToolAllowed 不放行的工具（mcp(服务器/工具)）；问不到清单的服务器整个拒（除非补充清单里点名了它，
 *   那就只能放行点名的、别的看不见所以也拒不了——所以补充过的服务器要保证能问到清单）；
 * - allow：手动补充的（plan 模式下没标记的工具要批准，整轮会结束，所以要显式放行）。deny 压过 allow（设计 1.2 节实测）。
 */
export function agyConnectorRules(policy: Pick<ReadonlyPolicy, "connectors">, catalog: AgyConnectorCatalog): AgyConnectorRules {
  const deny = new Set<string>(policy.connectors.deny.map(agyMcpRule));
  for (const [server, tools] of Object.entries(catalog.servers)) {
    for (const [tool, annotations] of Object.entries(tools)) {
      if (!connectorToolAllowed(policy, server, tool, annotations)) deny.add(agyMcpRule(`${server}/${tool}`));
    }
  }
  for (const server of catalog.unlistable) {
    if (!connectorToolAllowed(policy, server, "*", null)) deny.add(agyMcpRule(`${server}/*`));
  }
  return { allow: policy.connectors.extraAllow.map(agyMcpRule), deny: [...deny] };
}

/** agy 的 --settings 内容（只读）：permissions 的放行、拒绝规则，关掉 agy 自带的终端沙箱（外层沙箱里不能嵌套，实测开着命令 exit 71）。 */
export function agyReadonlySettings(
  policy: ReadonlyPolicy,
  connectors: AgyConnectorRules = { allow: [], deny: [] },
  realpath: (p: string) => string = realpathOrSelf,
): { permissions: { allow: string[]; deny: string[] }; enableTerminalSandbox: false } {
  const secretRules = policy.secretPaths.flatMap((p) => {
    const real = trimSlash(realpath(p));
    return [`read_file(${real})`, `read_file(${real}/*)`];
  });
  return {
    permissions: {
      allow: [...AGY_READONLY_ALLOW_RULES, ...connectors.allow],
      deny: [...AGY_READONLY_DENY_RULES, ...secretRules, ...connectors.deny],
    },
    enableTerminalSandbox: false,
  };
}

/** 工具名是 mcp_<服务器>_<工具>（agy 把少量 MCP 工具直接露出来）时，用来比：服务器、工具名里的非字母数字都换成 _。 */
function mcpFlatName(server: string, tool: string): string {
  return `mcp_${server}_${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
}

/** 连接器调用的违规说明；没有违规 null。 */
export function connectorViolationMessage(server: string, tool: string): string {
  return `只读 Worker 只能用只读的连接器工具，${server}/${tool} 不是（没标 readOnlyHint 或没在放行清单里）`;
}

/**
 * 兜底检查（驱动在工具开始调用时看）：这个工具调用是连接器的，不在放行范围就返回违规说明，否则 null。
 * - call_mcp_tool：参数 ServerName、ToolName（实测）；
 * - mcp_<服务器>_<工具>：按清单反查（服务器、工具名里的 -、. 会被换成 _，按换过的比）；清单里没有的当不是只读（拒）；
 * - 别的内置工具不管（写靠规则和外层沙箱）。
 * 清单里查不到的工具按“没标记”算：手动补充的放行，别的拒。
 */
export function checkAgyConnectorCall(
  toolName: string,
  parameters: unknown,
  policy: Pick<ReadonlyPolicy, "connectors">,
  catalog: AgyConnectorCatalog,
): string | null {
  const annotationsOf = (server: string, tool: string): ConnectorToolAnnotations | null => catalog.servers[server]?.[tool] ?? null;
  if (toolName === "call_mcp_tool") {
    const p = typeof parameters === "object" && parameters !== null ? (parameters as Record<string, unknown>) : {};
    const server = typeof p.ServerName === "string" ? p.ServerName : "";
    const tool = typeof p.ToolName === "string" ? p.ToolName : "";
    if (server === "" || tool === "") return connectorViolationMessage(server || "?", tool || "?");
    return connectorToolAllowed(policy, server, tool, annotationsOf(server, tool)) ? null : connectorViolationMessage(server, tool);
  }
  if (!toolName.startsWith("mcp_")) return null;
  for (const [server, tools] of Object.entries(catalog.servers)) {
    for (const tool of Object.keys(tools)) {
      if (mcpFlatName(server, tool) === toolName) return connectorToolAllowed(policy, server, tool, tools[tool]) ? null : connectorViolationMessage(server, tool);
    }
  }
  // 清单里没有（新连上的服务器、清单没问到）：名字拆不开，按“<名字>/<名字>”给手动清单看，放行不了就拒
  return connectorToolAllowed(policy, toolName, toolName, null) ? null : connectorViolationMessage(toolName, toolName);
}

// ---- 被拒后补一轮 ----

/** result.denied_actions 里每一项的一行描述（形状没定死：字符串，或带 tool_name / name / action / command 之类的对象）。 */
export function describeDeniedAction(action: unknown): string {
  if (typeof action === "string") return action;
  if (typeof action !== "object" || action === null) return String(action);
  const o = action as Record<string, unknown>;
  for (const key of ["tool_name", "toolName", "name", "action", "tool", "command"]) {
    const v = o[key];
    if (typeof v === "string" && v !== "") {
      const detail = typeof o.reason === "string" && o.reason !== "" ? `（${o.reason}）` : "";
      return `${v}${detail}`;
    }
  }
  const json = JSON.stringify(action);
  return json.length > 120 ? `${json.slice(0, 120)}…` : json;
}

/** result 里 denied_actions 的描述列表；没有或空数组返回 []。 */
export function deniedActionsOf(result: Record<string, unknown>): string[] {
  const raw = result.denied_actions;
  return Array.isArray(raw) ? raw.map(describeDeniedAction) : [];
}

/** 补发的那一条：告诉 agy 上一步被拒了，换办法继续（只读和非只读都用）。 */
export function deniedContinueText(actions: readonly string[]): string {
  return `上一步里的 ${actions.join("、")} 被权限拒绝了（只读模式或没有批准），所以这一轮没有结果。换别的办法继续完成任务，不要再调用被拒的这个；确实做不了就直接说明做不了什么、已经做了什么。`;
}
