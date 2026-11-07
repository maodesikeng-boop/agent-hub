// 只读 Worker 的统一定义（docs/readonly-worker-design.md 第 2.2 节）：只回答“只读是什么”，跟厂商无关。
// 哪里都能读（密钥除外）、命令能跑、哪里都不能写（会话私有临时目录除外）、连接器只能用只读工具。
// 各家怎么落实（claude 的权限和沙箱、agy 的 --settings 规则和外层沙箱、codex 的 readOnly 沙箱和 MCP 配置）是各自驱动层的翻译，
// 都从 LaunchFiles.readonly（这里的 ReadonlyPolicy）读，不再去反读 claude 的设置文件。
// 纯字符串处理、不用 node 模块；路径一律传已经 realpath 过的（macOS 上 /var 是 /private/var，沙箱和 agy 的规则按真实路径比）。

/** 连接器工具的声明（MCP 规范的 annotations，服务器自报）。没有 annotations 当没标记。 */
export interface ConnectorToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export interface ReadonlyPolicy {
  /** 禁读的敏感路径（绝对路径，目录按子树算）。各家都能表达。 */
  secretPaths: string[];
  /** 禁读的通配（如 **\/.env、**\/id_rsa*）。只有 claude 沙箱和 seatbelt 正则能表达，agy 的规则表达不了（设计第 5 节）。 */
  secretGlobs: string[];
  /**
   * 连接器：默认只放声明了 readOnlyHint 的；extraAllow 手动补充（没标或标错的），deny 手动排除（压过 extraAllow 和 readOnlyHint）。
   * 写法 "<服务器>/<工具>"，服务器和工具都可以是 *。
   */
  connectors: { extraAllow: string[]; deny: string[] };
}

/**
 * 默认禁读的目录和文件，相对用户主目录（设计第 5 节，用户 11-07 定的：够用，不够再加）。
 * 不禁 state/hub.sqlite 和日志：排查要读，这是统一只读的初衷（READONLY_SECRET_STATE_FILES 的注释写了数据库里查过的结果）。
 */
export const READONLY_SECRET_HOME_PATHS: readonly string[] = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".config/gh",
  ".config/gcloud",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".codex/auth.json",
  ".claude/.credentials.json",
  ".gemini/oauth_creds.json",
  "Library/Keychains",
];

/**
 * agent-hub 自己的令牌文件，相对数据目录 state/。
 * 2026-11-07 查过真实的 hub.sqlite（15 张表所有文本列）、日志和 launch/：
 * - 会话令牌（HUB_TOKEN）只在内存里和进程环境变量里，库里、文件里都没有；
 * - 界面令牌（ui-token）只在 state/ui-token 这个文件里，库里没有，所以文件在这里单独禁读，库不用；
 * - 库里没有任何一张表存了现行的令牌，所以没有要单独禁读的表（SQLite 是单个文件，也没法按表禁读）。
 *   只有 messages 的工具记录（text、meta）里留着别的守护进程（测试用）打印的登录链接 ?token=…，已经作废，不算。
 * 以后要在库里存令牌：先挪到 state/ 下单独的文件，再把文件名加到这里，别让只读 Worker 读到整库。
 */
export const READONLY_SECRET_STATE_FILES: readonly string[] = ["ui-token"];

/** 默认禁读的通配。 */
export const READONLY_SECRET_GLOBS: readonly string[] = ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/id_ed25519*"];

/** 连接器的手动补充/排除默认是空：标了 readOnlyHint 的自动放行，没标或标错的才往这里加一行（以后可以做成设置页）。 */
export const READONLY_CONNECTORS: Readonly<ReadonlyPolicy["connectors"]> = { extraAllow: [], deny: [] };

export interface ReadonlyPolicyInput {
  /** 用户主目录（realpath 过）。 */
  homeDir: string;
  /** 数据目录 state/（realpath 过）。 */
  stateDir: string;
  /** 覆盖默认的补充/排除（设置页以后用）。 */
  connectors?: Partial<ReadonlyPolicy["connectors"]>;
}

function joinPath(base: string, rel: string): string {
  return `${base.replace(/\/+$/, "")}/${rel}`;
}

/** 按默认清单生成这台机器的只读策略。每次返回新对象（调用方可以放心改）。 */
export function buildReadonlyPolicy(input: ReadonlyPolicyInput): ReadonlyPolicy {
  return {
    secretPaths: [
      ...READONLY_SECRET_HOME_PATHS.map((p) => joinPath(input.homeDir, p)),
      ...READONLY_SECRET_STATE_FILES.map((p) => joinPath(input.stateDir, p)),
    ],
    secretGlobs: [...READONLY_SECRET_GLOBS],
    connectors: {
      extraAllow: [...(input.connectors?.extraAllow ?? READONLY_CONNECTORS.extraAllow)],
      deny: [...(input.connectors?.deny ?? READONLY_CONNECTORS.deny)],
    },
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
