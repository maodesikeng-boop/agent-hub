import { describe, it } from "vitest";

describe("createLedgerTurnReplies：afterDriverEvent", () => {
  it.todo("项目经理处理一条用户消息，这一轮写了两段文字：消息变 replied 时 meta.replyId 是后一段的编号，同一个事务里推 message.updated");
  it.todo("这一轮只调了工具、没写文字：消息变 replied，但不写 replyId");
  it.todo("子代理（parentToolUseId）的文字不算正式回复");
  it.todo("写交接那一轮（meta.handover）的文字不算正式回复");
  it.todo("消息在上一轮进行中排队，下一轮才送达：上一轮在它入库之后写的文字不算它的回复");
  it.todo("一轮同时处理两条用户消息（批量入队或中途送达）：两条的 replyId 是同一条回复");
  it.todo("这一轮被停止、被取消或失败：不写 replyId（复现 #76089：只说了一句『我查一下』就被下一条消息打断）");
  it.todo("下一条用户消息那一轮的回复不会挂到上一条已停止的消息上");
  it.todo("同一个 turn.ended 重放两次（重复推送）：replyId 不变，不重复推 message.updated");
  it.todo("已经有 replyId 的消息不会被后来的轮次改写");
  it.todo("Worker 会话、总助单轮会话的事件不写 replyId");
  it.todo("会话退出（session.exited）后在途记录清空，内存里不留这个会话");
});

describe("createLedgerTurnReplies：turnReplyOf", () => {
  it.todo("项目经理对话里有 replyId 的用户消息：返回原消息和回复");
  it.todo("还在处理中：返回原消息，reply 是 null");
  it.todo("回复已被清理：reply 是 null");
  it.todo("消息不存在、不是用户消息、在 Worker 对话里：返回 null");
});
