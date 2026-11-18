// 总助时间流里转交问题下面的项目经理回复（docs/router-forward-reply-design.md，docs/ui-standard.md 第 21 条“转交回复”）。
// 回复正文用项目经理对话里同一个 MessageBubble 画，包在目标设备的 DeviceScopeOf 里，文件链接、预览按那台设备的。
import type { ConversationId } from "../../shared/domain.ts";
import type { HubClient } from "../client.ts";
import type { DeviceStoreLookup } from "../forward-reply.ts";
import type { RouterTurnDestination } from "../router-stream.ts";

/**
 * 前置：dest.forwardMessageId 不是 null。
 * 后置：按 useForwardReply 的状态画：
 * waiting：项目经理头像和名字，下面一行 Working…；
 * replied：头像和名字，下面是回复正文和交付文件，结尾一行复制键和回复的时间；
 * ended：头像和名字，下面一行 Stopped，失败时是红色感叹号和原因；
 * silent、unknown：什么都不画。
 * 头像和名字整块可点，打开这个项目经理的对话。
 */
export function ForwardReply(props: {
  dest: RouterTurnDestination;
  stores: DeviceStoreLookup;
  client: HubClient;
  onOpenConversation: (deviceKey: string, conversationId: ConversationId) => void;
}): React.ReactNode {
  throw new Error("未实现");
}
