import { describe, it } from "vitest";

describe("desiredFeishuChats", () => {
  it.todo("每个项目经理一个，群名是项目经理名字，归档的加“（已归档）”，最长 60 字");
  it.todo("水果和网页上项目经理的头像一致；群说明带 feishuChatMarker");
});

describe("feishuChatMarker / feishuChatCreateUuid", () => {
  it.todo("同一组输入总是同一个值，不同项目经理不同");
  it.todo("uuid 不超过 50 字");
});

describe("planFeishuChatSync", () => {
  it.todo("没有记录的项目经理 create；机器人所在群里有它的标记时 adopt，不新建");
  it.todo("项目经理改名 rename；飞书里被人改了群名（label 没变）不改回去");
  it.todo("水果变了 set_avatar；归档 archive、取消归档 unarchive");
  it.todo("pm_id 为 null 的记录 retire");
  it.todo("已对齐时返回空数组；同一份输入算两次结果相同");
});
