// 出站投影（docs/slack-design.md）：账本的一条变化要不要在 Slack 里体现、体现成什么。只决定“要什么”，不发请求。
// 不变量：
// - 账本是唯一的真相：Slack 里的每条机器人消息都对应账本里的一样东西（slack_posts 的 ref），反过来不要求；
// - 遵守静默规矩：工具调用、Worker 汇报行、Worker 对话、后台写交接、只给人看的系统消息都不发；
// - 网页上发的用户消息照样镜像到频道里（标明“网页”），两边看到的对话一致；从 Slack 来的用户消息不再镜像回去。
import type { Change } from "../../shared/api.ts";
import type { ConversationId, Message, MessageId, PmId } from "../../shared/domain.ts";
import type { Deliverable } from "../../shared/deliverables.ts";
import type { RouterCommandRecord, RouterItem } from "../../shared/router.ts";
import type { SentFile } from "../../shared/sent-files.ts";
import type { SlackChannelBinding } from "./store.ts";

export type SlackOutboundIntent =
  /** 账本里的项目经理或总助频道要对齐一遍（项目经理建了、改名、归档、取消归档、删了）。 */
  | { kind: "sync_channels" }
  /** 项目经理正在写的这一段文字（内存里的流式预览）。text 是到目前为止的全文。 */
  | { kind: "stream"; conversationId: ConversationId; text: string }
  /** 一段文字落库了：流式的那条定稿，没流式过的直接发。 */
  | { kind: "agent_text"; conversationId: ConversationId; message: Message; files: SentFile[] }
  /** 这一轮结束（会话回到空闲）：收掉还开着的流式消息，去掉“停止”按钮。 */
  | { kind: "turn_end"; conversationId: ConversationId }
  /** 网页上发的用户消息。 */
  | { kind: "mirror_user"; conversationId: ConversationId; message: Message }
  /** 新的提问卡。 */
  | { kind: "ask_card"; conversationId: ConversationId; message: Message; deliverables: Deliverable[] }
  /** 提问卡的状态变了（回答了、关掉了、替换了）：Slack 原消息改成定案的样子。 */
  | { kind: "ask_settled"; conversationId: ConversationId; message: Message }
  /** 总助的卡片：新的简报或拍板项，或它的状态变了。 */
  | { kind: "router_item"; item: RouterItem }
  /** 总助指令有了结果（回答、已分派、失败）：回在发指令的那条消息下面；网页发的指令连同原话一起镜像。 */
  | { kind: "router_command"; command: RouterCommandRecord };

export interface SlackProjectionContext {
  /** 项目经理对话 → 它的频道；不是项目经理对话（Worker 对话、老项目群）或还没建频道是 null。 */
  channelOfConversation(conversationId: ConversationId): SlackChannelBinding | null;
  /** 总助频道；还没建是 null。 */
  routerChannel(): SlackChannelBinding | null;
  /** 项目经理对话属于哪个项目经理（判断是不是项目经理对话）。 */
  pmOfConversation(conversationId: ConversationId): PmId | null;
}

/**
 * 后置：按不变量把一条变化变成零个或多个意图：
 * - pm.created / pm.updated / pm.removed → sync_channels；
 * - session.status 带 streamingText 且会话属于有频道的项目经理对话 → stream；状态回到 idle / ended / broken → turn_end；
 * - message.created：项目经理的文字消息 → agent_text（带 meta 里的 SentFile）；askOf 不为 null → ask_card；
 *   没有 origin 的用户消息 → mirror_user；其余 → 无；
 * - message.updated：askOf 不为 null 且已回答或关掉 → ask_settled；
 * - router.item.created / updated → router_item；router.command.updated 且状态是 answered / dispatched / failed → router_command。
 * 没有对应频道的变化一律不出意图。
 */
export function projectSlackChange(change: Change, ctx: SlackProjectionContext): SlackOutboundIntent[] {
  throw new Error("未实现");
}

/**
 * 重连或重启后补发：项目经理频道里 lastMessageId 之后、属于这个对话的消息（调用方按编号从小到大给）。
 * 后置：最多 SLACK_CATCHUP_MAX_MESSAGES 条意图（取最新的）；更早还有的，omitted 写条数，调用方发一行“还有 N 条，去网页看”。
 */
export function catchUpIntents(
  conversationId: ConversationId,
  messages: readonly Message[],
): { intents: SlackOutboundIntent[]; omitted: number; lastMessageId: MessageId | null } {
  throw new Error("未实现");
}

/**
 * 后置：把 Markdown 正文按 SLACK_MESSAGE_MAX_CHARS 拆成几段，优先在空行、换行处断，不在代码块中间断
 * （必须断时在断点补上闭合和重新打开的代码围栏）。空正文返回空数组。拼回去等于原文（去掉补的围栏）。
 */
export function splitSlackMarkdown(text: string): string[] {
  throw new Error("未实现");
}
