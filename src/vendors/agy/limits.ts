// agy 专属的可调数（公共的在 src/shared/limits.ts）。

/** agy 驱动：一轮因为“被拒”（result 里 denied_actions 非空）又没回复就结束时，最多自动补几轮（防死循环）；用户发了新消息重新数。 */
export const AGY_DENIED_CONTINUE_MAX = 3;
/** agy 只读 Worker：启动前问每个 MCP 服务器要工具清单（拿 readOnlyHint）最多等多久，超时这个服务器整个当不可用（拒）。 */
export const AGY_CONNECTOR_LIST_TIMEOUT_MS = 10_000;
/** agy 只读 Worker：各 MCP 服务器的工具清单缓存多久（配置变了马上失效）。 */
export const AGY_CONNECTOR_CACHE_MS = 10 * 60_000;
/** agy 只读 Worker：有服务器没问到工具清单（超时、报错，那个服务器整个拒）时，清单只记这么久，偶发失败不会拒 10 分钟。 */
export const AGY_CONNECTOR_RETRY_MS = 60_000;
