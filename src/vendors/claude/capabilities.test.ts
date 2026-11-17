import { describe, it } from "vitest";

describe("claudeCapabilitySettings", () => {
  it.todo("关掉的技能写成 skillOverrides 里的 off");
  it.todo("关掉的 MCP 和 claude.ai 云端连接器写成 deniedMcpServers 的 serverName");
  it.todo("整组关掉的插件写成 enabledPlugins 里的 false");
  it.todo("deny 全空时返回空对象，设置文件和现在逐字相同");
  it.todo("同样的输入键顺序相同，fingerprint 不变");
  it.todo("真机：带这份 --settings 起 claude，system/init 里看不到被关的技能、MCP 和连接器");
});
