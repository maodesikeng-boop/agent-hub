import { describe, it } from "vitest";

describe("encodeSlackActionValue / decodeSlackActionValue", () => {
  it.todo("每种动作编码后解码等于原值，编码后不超过 2,000 字");
  it.todo("被改过的、缺字段的、老版本的值解码返回 null");
});

describe("renderAskCard", () => {
  it.todo("等拍板的提问卡每个选项一个按钮，推荐项排第一并带星标，另有“补充说明”按钮");
  it.todo("检查点卡是“通过 / 打回”两个按钮，打回打开填写原因的弹窗");
  it.todo("提醒卡（blockerRef）只有 Done 按钮");
  it.todo("已回答的卡没有按钮，写明谁选了什么和补充说明；被关掉的写明已关掉");
  it.todo("正文用 markdown 块，超过 SLACK_MESSAGE_MAX_CHARS 截断并提示去网页看全文");
});

describe("renderRouterItem", () => {
  it.todo("简报写摘要和链接");
  it.todo("带 askMessageId 的拍板项只写摘要和项目经理频道里那张卡的链接，没有按钮");
  it.todo("没有 askMessageId 的拍板项带选项按钮");
});

describe("renderStopButton", () => {
  it.todo("按钮值解码出 stop 和这个对话的编号");
});
