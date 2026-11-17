import { describe, it } from "vitest";

describe("desiredSlackChannels", () => {
  it.todo("总助一个、每个项目经理一个，项目经理归档时 archived 为 true");
});

describe("slackChannelName", () => {
  it.todo("大写转小写，空格和标点换成“-”，保留中文");
  it.todo("超过 80 字截断");
  it.todo("规整完是空的返回纯 ASCII 的后备名字");
});

describe("planSlackChannelSync", () => {
  it.todo("没有记录的总助和项目经理各出一个 create");
  it.todo("项目经理改了名（label 变了）出 rename；用户只在 Slack 里改了频道名不出 rename");
  it.todo("项目经理归档出 archive，取消归档出 unarchive");
  it.todo("主人不在的未归档频道出 invite_owner");
  it.todo("已对齐时返回空数组；同一份输入算两次结果相同");
});
