import { describe, it } from "vitest";

describe("按钮值编解码", () => {
  it.todo("每种 FeishuActionValue 编码后再解码深等于原值");
  it.todo("缺字段、类型不对、多出未知 kind 的值解码为 null");
});

describe("renderAskCard", () => {
  it.todo("pending 时有补充说明输入框和选项按钮，推荐项排第一并标推荐，点哪个选项都连同输入框回传");
  it.todo("检查点卡是通过 / 打回，提醒卡是已处理");
  it.todo("answered 时没有按钮，写明谁选了什么和补充说明；closed 时写明已关闭");
  it.todo("卡片 schema 是 2.0，update_multi 为 true");
});

describe("renderRouterItem", () => {
  it.todo("带 ask 的拍板项和项目群那张卡的按钮值解码出同一个 FeishuCardRef，另有打开项目群的按钮");
  it.todo("带 ask 的拍板项定案后和 renderAskCard 一样写明结论、没有按钮");
  it.todo("没有 ask 的拍板项带 router_item 的选项按钮；简报只有摘要和打开项目群的按钮");
});

describe("renderReplyCard", () => {
  it.todo("streaming 为 true 时开流式模式，正文组件的 element_id 是 FEISHU_STREAM_ELEMENT_ID");
  it.todo("withStop 时有停止按钮，按钮值解码为这个对话的 stop");
});

describe("renderChatPolicyCard", () => {
  it.todo("写明当前唤醒方式和访客档位，当前选中的按钮禁用，其余按钮值解码为 set_policy");
  it.todo("mentionOnlyForced 时不给切回 auto");
});
