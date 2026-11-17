// 入站边界（docs/slack-design.md）：Socket Mode 的原始信封在这里变成领域事件，之后的代码不再碰 Slack 的原始 JSON。
// 不变量：
// - 机器人自己发的、别的机器人发的、改消息、删消息、频道加入提示这类子类型一律丢掉；
// - 别的工作区的人（Slack Connect 共享频道，team 不是本工作区）丢掉，不进领域；
// - 同一条 Slack 消息重投（retry_attempt）解析出同一个事件，幂等由下游按频道 + ts 做。
import type { SlackChannelId, SlackTeamId, SlackTs, SlackUserId } from "../../shared/slack.ts";
import type { SlackActionValue } from "./cards.ts";
import type { SlackRawEnvelope } from "./transport.ts";

export interface SlackInboundFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  /** 用机器人令牌才能下载的地址。 */
  urlPrivate: string;
}

export type SlackInbound =
  | {
      kind: "message";
      /** group：私密频道；im：和机器人的单聊（只用来发绑定码）。 */
      channelType: "group" | "im";
      channelId: SlackChannelId;
      userId: SlackUserId;
      ts: SlackTs;
      /** 是不是发在某条消息的串里。Fusa 只看频道主聊天流，串里的话不交给 agent（routing.ts）。 */
      inThread: boolean;
      /** 原文，去掉了 <@机器人>（@ 不 @ 机器人都一样送达）。 */
      text: string;
      files: SlackInboundFile[];
    }
  | {
      kind: "action";
      channelId: SlackChannelId;
      userId: SlackUserId;
      /** 按钮所在的那条消息。 */
      messageTs: SlackTs;
      /** 这次点击的时间戳，同一次点击重投时不变。 */
      actionTs: string;
      /** 打开弹窗要用，几秒内有效。 */
      triggerId: string;
      action: SlackActionValue;
    }
  | {
      kind: "note_submitted";
      userId: SlackUserId;
      /** 弹窗的编号，同一次提交重投时不变。 */
      viewId: string;
      action: Extract<SlackActionValue, { kind: "open_note" }>;
      note: string;
    }
  | { kind: "membership"; channelId: SlackChannelId; userId: SlackUserId; joined: boolean }
  | { kind: "channel"; channelId: SlackChannelId; change: "renamed" | "archived" | "unarchived"; name: string | null };

export interface SlackSelf {
  teamId: SlackTeamId;
  botUserId: SlackUserId;
}

/**
 * 后置：认得的、和 Fusa 有关的信封返回一个领域事件；其余（不变量里要丢的、不认识的类型、形状不对）返回 null，不抛错。
 * 文字里的 <@机器人> 去掉；按钮值过 decodeSlackActionValue，解不出返回 null。
 */
export function parseSlackEnvelope(envelope: SlackRawEnvelope, self: SlackSelf): SlackInbound | null {
  throw new Error("未实现");
}
