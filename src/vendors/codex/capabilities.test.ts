import { describe, it } from "vitest";

describe("codexCapabilityArgs", () => {
  it.todo("关掉的技能合成一条 skills.config 覆盖，按名字禁用");
  it.todo("关掉的 MCP 各一条 mcp_servers.<名字>.enabled=false");
  it.todo("关掉的连接器各一条 apps.<编号>.enabled=false");
  it.todo("名字带点或空格的键段加引号");
  it.todo("deny 全空返回空数组");
  it.todo("真机：带这些参数起 app-server，skills/list 里该技能 enabled 为 false、app/list 里该连接器 isEnabled 为 false");
});
