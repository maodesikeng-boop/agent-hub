import { describe, it } from "vitest";

describe("desiredFeishuChats", () => {
  it.todo("每个项目经理一个（含已归档的），群名是项目经理名字，最长 60 字");
  it.todo("水果和网页上项目经理的头像一致；群说明带 feishuChatMarker");
});

describe("feishuChatMarker / feishuChatCreateUuid", () => {
  it.todo("同一组输入总是同一个值，不同项目经理不同");
  it.todo("generation 不同时 uuid 不同（取消归档重建的群不会被当成重复请求）");
  it.todo("uuid 不超过 50 字");
});

describe("planFeishuChatSync", () => {
  it.todo("没有记录的未归档项目经理 create（generation 0）；机器人所在群里有它的标记时 adopt，不新建");
  it.todo("没有记录的已归档项目经理什么都不做");
  it.todo("项目经理改名 rename；飞书里被人改了群名（label 没变）不改回去");
  it.todo("水果变了 set_avatar");
  it.todo("项目经理归档 → dissolve；已归档的记录不再出 rename、set_avatar");
  it.todo("取消归档 → create，generation 是记录的 archivedAt");
  it.todo("pm_id 为 null 的记录 retire，记录已归档时 dissolved 为 true");
  it.todo("已对齐时返回空数组；同一份输入算两次结果相同");
});
