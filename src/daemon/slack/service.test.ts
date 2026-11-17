import { describe, it } from "vitest";

// 用假的传输层（SlackTransport）和真的账本跑，不连 Slack。

describe("createSlackService：接入与频道", () => {
  it.todo("主人私聊机器人发绑定码后认下主人，建总助频道和每个未归档项目经理的私密频道，并把主人拉进去");
  it.todo("新建项目经理建频道、改名改频道名、归档归档频道、取消归档取消归档；重复收到同一变化不多建频道");
  it.todo("没配过令牌时 start 不连 Slack，网页和 agent 照常");
  it.todo("令牌失效时状态变 auth_failed，不重试，不往账本抛错");
});

describe("createSlackService：单人直聊与多人共聊", () => {
  it.todo("单人频道里主人说的话进账本，meta.origin 的 mode 是 solo，发给 agent 时没有署名");
  it.todo("访客进频道后，主人和访客在主聊天流里的每句话都进账本（不用 @机器人），发给 agent 时带发言人署名和主客身份");
  it.todo("串里的话不进账本");
  it.todo("访客离开后自动回到单人直聊");
  it.todo("同一条 Slack 消息重投只进账本一次");
});

describe("createSlackService：主客权限", () => {
  it.todo("访客在总助频道说话不进账本，收到只有他看得见的提示");
  it.todo("访客点拍板按钮、停止按钮不改账本，收到只有他看得见的提示");
  it.todo("访客的消息触发的那一轮里项目经理调 project.attach 被账本拒绝");
});

describe("createSlackService：流式、急停与卡片", () => {
  it.todo("项目经理回复时先在频道主聊天流发一条带停止按钮的消息，随流式用 chat.update 更新，落库后正文等于账本里这段文字，停止按钮去掉");
  it.todo("整个流程里假传输层收到的发送都不带 thread_ts");
  it.todo("主人点停止调 requestStop，这一轮停下");
  it.todo("hub ask 的卡片在频道里带按钮；主人在 Slack 点选项后账本记下回答，网页上这张卡同时变成已回答");
  it.todo("网页上回答的卡片，Slack 原消息改成已定案，按钮去掉；改两次结果相同");
  it.todo("网页上发的用户消息镜像到频道，标明来自网页");
  it.todo("项目经理发的文件、卡片的交付物传成频道里的附件，同一个文件只传一次");
});

describe("createSlackService：总助频道", () => {
  it.todo("主人在总助频道说的话交给 submitCommand，回复作为新消息发在总助频道主聊天流里");
  it.todo("简报发到总助频道；带提问卡的拍板项只发摘要和项目经理频道里那张卡的链接");
});

describe("createSlackService：断线与补发", () => {
  it.todo("重连后对一遍频道成员，补发离线期间的消息，最多 SLACK_CATCHUP_MAX_MESSAGES 条，更早的发一行提示");
  it.todo("重连后把离线期间在网页上回答的卡片改成已定案");
  it.todo("排队超过 SLACK_OUTBOUND_QUEUE_MAX 时先合并同一条消息的流式刷新，不丢定稿和卡片");
});
