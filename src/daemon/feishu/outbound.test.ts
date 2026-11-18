import { describe, it } from "vitest";

describe("projectFeishuChange", () => {
  it.todo("项目经理建了、改名、归档、删了 → sync_chats");
  it.todo("项目经理对话的流式预览 → stream；会话回到空闲 → turn_end");
  it.todo("项目经理的文字消息 → agent_text，带它发的文件");
  it.todo("提问卡 → ask_card；回答或关掉后 → ask_settled");
  it.todo("网页发的用户消息 → mirror_user；从飞书来的（带 origin）不镜像");
  it.todo("工具调用、Worker 汇报行、Worker 对话、交接、只给人看的系统消息不出意图");
  it.todo("总助卡片和指令结果出 router_item / router_command；没有对应会话的变化不出意图");
});

describe("catchUpIntents", () => {
  it.todo("最多 FEISHU_CATCHUP_MAX_MESSAGES 条，取最新的，更早的记 omitted");
  it.todo("lastMessageId 是给出消息里最大的编号；没有消息时是 null");
});

describe("splitFeishuMarkdown", () => {
  it.todo("不超过 FEISHU_CARD_MAX_CHARS 时原样一段；空正文返回空数组");
  it.todo("优先在空行、换行处断，每段不超过上限");
  it.todo("不在代码块中间断；必须断时补上闭合和重新打开的围栏，去掉补的围栏拼回等于原文");
});
