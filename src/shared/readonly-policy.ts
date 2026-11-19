// 只读 Worker 的统一定义（docs/readonly-worker-design.md 第 2.2 节）：只回答“只读是什么”，跟厂商无关。
// 哪里都能读（密钥和数据目录除外，数据目录按读边界只放行几处）、命令能跑、哪里都不能写（会话私有临时目录除外）、连接器只能用只读工具。
// 各家怎么落实（claude 的权限和沙箱、agy 的 --settings 规则和外层沙箱、codex 的 readOnly 沙箱和 MCP 配置）是各自驱动层的翻译，
// 都从 LaunchFiles.readonly（这里的 ReadonlyPolicy）读，不再去反读 claude 的设置文件。
// 纯字符串处理、不用 node 模块；路径一律传已经 realpath 过的（macOS 上 /var 是 /private/var，沙箱和 agy 的规则按真实路径比）。

import { CREDENTIAL_HOME_PATHS } from "./secret-paths.ts";
import type { DataDirReadScope } from "./write-scope.ts";
import { VENDOR_LIST } from "../vendors/registry.ts";

/** 连接器工具的声明（MCP 规范的 annotations，服务器自报）。没有 annotations 当没标记。 */
export interface ConnectorToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export interface ReadonlyPolicy {
  /** 禁读的敏感路径（绝对路径，目录按子树算）：主目录里的凭据、各家厂商的令牌。各家都能表达。 */
  secretPaths: string[];
  /** 禁读的通配（如 **\/.env、**\/id_rsa*）。只有 claude 沙箱和 seatbelt 正则能表达，agy 的规则表达不了（设计第 5 节）。 */
  secretGlobs: string[];
  /**
   * 连接器：默认只放声明了 readOnlyHint 的；extraAllow 手动补充（没标或标错的），deny 手动排除（压过 extraAllow 和 readOnlyHint）。
   * 写法 "<服务器>/<工具>"，服务器和工具都可以是 *。
   */
  connectors: { extraAllow: string[]; deny: string[] };
  /** 可选的数据目录 state/ 真实路径（供外层只读回退定位 SID 与受保护根）。 */
  stateDir?: string;
  /** 可选的受保护根目录列表（含数据目录与跨卷同盘 `.fusa-wt`）。 */
  protectedRoots?: string[];
  /**
   * 数据目录读边界（shared/write-scope.ts 的 dataDirReadScope）：包整个进程的外层只读沙箱按它禁读整个数据目录，只放行几处
   * （worktrees、uploads、tools、run/bin、这次会话自己的启动目录），数据目录里只能连 hub.sock。启动准备（launch.ts、router/sandbox.ts）一定给。
   */
  dataDirScope?: DataDirReadScope;
  /**
   * 同一个边界展开成的禁读清单（daemon/driver/write-scope.ts 的 dataDirDenyList，列目录得到）：数据目录顶层除放行项外的每一项（state/ 整个）、
   * run/ 里除 bin、hub.sock 外的每一项。只管工具调用、表达不了“禁读区里再放行”的那几层用：claude 的 Read 规则和自带沙箱、codex 的权限档、agy 的规则。
   */
  dataDirDenied?: string[];
}

/**
 * 默认禁读的目录和文件，相对用户主目录（设计第 5 节，用户 11-07 定的：够用，不够再加）：
 * 凭据清单（secret-paths.ts，和分享禁用共用）+ 各家厂商的令牌文件（spec 的 home.readonlySecrets）。
 * 也不禁厂商目录里的会话记录（所以厂商只列令牌文件，不列整个目录）。数据目录（state/ 的令牌、密钥、库、记忆、日志等）不在这里逐个列，
 * 整个按 dataDirScope / dataDirDenied 禁读。
 */
export const READONLY_SECRET_HOME_PATHS: readonly string[] = [
  ...CREDENTIAL_HOME_PATHS,
  ...VENDOR_LIST.flatMap((spec) => spec.home.readonlySecrets),
];

/** 默认禁读的通配。 */
export const READONLY_SECRET_GLOBS: readonly string[] = ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/id_ed25519*"];

/** 连接器的手动补充/排除默认是空：标了 readOnlyHint 的自动放行，没标或标错的才往这里加一行（以后可以做成设置页）。 */
const READONLY_CONNECTORS: Readonly<ReadonlyPolicy["connectors"]> = { extraAllow: [], deny: [] };

export interface ReadonlyPolicyInput {
  /** 用户主目录（realpath 过）。 */
  homeDir: string;
  /** 数据目录 state/（realpath 过）。 */
  stateDir: string;
  /** 额外的受保护根目录（跨卷同盘 `.fusa-wt` 等）。 */
  protectedRoots?: readonly string[];
  /** 覆盖默认的补充/排除（设置页以后用）。 */
  connectors?: Partial<ReadonlyPolicy["connectors"]>;
  /** 这次会话的数据目录读边界（dataDirReadScope）。 */
  dataDirScope?: DataDirReadScope;
  /** 同一个边界展开成的禁读清单（dataDirDenyList）。 */
  dataDirDenied?: readonly string[];
}

function joinPath(base: string, rel: string): string {
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}${rel.replace(/\//g, sep)}`;
}

/** 按默认清单生成这台机器的只读策略。每次返回新对象（调用方可以放心改）。 */
export function buildReadonlyPolicy(input: ReadonlyPolicyInput): ReadonlyPolicy {
  return {
    secretPaths: READONLY_SECRET_HOME_PATHS.map((p) => joinPath(input.homeDir, p)),
    secretGlobs: [...READONLY_SECRET_GLOBS],
    stateDir: input.stateDir,
    connectors: {
      extraAllow: [...(input.connectors?.extraAllow ?? READONLY_CONNECTORS.extraAllow)],
      deny: [...(input.connectors?.deny ?? READONLY_CONNECTORS.deny)],
    },
    ...(input.protectedRoots && input.protectedRoots.length > 0
      ? { protectedRoots: [...input.protectedRoots] }
      : {}),
    ...(input.dataDirScope === undefined
      ? {}
      : { dataDirScope: { ...input.dataDirScope, readable: [...input.dataDirScope.readable], connectable: [...input.dataDirScope.connectable] } }),
    ...(input.dataDirDenied === undefined ? {} : { dataDirDenied: [...input.dataDirDenied] }),
  };
}

/** "<服务器>/<工具>" 匹配：每一段相等或者是 *；没有 / 的写法当 "<服务器>/*"。 */
function connectorRuleMatches(rule: string, server: string, tool: string): boolean {
  const slash = rule.indexOf("/");
  const ruleServer = slash < 0 ? rule : rule.slice(0, slash);
  const ruleTool = slash < 0 ? "*" : rule.slice(slash + 1);
  return (ruleServer === "*" || ruleServer === server) && (ruleTool === "*" || ruleTool === tool);
}

/**
 * 只读 Worker 能不能用这个连接器工具（三家共用的判断）：
 * 手动排除的一律不行；手动补充的行；否则只有声明了 readOnlyHint: true 且没声明 destructiveHint: true 的行，没标记的不行。
 */
export function connectorToolAllowed(
  policy: Pick<ReadonlyPolicy, "connectors">,
  server: string,
  tool: string,
  annotations: ConnectorToolAnnotations | null | undefined,
): boolean {
  const { extraAllow, deny } = policy.connectors;
  if (deny.some((rule) => connectorRuleMatches(rule, server, tool))) return false;
  if (extraAllow.some((rule) => connectorRuleMatches(rule, server, tool))) return true;
  return annotations?.readOnlyHint === true && annotations.destructiveHint !== true;
}
