import { describe, it } from "vitest";

describe("agyCapabilityDenyRules", () => {
  it.todo("每个关掉的 MCP 一条 mcp(<服务器>/*) 规则");
  it.todo("技能和连接器的 deny 不产生规则");
  it.todo("和只读 Worker 的规则合并后两边的规则都在");
  it.todo("deny.mcp 为空返回空数组");
});
