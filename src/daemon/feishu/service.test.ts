import { describe, it } from "vitest";

// 用假的传输层（FeishuTransport）和真的账本跑，不连飞书。

describe("createFeishuService：接入与建群", () => {
  it.todo("扫码接入后给每个未归档项目经理建私有对话群：群名是项目经理名字、头像是它的水果、主人是群主、群说明带标记");
  it.todo("建群请求带同一个 uuid；崩在建好还没记下之间，重启后按群说明的标记认回来，不多建");
  it.todo("新建项目经理建群、改名改群名、归档群名加（已归档）、取消归档改回、删掉后 retire；重复收到同一变化不多建群");
  it.todo("没配过凭证时 start 不连飞书，网页和 agent 照常");
  it.todo("凭证失效时状态变 auth_failed，不重试，不往账本抛错");
});

describe("createFeishuService：唤醒规则", () => {
  it.todo("群里只有主人时，主人不 @机器人 说的话进账本，发给 agent 时没有署名");
  it.todo("拉进访客后，没 @机器人 的话不进账本，记成背景；@机器人 的那句进账本，带署名和之前的背景，背景随后清空");
  it.todo("访客离开后自动回到单人直聊");
  it.todo("群设成 mention_only 后，只有主人一人时也要 @机器人");
  it.todo("应用没开 im:message.group_msg 时所有群按 mention_only，访客权限卡不给切回 auto");
  it.todo("同一条飞书消息重推只进账本一次");
});

describe("createFeishuService：访客权限", () => {
  it.todo("第一个访客进群时群里发一张访客权限卡；主人点按钮改档位，访客点收到 toast");
  it.todo("chat_only 档访客点拍板、停止只收到 toast，账本不变；发的文件不收");
  it.todo("collaborator 档访客点拍板记进账本，点停止能停，发的文件收成附件");
  it.todo("observer 档访客说话不进账本、不记背景");
  it.todo("任何档访客的话触发的那一轮里项目经理调 project.attach 被账本拒绝");
  it.todo("别人私聊机器人被拒，不进总助");
});

describe("createFeishuService：流式、急停与卡片", () => {
  it.todo("项目经理回复时在群主聊天流发一张流式卡片，随流式推全文，落库后正文等于账本这段文字、关流式、停止按钮去掉");
  it.todo("整个流程里假传输层收到的发送都没有 reply_in_thread，也不是回复某条消息");
  it.todo("超过 FEISHU_CARD_MAX_CHARS 的回复定稿成多张卡，拼起来等于账本这段文字");
  it.todo("主人点停止调 requestStop，回 toast，这一轮停下后卡片收尾");
  it.todo("hub ask 的卡片在群里带按钮；主人在飞书点选项后账本记下回答，网页上这张卡同时变成已回答");
  it.todo("网页上回答的卡片，飞书里那张改成已定案、按钮去掉；改两次结果相同");
  it.todo("网页上发的用户消息镜像到群里，标明来自网页");
  it.todo("项目经理发的文件、卡片的交付物发成群里的图片和文件消息，同一个文件只传一次");
  it.todo("三个项目经理同时流式回复时，每秒卡片接口调用不超过 FEISHU_CARDKIT_BUDGET_PER_SECOND，每个群每秒发送不超过 FEISHU_CHAT_SENDS_PER_SECOND");
});

describe("createFeishuService：总助单聊", () => {
  it.todo("主人在单聊里说的话交给 submitCommand，结果作为新卡片发在单聊里");
  it.todo("简报发到单聊；带提问卡的拍板项只发摘要和打开项目群的按钮");
});

describe("createFeishuService：断线与补发", () => {
  it.todo("重连后对一遍群成员，补发离线期间的消息，最多 FEISHU_CATCHUP_MAX_MESSAGES 条，更早的发一行提示");
  it.todo("重连后把离线期间在网页上回答的卡片改成已定案");
  it.todo("排队超过 FEISHU_OUTBOUND_QUEUE_MAX 时先合并同一张卡的流式推送，不丢定稿和卡片");
});
