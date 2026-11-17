import { describe, it } from "vitest";

describe("capabilityEnabled", () => {
  it.todo("有单独设置时用单独设置");
  it.todo("没有单独设置时按这一类的 base");
});

describe("applyCapabilitiesPatch", () => {
  it.todo("不改入参，返回新 policy");
  it.todo("值和 base 相同的项从 overrides 去掉");
  it.todo("set 给 null 去掉这一项的单独设置");
  it.todo("改 base 时去掉和新 base 相同的已有单独设置");
});

describe("resolveSessionCapabilities", () => {
  it.todo("三类都是 all 且没有关掉的项时返回 null");
  it.todo("只算这家能看到的项");
  it.todo("连接器只算这家自己账号上的");
  it.todo("插件里的项全关时进 deny.plugins，不再逐项列");
  it.todo("allow.skills 是开着的技能及其目录");
  it.todo("deny、allow 按名字排序，同样的输入结果逐字相同");
});

describe("capabilityKey", () => {
  it.todo("连接器的键带厂商编号，技能和 MCP 不带");
});
