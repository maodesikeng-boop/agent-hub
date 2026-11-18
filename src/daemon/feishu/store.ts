// 飞书的绑定与投影（迁移 0034：feishu_app、feishu_chats、feishu_posts、feishu_avatars；docs/feishu-design.md）。
// 不变量：
// - App Secret 不在这里（secrets.ts）；
// - feishu_posts 是“账本里的这样东西发到了飞书的哪条消息、哪张卡片实体”，同一个 ref 只有一行，重发、定稿、改定案、补发都先查它；
// - 换应用时四张表在一个事务里清空。
import type { MessageId, PmId, RouterCommandId, RouterItemId } from "../../shared/domain.ts";
import type {
  FeishuAppId,
  FeishuBrandName,
  FeishuCardId,
  FeishuChatId,
  FeishuChatTarget,
  FeishuGuestTier,
  FeishuImageKey,
  FeishuMessageId,
  FeishuOpenId,
  FeishuTriggerMode,
} from "../../shared/feishu.ts";
import type { Db } from "../store/index.ts";
import type { PmFruit } from "./avatars.ts";

export interface FeishuAppRecord {
  appId: FeishuAppId;
  brand: FeishuBrandName;
  botOpenId: FeishuOpenId;
  botName: string;
  ownerOpenId: FeishuOpenId | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface FeishuChatBinding {
  chatId: FeishuChatId;
  /** 项目经理删掉后 target 仍是 pm、pmId 为 null，等下一次对齐 retire。 */
  target: FeishuChatTarget | { kind: "pm"; pmId: null };
  name: string;
  label: string;
  avatarFruit: PmFruit | null;
  triggerMode: FeishuTriggerMode;
  guestTier: FeishuGuestTier;
  archivedAt: number | null;
  /** 已投影到这个会话的最大编号（项目群看消息，总助单聊看卡片和指令）；没有是 null。 */
  lastMessageId: MessageId | null;
  lastRouterItemId: RouterItemId | null;
  lastRouterCommandId: RouterCommandId | null;
}

/** 账本里的哪样东西：一条消息的第几张卡、第几个文件，总助的一张卡片、一条指令的回复，一个项目群的访客权限卡。 */
export type FeishuPostRef =
  | { kind: "message"; messageId: MessageId; part: number }
  | { kind: "file"; messageId: MessageId; part: number }
  | { kind: "router_item"; itemId: RouterItemId }
  | { kind: "router_command"; commandId: RouterCommandId }
  | { kind: "chat_policy"; pmId: PmId };

export const FEISHU_POST_STATES = ["streaming", "final", "card_pending", "card_settled"] as const;
export type FeishuPostState = (typeof FEISHU_POST_STATES)[number];

export interface FeishuPostRecord {
  ref: FeishuPostRef;
  chatId: FeishuChatId;
  messageId: FeishuMessageId;
  cardId: FeishuCardId | null;
  /** 这张卡片实体上一次操作的 sequence。 */
  sequence: number;
  state: FeishuPostState;
  updatedAt: number;
}

export interface FeishuStore {
  app(): FeishuAppRecord | null;
  /**
   * 后置：存下应用和机器人。appId 和已存的不同（换了应用）时先在同一个事务里清空四张表，ownerOpenId 取入参（可能为 null）。
   * appId 相同只更新机器人信息；入参 ownerOpenId 不为 null 且库里还没有主人时记下。
   */
  saveApp(
    input: { appId: FeishuAppId; brand: FeishuBrandName; botOpenId: FeishuOpenId; botName: string; ownerOpenId: FeishuOpenId | null },
    now: number,
  ): FeishuAppRecord;
  /** 前置：已有应用。后置：认下主人；已有主人时原样返回（换主人要先断开）。 */
  bindOwner(openId: FeishuOpenId, now: number): FeishuAppRecord;
  setEnabled(enabled: boolean, now: number): void;
  /** 后置：四张表清空。 */
  clear(): void;

  chats(): FeishuChatBinding[];
  chatById(chatId: FeishuChatId): FeishuChatBinding | null;
  chatOfTarget(target: FeishuChatTarget): FeishuChatBinding | null;
  /** 后置：同一个 target 只有一行（数据库唯一索引）；已有时更新会话编号和名字，唤醒方式和访客档位不动。 */
  upsertChat(input: { chatId: FeishuChatId; target: FeishuChatTarget; name: string; label: string }, now: number): FeishuChatBinding;
  /** label 不给时只记飞书里的新名字（用户在飞书里改的）。 */
  renameChat(chatId: FeishuChatId, name: string, label: string | null, now: number): void;
  setChatAvatar(chatId: FeishuChatId, fruit: PmFruit, now: number): void;
  /** 后置：只改给了的字段；返回改完的记录。没有这个项目经理的群抛错。 */
  setChatPolicy(pmId: PmId, policy: { triggerMode?: FeishuTriggerMode; guestTier?: FeishuGuestTier }, now: number): FeishuChatBinding;
  /** archivedAt 为 null 是取消归档。 */
  setChatArchived(chatId: FeishuChatId, archivedAt: number | null, now: number): void;
  /** 后置：删掉这一行和它的 feishu_posts（群被解散、机器人被移出、retire 之后）。 */
  removeChat(chatId: FeishuChatId): void;
  /** 后置：水位只往大了改，传更小的值不变。 */
  advanceWatermark(chatId: FeishuChatId, mark: { messageId?: MessageId; routerItemId?: RouterItemId; routerCommandId?: RouterCommandId }, now: number): void;

  postOf(ref: FeishuPostRef): FeishuPostRecord | null;
  /** 后置：按飞书消息编号找回是哪样东西（按钮点击时用）。 */
  postByMessageId(messageId: FeishuMessageId): FeishuPostRecord | null;
  /** 后置：同一个 ref 已有时覆盖消息编号、卡片编号、sequence、state（流式定稿、卡片定案）。sequence 不能比已存的小。 */
  savePost(record: Omit<FeishuPostRecord, "updatedAt">, now: number): void;
  /** 某个项目群里还在等拍板的卡（重连后对一遍账本现状）。 */
  pendingCards(pmId: PmId | null): FeishuPostRecord[];
  /** 后置：删掉 state 为 final / card_settled 且早于 before 的行，返回删了几行。等拍板的不删。 */
  prunePosts(before: number): number;

  avatarKey(fruit: PmFruit): FeishuImageKey | null;
  saveAvatarKey(fruit: PmFruit, imageKey: FeishuImageKey, now: number): void;
}

/** 前置：迁移 0034 已跑。 */
export function createFeishuStore(db: Db): FeishuStore {
  throw new Error("未实现");
}
