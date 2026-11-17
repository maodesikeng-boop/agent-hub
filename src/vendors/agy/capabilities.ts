// agy 按会话关 MCP（agy 1.5.9）：--settings 只对这次会话生效，permissions.deny 里写 mcp(<服务器>/*)，
// 服务器照起、工具调用被拒（只读 Worker 已在用同一套规则，readonly.ts）。技能和云端连接器没有按会话的开关，isolation 是 shared。
import type { SessionCapabilities } from "../../shared/pm-capabilities.ts";

/**
 * 后置：每个关掉的 MCP 一条 `mcp(<服务器>/*)`，按名字排序；deny.mcp 为空返回 []。
 * 调用方把它并进 --settings 的 permissions.deny（只读 Worker 的规则也在那里），不覆盖已有规则。
 */
export function agyCapabilityDenyRules(caps: SessionCapabilities): string[] {
  throw new Error("未实现");
}
