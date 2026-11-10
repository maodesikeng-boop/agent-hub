// 只读 Worker 的 claude 翻译（docs/readonly-worker-design.md 第 2.3 节 claude 一列）：统一策略（readonly-policy.ts）→ --settings 里的权限规则和 claude 自带沙箱。
// 做法：default 模式 + 驱动用 --permission-prompt-tool stdio 接 can_use_tool（src/vendors/claude/readonly.ts 按 annotations 判断连接器工具）；
// 内置的读、搜、命令、上网放行，编辑工具拒绝；写不了的硬保证靠 claude 自带沙箱（writeGuard native，进程不再包外层沙箱，macOS 沙箱不能嵌套）。
// 可调的东西都在这个文件：放行哪些内置工具、沙箱开哪些开关。纯字符串处理。
import type { ReadonlyPolicy } from "./readonly-policy.ts";

/** 不是 dontAsk（要批准的一律拒，连读 /tmp 都不行）也不是 plan（Bash 写文件不拦）：要批准的发 can_use_tool 给驱动。 */
export const CLAUDE_READONLY_PERMISSION_MODE = "default";
/** 放行的内置工具：读、搜、命令（写由沙箱挡）、上网。连接器工具不在这里：按 annotations 现场判断。 */
export const CLAUDE_READONLY_ALLOW_TOOLS = ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"] as const;
/** 拒绝的内置工具：三个编辑工具。 */
export const CLAUDE_READONLY_DENY_TOOLS = ["Edit", "Write", "NotebookEdit"] as const;

/** 权限规则里的绝对路径：// 开头，路径里的 \ [ ] * ? 前面加 \ 转义（跟 policy.ts 的 stateDirDenyRule 一样）。 */
function absoluteRulePath(path: string): string {
  return `/${path.replace(/\/+$/, "").replace(/[\\[\]*?]/g, "\\$&")}`;
}

/** "<服务器>/<工具>" 写成 claude 的拒绝规则；服务器是 * 的写不成规则（返回 null，留给驱动判断）；没有 / 的当 "<服务器>/*"。 */
function connectorDenyRule(rule: string): string | null {
  const slash = rule.indexOf("/");
  const server = slash < 0 ? rule : rule.slice(0, slash);
  const tool = slash < 0 ? "*" : rule.slice(slash + 1);
  if (server === "*") return null;
  return tool === "*" ? `mcp__${server}` : `mcp__${server}__${tool}`;
}

/**
 * 权限规则：放行内置读/命令/上网（hub 命令的放行规则由 policy.ts 的 buildSessionSettings 加，两种角色都有）；拒绝编辑工具、读密钥（路径和通配，claude 还会拿它查 Bash 命令行里写明的路径）、手动排除的连接器。
 * 手动补充的连接器不写进放行规则：驱动在 can_use_tool 里判断时查 extraAllow（连接器的判断只有一处）。每次返回新数组。
 */
export function claudeReadonlyPermissions(policy: ReadonlyPolicy): { allow: string[]; deny: string[] } {
  const deny: string[] = [...CLAUDE_READONLY_DENY_TOOLS];
  for (const path of policy.secretPaths) deny.push(`Read(${absoluteRulePath(path)})`, `Read(${absoluteRulePath(path)}/**)`);
  for (const glob of policy.secretGlobs) deny.push(`Read(//${glob})`);
  for (const rule of policy.connectors.deny) {
    const denyRule = connectorDenyRule(rule);
    if (denyRule !== null) deny.push(denyRule);
  }
  return { allow: [...CLAUDE_READONLY_ALLOW_TOOLS], deny };
}

export interface ClaudeReadonlySandboxInput {
  /** 工作目录和 add-dir 的真实路径：默认只有它们和 TMPDIR 能写，denyWrite 把它们盖住（实测 S1：别处本来就写不了）。 */
  denyWrite: string[];
  /** hub.sock 的真实路径：放行，只读 Worker 才能敲 hub（实测 S6）。 */
  hubSock: string;
}

/** claude 的 sandbox 段（只读档）。 */
export interface ClaudeReadonlySandbox {
  enabled: true;
  failIfUnavailable: true;
  allowUnsandboxedCommands: false;
  autoAllowBashIfSandboxed: true;
  enableWeakerNetworkIsolation: true;
  filesystem: { denyWrite: string[]; denyRead: string[] };
  network: { allowedDomains: string[]; allowUnixSockets: string[] };
}

/**
 * claude 自带沙箱（只读档）：
 * - 起不来就报错（failIfUnavailable）、不许绕出沙箱（allowUnsandboxedCommands: false）；
 * - denyRead：密钥路径，和通配（**\/ 开头的换成绝对根 /**\/：实测 S3 里 <绝对路径>/**\/.env 的写法有效）；
 * - 网络：域名全放（只读 Worker 能联网，设计第 8 节第 1 条；curl、git 实测能通）；
 * - enableWeakerNetworkIsolation：macOS 沙箱放行 mach 服务 com.apple.trustd.agent。gh 等 Go 程序在 macOS 上用系统证书服务（trustd）验 TLS 证书，
 *   沙箱挡了它就报 `tls: failed to verify certificate: x509: OSStatus -26276`（curl、git 用自带的证书库所以没事）。
 *   claude 文档说这样“开了一个经 trustd 外发数据的口子”，只读 Worker 本来就能联网读到什么都能外发，不多担风险；不整体关沙箱。
 */
export function claudeReadonlySandbox(policy: ReadonlyPolicy, input: ClaudeReadonlySandboxInput): ClaudeReadonlySandbox {
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    autoAllowBashIfSandboxed: true,
    enableWeakerNetworkIsolation: true,
    filesystem: {
      denyWrite: [...input.denyWrite],
      denyRead: [...policy.secretPaths, ...policy.secretGlobs.map((glob) => (glob.startsWith("**/") ? `/${glob}` : glob))],
    },
    network: { allowedDomains: ["*"], allowUnixSockets: [input.hubSock] },
  };
}
