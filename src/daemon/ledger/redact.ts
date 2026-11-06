// hub worker show / log 的输出里不能带密钥、令牌：命令行、回复开头都可能带（curl -H "Authorization: Bearer …"、GH_TOKEN=…）。
// 只做常见形状的遮盖，是兜底，不保证认得出所有写法；原文不入库，入库前就遮好（steps.ts）。
export const REDACTED = "***";

/** [匹配, 替换]：按顺序一个个用；替换里 $1 保留前面的名字或前缀。 */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Authorization: Bearer xxx、Bearer xxx（头、命令行里）
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // 名字里带 token / secret / password / passwd / api_key / apikey / access_key / private_key / credential / auth 的赋值或参数：
  // FOO_TOKEN=xxx、--token xxx、--api-key=xxx、"password": "xxx"
  [
    /((?:[A-Za-z0-9_-]*(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_-]*)["']?\s*[=:]\s*["']?)(?!\$\(|\$\{|\$[A-Za-z_]|\*\*\*)[^\s"'&;|)]{4,}/gi,
    `$1${REDACTED}`,
  ],
  [/(--[A-Za-z0-9-]*(?:token|secret|passw(?:or)?d|api-?key|access-?key|credential)[A-Za-z0-9-]*\s+)(?!-|\$)[^\s"';|&]{4,}/gi, `$1${REDACTED}`],
  // curl -u user:password、--user user:password
  [/(\s(?:-u|--user)\s+[^\s:]+:)[^\s]+/g, `$1${REDACTED}`],
  // 常见的令牌前缀：GitHub、OpenAI/Anthropic、Slack、AWS、Google
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})\b/g, REDACTED],
  // URL 里的 user:password@
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, `$1${REDACTED}@`],
  // 三段式 JWT
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED],
];

export function redactSecrets(text: string): string {
  return PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}
