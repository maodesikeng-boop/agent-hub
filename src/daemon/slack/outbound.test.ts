import { describe, it } from "vitest";

describe("projectSlackChange", () => {
  it.todo("pm.created、pm.updated、pm.removed 出 sync_channels");
  it.todo("有频道的项目经理对话的 session.status 带 streamingText 出 stream；回到 idle、ended、broken 出 turn_end");
  it.todo("项目经理的文字消息出 agent_text，带 meta 里的文件");
  it.todo("hub ask 发的消息出 ask_card；它被回答或关掉后的 message.updated 出 ask_settled");
  it.todo("网页发的用户消息出 mirror_user；带 origin 的（从 Slack 来的）不出");
  it.todo("工具调用、Worker 汇报行、Worker 对话里的消息、写交接的消息、只给人看的系统消息都不出意图");
  it.todo("router.item.created、router.item.updated 出 router_item");
  it.todo("router.command.updated 只在 answered、dispatched、failed 时出 router_command");
  it.todo("没有对应频道的变化不出意图");
});

describe("catchUpIntents", () => {
  it.todo("最多出 SLACK_CATCHUP_MAX_MESSAGES 条，取最新的，omitted 写更早的条数");
  it.todo("lastMessageId 是给的消息里最大的编号，没有消息时是 null");
});

describe("splitSlackMarkdown", () => {
  it.todo("不超过 SLACK_MESSAGE_MAX_CHARS 的原样一段，空正文返回空数组");
  it.todo("超长时在空行或换行处断，每段不超过上限");
  it.todo("必须在代码块中间断时补上闭合和重新打开的围栏，去掉补的围栏后拼回等于原文");
});
