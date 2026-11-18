import { describe, it } from "vitest";

describe("replyIdOf", () => {
  it.todo("用户消息 meta.replyId 是正整数时返回它");
  it.todo("agent 消息、系统消息、meta 是 null、replyId 不是正整数时返回 null");
});

describe("turnReplyStateOf", () => {
  it.todo("排队、已送达、处理中返回 waiting");
  it.todo("replied 且有回复返回 replied，带着那条回复");
  it.todo("replied 但 reply 是 null 返回 silent");
  it.todo("stopped、cancelled 返回 ended，reason 是 null");
  it.todo("failed 返回 ended，reason 是 failureReason");
  it.todo("同样的 request 和 reply 对象返回同一个结果对象");
});
