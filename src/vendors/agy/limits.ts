// agy 专属的可调数（公共的在 src/shared/limits.ts）。

/**
 * 产品提示词写成规则文件时每个文件正文的上限（字节）：agy 1.5.5 实测单个规则文件超过 24,000 字节的部分被截掉
 * （<truncated N bytes>），留出 frontmatter 和余量取 20,000。项目经理的提示词现在最长约 44KB，切 3 块。
 */
export const AGY_RULE_FILE_MAX_BYTES = 20_000;
/**
 * 规则文件最多几块（3 × 20,000 字节）：agy 1.5.5 实测所有规则（项目的 AGENTS.md/GEMINI.md、全局的、各个 --add-dir 的）合起来
 * 约 60,000 字节的总预算，超了从排在最前面的丢起（项目工作目录的 AGENTS.md 排在 --add-dir 的规则前面，会先被丢）。
 * 项目经理的提示词现在最长约 45KB（性格设定截到 25KB），3 块装得下；再长的部分截掉并在最后一块末尾写明，不去挤更多。
 */
export const AGY_RULE_FILES_MAX = 3;

/** agy 驱动：一轮因为“被拒”（result 里 denied_actions 非空）又没回复就结束时，最多自动补几轮（防死循环）；用户发了新消息重新数。 */
export const AGY_DENIED_CONTINUE_MAX = 3;
/** agy 只读 Worker：启动前问每个 MCP 服务器要工具清单（拿 readOnlyHint）最多等多久，超时这个服务器整个当不可用（拒）。 */
export const AGY_CONNECTOR_LIST_TIMEOUT_MS = 10_000;
/** agy 只读 Worker：各 MCP 服务器的工具清单缓存多久（配置变了马上失效）。 */
export const AGY_CONNECTOR_CACHE_MS = 10 * 60_000;
/** agy 只读 Worker：有服务器没问到工具清单（超时、报错，那个服务器整个拒）时，清单只记这么久，偶发失败不会拒 10 分钟。 */
export const AGY_CONNECTOR_RETRY_MS = 60_000;

/** agy 1.5.5 规则区实测预算，超过时只告警。 */
export const AGY_RULE_TOTAL_BUDGET_BYTES = 60_000;
export const AGY_RULE_SINGLE_BUDGET_BYTES = 24_000;
