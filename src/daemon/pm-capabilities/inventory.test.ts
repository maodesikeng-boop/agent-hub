import { describe, it } from "vitest";

describe("createCapabilityInventory", () => {
  it.todo("合并各厂商同名技能和 MCP 为一项，vendors 列出能看到它的几家");
  it.todo("云端连接器按厂商分开算，键带厂商编号");
  it.todo("给了 projectDir 时含项目技能，分组 source 为 project");
  it.todo("插件里的技能和 MCP 归到插件分组");
  it.todo("缓存有效期内返回同一个对象");
  it.todo("技能目录或配置文件的 mtime 变了，下一次 get 重新扫描");
  it.todo("一家扫描失败时其余几家照常返回，失败结果只缓存 PM_CAPABILITY_INVENTORY_RETRY_MS");
  it.todo("超过 PM_CAPABILITY_INVENTORY_MAX_ITEMS 时截断并标 truncated");
  it.todo("invalidate 后重新扫描");
  it.todo("扫描不写任何用户配置文件");
});
