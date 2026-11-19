// 飞书的绑定与投影（迁移 0034：feishu_app、feishu_chats、feishu_posts、feishu_avatars，0035 给 feishu_posts 加附件，0037 给 feishu_avatars 记图片内容哈希，
// 0039 群头像改按形象认；docs/feishu-design.md）。
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
import { isOneOf } from "../../shared/domain.ts";
import { FEISHU_GUEST_TIERS, FEISHU_TRIGGER_MODES } from "../../shared/feishu.ts";
import { FEISHU_PAGE_SIZE } from "../../shared/limits.ts";
import type { FeishuCardRef } from "./cards.ts";
import type { Db } from "../store/index.ts";
import { lookKey, parseLookKey, type SlimeLook } from "../../shared/slimes.ts";

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
  /** 群头像现在是哪个形象；没设过、或这个形象画出来的图换了还没给这个群换上（clearChatAvatars）是 null。 */
  avatarLook: SlimeLook | null;
  triggerMode: FeishuTriggerMode;
  guestTier: FeishuGuestTier;
  /** 项目经理归档、群已解散的时间；取消归档重建群时作为建群 uuid 的 generation。 */
  archivedAt: number | null;
  /** 已投影到这个会话的最大编号（项目群看消息，总助单聊看卡片和指令）；没有是 null。 */
  lastMessageId: MessageId | null;
  lastRouterEventId: number | null;
}

/** 账本里的哪样东西：一条消息的第几张卡、第几个文件，总助的一张卡片、一条指令的回复，一个项目群的访客权限卡。 */
export type FeishuPostRef =
  | { kind: "message"; messageId: MessageId; part: number }
  | { kind: "file"; messageId: MessageId; part: number }
  | { kind: "router_item"; itemId: RouterItemId }
  | { kind: "router_command"; commandId: RouterCommandId; part?: number }
  | { kind: "chat_policy"; pmId: PmId }
  | { kind: "router_settings" };

export const FEISHU_POST_STATES = ["streaming", "final", "card_pending", "card_settled", "uploading"] as const;
export type FeishuPostState = (typeof FEISHU_POST_STATES)[number];

export interface FeishuPostRecord {
  ref: FeishuPostRef;
  chatId: FeishuChatId;
  messageId: FeishuMessageId;
  cardId: FeishuCardId | null;
  /** 这张卡片实体上一次操作的 sequence。 */
  sequence: number;
  state: FeishuPostState;
  /** file 行：嵌进卡片的图片编号或发出去的文件编号；没传上是 null（uploading 行带编号表示传完、文件也发了，只差改卡）。别的行是 null。 */
  mediaKey: string | null;
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
  /**
   * 后置：同一个 target 只有一行（数据库唯一索引）；已有时换成新的会话编号和名字（取消归档重建的群），
   * 旧群的 feishu_posts 和补发水位一并清掉，archivedAt 回到 null，唤醒方式和访客档位不动。
   */
  upsertChat(input: { chatId: FeishuChatId; target: FeishuChatTarget; name: string; label: string }, now: number): FeishuChatBinding;
  /** label 不给时只记飞书里的新名字（用户在飞书里改的）。 */
  renameChat(chatId: FeishuChatId, name: string, label: string | null, now: number): void;
  setChatAvatar(chatId: FeishuChatId, look: SlimeLook, now: number): void;
  /** 后置：头像是这个形象的群全部改回“没设过”（这个形象画出来的图换了，下一次对齐给它们原地换上）。 */
  clearChatAvatars(look: SlimeLook, now: number): void;
  /** 后置：只改给了的字段；返回改完的记录。没有这个项目经理的群抛错。 */
  setChatPolicy(pmId: PmId, policy: { triggerMode?: FeishuTriggerMode; guestTier?: FeishuGuestTier }, now: number): FeishuChatBinding;
  /** 后置：群已解散，记下归档时间；这个群的 feishu_posts 删掉（消息随群没了）。 */
  setChatArchived(chatId: FeishuChatId, archivedAt: number, now: number): void;
  /** 后置：删掉这一行和它的 feishu_posts（retire 之后；或群被别人解散、机器人被移出，下一次对齐重建）。 */
  removeChat(chatId: FeishuChatId): void;
  /** 后置：水位只往大了改，传更小的值不变。 */
  advanceWatermark(chatId: FeishuChatId, mark: { messageId?: MessageId; routerEventId?: number }, now: number): void;

  /** 后置：水位推到 id，删掉编号不大于它的事件。 */
  ackRouterEvent(chatId: FeishuChatId, id: number, now: number): void;
  /** after 之后的事件超过 keep 条时，返回要跳过的条数和其中最后一条的编号；没超过是 null。 */
  routerEventBacklog(after: number, keep: number): { skipped: number; lastSkippedId: number } | null;
  routerEventsAfter(after: number, limit: number): { id: number; item_id: RouterItemId | null; command_id: RouterCommandId | null }[];
  decision(ref: FeishuCardRef): { clientId: string; name: string } | null;
  saveDecision(ref: FeishuCardRef, clientId: string, name: string, now: number): void;

  postOf(ref: FeishuPostRef): FeishuPostRecord | null;
  /** 后置：按飞书消息编号找回是哪张卡（按钮点击时用）；file 行（附件挂在卡上时记着卡的消息编号）不算。 */
  postByMessageId(messageId: FeishuMessageId): FeishuPostRecord | null;
  /** 后置：同一个 ref 已有时覆盖消息编号、卡片编号、sequence、state、mediaKey（流式定稿、卡片定案、附件传完）。sequence 不能比已存的小。mediaKey 不给是 null。 */
  savePost(record: Omit<FeishuPostRecord, "updatedAt" | "mediaKey"> & { mediaKey?: string | null }, now: number): void;
  /** 某个项目群里还在等拍板的卡（重连后对一遍账本现状）。 */
  pendingCards(pmId: PmId | null): Iterable<FeishuPostRecord>;
  /** 某个群里还停在 streaming 的卡（定稿没做完就停机、重启），按记下的先后最多 limit 张。 */
  streamingPosts(chatId: FeishuChatId, limit: number): FeishuPostRecord[];
  /** 某个群里卡已发出、还没传完的附件（停机、重启后接着补传），按记下的先后最多 limit 个。 */
  uploadingPosts(chatId: FeishuChatId, limit: number): FeishuPostRecord[];
  /** 后置：删掉 state 为 final / card_settled 且早于 before 的行，返回删了几行。等拍板的不删。 */
  prunePosts(before: number): number;

  /** 后置：这个形象记下的 image_key，只有记下的图片内容哈希和 hash 相同才返回；没传过、图片换了都是 null。 */
  avatarKey(look: SlimeLook, hash: string): FeishuImageKey | null;
  saveAvatarKey(look: SlimeLook, imageKey: FeishuImageKey, hash: string, now: number): void;
}

/** 前置：迁移 0035 已跑。 */
export function createFeishuStore(db: Db): FeishuStore {
  const app = (): FeishuAppRecord | null => {
    const row = db.get<AppRow>("SELECT * FROM feishu_app WHERE id = 1");
    return row === undefined ? null : toApp(row);
  };
  const chatWhere = (where: string, ...params: (string | number)[]): FeishuChatBinding | null => {
    const row = db.get<ChatRow>(`SELECT * FROM feishu_chats WHERE ${where}`, ...params);
    return row === undefined ? null : toChat(row);
  };
  const chatById = (chatId: FeishuChatId) => chatWhere("chat_id = ?", chatId);
  const mustChat = (chatId: FeishuChatId): FeishuChatBinding => {
    const chat = chatById(chatId);
    if (chat === null) throw new Error(`feishu chat ${chatId} not found`);
    return chat;
  };
  const chatOfTarget = (target: FeishuChatTarget) =>
    target.kind === "router" ? chatWhere("target = 'router'") : chatWhere("target = 'pm' AND pm_id = ?", target.pmId);
  const clear = () =>
    db.transaction(() => {
      for (const table of ["feishu_posts", "feishu_chats", "feishu_avatars", "feishu_router_events", "feishu_decisions", "feishu_app"]) db.run(`DELETE FROM ${table}`);
    });
  const postWhere = (where: string, ...params: (string | number)[]): FeishuPostRecord | null => {
    const row = db.get<PostRow>(`SELECT * FROM feishu_posts WHERE ${where}`, ...params);
    return row === undefined ? null : toPost(row);
  };
  const postOf = (ref: FeishuPostRef) => {
    const key = refKey(ref);
    return postWhere("ref_kind = ? AND ref_id = ? AND part = ?", key.kind, key.id, key.part);
  };

  return {
    app,
    saveApp(input, now) {
      return db.transaction(() => {
        const existing = app();
        if (existing !== null && existing.appId !== input.appId) clear();
        const kept = existing !== null && existing.appId === input.appId ? existing : null;
        const owner = kept?.ownerOpenId ?? input.ownerOpenId;
        db.run(
          `INSERT INTO feishu_app (id, app_id, brand, bot_open_id, bot_name, owner_open_id, enabled, created_at, updated_at)
           VALUES (1, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT (id) DO UPDATE SET brand = excluded.brand, bot_open_id = excluded.bot_open_id, bot_name = excluded.bot_name,
             owner_open_id = excluded.owner_open_id, updated_at = excluded.updated_at`,
          input.appId,
          input.brand,
          input.botOpenId,
          input.botName,
          owner,
          kept?.createdAt ?? now,
          now,
        );
        return app()!;
      });
    },
    bindOwner(openId, now) {
      const current = app();
      if (current === null) throw new Error("feishu app not configured");
      if (current.ownerOpenId !== null) return current;
      db.run("UPDATE feishu_app SET owner_open_id = ?, updated_at = ? WHERE id = 1", openId, now);
      return app()!;
    },
    setEnabled(enabled, now) {
      db.run("UPDATE feishu_app SET enabled = ?, updated_at = ? WHERE id = 1", enabled ? 1 : 0, now);
    },
    clear,

    chats: () => db.all<ChatRow>("SELECT * FROM feishu_chats ORDER BY target DESC, pm_id").map(toChat),
    chatById,
    chatOfTarget,
    upsertChat(input, now) {
      return db.transaction(() => {
        const existing = chatOfTarget(input.target);
        if (existing === null) {
          db.run(
            `INSERT INTO feishu_chats (chat_id, target, pm_id, name, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            input.chatId,
            input.target.kind,
            input.target.kind === "pm" ? input.target.pmId : null,
            input.name,
            input.label,
            now,
            now,
          );
        } else {
          if (existing.chatId !== input.chatId) db.run("DELETE FROM feishu_posts WHERE chat_id = ?", existing.chatId);
          db.run(
            `UPDATE feishu_chats SET chat_id = ?, name = ?, label = ?, archived_at = NULL,
               avatar_fruit = CASE WHEN chat_id = ? THEN avatar_fruit ELSE NULL END,
               last_message_id = CASE WHEN chat_id = ? THEN last_message_id ELSE NULL END,
               last_router_event_id = CASE WHEN chat_id = ? THEN last_router_event_id ELSE NULL END,
               updated_at = ?
             WHERE chat_id = ?`,
            input.chatId,
            input.name,
            input.label,
            input.chatId,
            input.chatId,
            input.chatId,
            now,
            existing.chatId,
          );
        }
        return mustChat(input.chatId);
      });
    },
    renameChat(chatId, name, label, now) {
      db.run("UPDATE feishu_chats SET name = ?, label = COALESCE(?, label), updated_at = ? WHERE chat_id = ?", name, label, now, chatId);
    },
    // avatar_fruit 这一列从 0039 起记形象键（lookKey），列名沿用
    setChatAvatar(chatId, look, now) {
      db.run("UPDATE feishu_chats SET avatar_fruit = ?, updated_at = ? WHERE chat_id = ?", lookKey(look), now, chatId);
    },
    clearChatAvatars(look, now) {
      db.run("UPDATE feishu_chats SET avatar_fruit = NULL, updated_at = ? WHERE avatar_fruit = ?", now, lookKey(look));
    },
    setChatPolicy(pmId, policy, now) {
      const chat = chatOfTarget({ kind: "pm", pmId });
      if (chat === null) throw new Error(`feishu chat of pm ${pmId} not found`);
      db.run(
        "UPDATE feishu_chats SET trigger_mode = COALESCE(?, trigger_mode), guest_tier = COALESCE(?, guest_tier), updated_at = ? WHERE chat_id = ?",
        policy.triggerMode ?? null,
        policy.guestTier ?? null,
        now,
        chat.chatId,
      );
      return mustChat(chat.chatId);
    },
    setChatArchived(chatId, archivedAt, now) {
      db.transaction(() => {
        db.run("DELETE FROM feishu_posts WHERE chat_id = ?", chatId);
        db.run("UPDATE feishu_chats SET archived_at = ?, updated_at = ? WHERE chat_id = ?", archivedAt, now, chatId);
      });
    },
    removeChat(chatId) {
      db.transaction(() => {
        if (chatById(chatId)?.target.kind === "router") db.run("DELETE FROM feishu_router_events");
        db.run("DELETE FROM feishu_chats WHERE chat_id = ?", chatId);
      });
    },
    advanceWatermark(chatId, mark, now) {
      db.run(
        `UPDATE feishu_chats SET
           last_message_id = CASE WHEN ? IS NULL THEN last_message_id ELSE MAX(COALESCE(last_message_id, -1), ?) END,
           last_router_event_id = CASE WHEN ? IS NULL THEN last_router_event_id ELSE MAX(COALESCE(last_router_event_id, -1), ?) END,
           updated_at = ?
         WHERE chat_id = ?`,
        mark.messageId ?? null,
        mark.messageId ?? null,
        mark.routerEventId ?? null,
        mark.routerEventId ?? null,
        now,
        chatId,
      );
    },

    ackRouterEvent(chatId, id, now) {
      db.transaction(() => {
        if (db.run("UPDATE feishu_chats SET last_router_event_id = ?, updated_at = ? WHERE chat_id = ?", id, now, chatId).changes > 0) {
          db.run("DELETE FROM feishu_router_events WHERE id <= ?", id);
        }
      });
    },
    routerEventBacklog(after, keep) {
      const { n } = db.get<{ n: number }>("SELECT count(*) AS n FROM feishu_router_events WHERE id > ?", after)!;
      if (n <= keep) return null;
      const last = db.get<{ id: number }>("SELECT id FROM feishu_router_events WHERE id > ? ORDER BY id LIMIT 1 OFFSET ?", after, n - keep - 1)!;
      return { skipped: n - keep, lastSkippedId: last.id };
    },
    routerEventsAfter: (after, limit) => db.all("SELECT id, item_id, command_id FROM feishu_router_events WHERE id > ? ORDER BY id LIMIT ?", after, limit),
    decision(ref) {
      const [kind, id] = decisionKey(ref);
      return db.get<{ clientId: string; name: string }>("SELECT client_id AS clientId, name FROM feishu_decisions WHERE ref_kind = ? AND ref_id = ?", kind, id) ?? null;
    },
    saveDecision(ref, clientId, name, now) {
      const [kind, id] = decisionKey(ref);
      db.run("INSERT INTO feishu_decisions VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING", kind, id, clientId, name, now);
    },
    postOf,
    postByMessageId: (messageId) => postWhere("message_id = ? AND ref_kind != 'file' ORDER BY updated_at DESC LIMIT 1", messageId),
    savePost(record, now) {
      const key = refKey(record.ref);
      db.transaction(() => {
        const existing = postOf(record.ref);
        if (existing !== null && record.sequence < existing.sequence) {
          throw new Error(`feishu post sequence went backwards: ${existing.sequence} -> ${record.sequence}`);
        }
        db.run(
          `INSERT INTO feishu_posts (ref_kind, ref_id, part, chat_id, message_id, card_id, sequence, state, media_key, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (ref_kind, ref_id, part) DO UPDATE SET chat_id = excluded.chat_id, message_id = excluded.message_id,
             card_id = excluded.card_id, sequence = excluded.sequence, state = excluded.state, media_key = excluded.media_key, updated_at = excluded.updated_at`,
          key.kind,
          key.id,
          key.part,
          record.chatId,
          record.messageId,
          record.cardId,
          record.sequence,
          record.state,
          record.mediaKey ?? null,
          now,
        );
      });
    },
    *pendingCards(pmId) {
      const chat = chatOfTarget(pmId === null ? { kind: "router" } : { kind: "pm", pmId });
      if (chat === null) return;
      let cursor = 0;
      for (;;) {
        const rows = db.all<PostRow & { cursor: number }>(`SELECT rowid AS cursor, * FROM feishu_posts
          WHERE chat_id = ? AND state = 'card_pending' AND rowid > ? ORDER BY rowid LIMIT ?`, chat.chatId, cursor, FEISHU_PAGE_SIZE);
        for (const row of rows) {
          cursor = row.cursor;
          yield toPost(row);
        }
        if (rows.length < FEISHU_PAGE_SIZE) return;
      }
    },
    streamingPosts(chatId, limit) {
      return db.all<PostRow>("SELECT * FROM feishu_posts WHERE chat_id = ? AND state = 'streaming' ORDER BY rowid LIMIT ?", chatId, limit).map(toPost);
    },
    uploadingPosts(chatId, limit) {
      return db.all<PostRow>("SELECT * FROM feishu_posts WHERE chat_id = ? AND state = 'uploading' ORDER BY rowid LIMIT ?", chatId, limit).map(toPost);
    },
    prunePosts(before) {
      db.run("DELETE FROM feishu_decisions WHERE decided_at < ?", before);
      return db.run("DELETE FROM feishu_posts WHERE state IN ('final', 'card_settled') AND updated_at < ?", before).changes;
    },

    avatarKey(look, hash) {
      const row = db.get<{ image_key: string }>("SELECT image_key FROM feishu_avatars WHERE look = ? AND content_sha256 = ?", lookKey(look), hash);
      return row === undefined ? null : (row.image_key as FeishuImageKey);
    },
    saveAvatarKey(look, imageKey, hash, now) {
      db.run(
        `INSERT INTO feishu_avatars (look, image_key, content_sha256, uploaded_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (look) DO UPDATE SET image_key = excluded.image_key, content_sha256 = excluded.content_sha256, uploaded_at = excluded.uploaded_at`,
        lookKey(look),
        imageKey,
        hash,
        now,
      );
    },
  };
}

interface AppRow {
  app_id: string;
  brand: string;
  bot_open_id: string;
  bot_name: string;
  owner_open_id: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

interface ChatRow {
  chat_id: string;
  target: string;
  pm_id: number | null;
  name: string;
  label: string;
  avatar_fruit: string | null;
  trigger_mode: string;
  guest_tier: string;
  archived_at: number | null;
  last_message_id: number | null;
  last_router_event_id: number | null;
}

interface PostRow {
  ref_kind: string;
  ref_id: number;
  part: number;
  chat_id: string;
  message_id: string;
  card_id: string | null;
  sequence: number;
  state: string;
  media_key: string | null;
  updated_at: number;
}

function toApp(row: AppRow): FeishuAppRecord {
  return {
    appId: row.app_id as FeishuAppId,
    brand: row.brand as FeishuBrandName,
    botOpenId: row.bot_open_id as FeishuOpenId,
    botName: row.bot_name,
    ownerOpenId: row.owner_open_id as FeishuOpenId | null,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 水位 0 表示“从头开始投影、还没发过东西”，和 null（还没开始记）不同。 */
const watermark = (value: number | null) => (value === null || value < 0 ? null : value);

function toChat(row: ChatRow): FeishuChatBinding {
  return {
    chatId: row.chat_id as FeishuChatId,
    target: row.target === "router" ? { kind: "router" } : { kind: "pm", pmId: row.pm_id },
    name: row.name,
    label: row.label,
    avatarLook: row.avatar_fruit === null ? null : parseLookKey(row.avatar_fruit),
    triggerMode: isOneOf(FEISHU_TRIGGER_MODES, row.trigger_mode) ? row.trigger_mode : "auto",
    guestTier: isOneOf(FEISHU_GUEST_TIERS, row.guest_tier) ? row.guest_tier : "chat_only",
    archivedAt: row.archived_at,
    lastMessageId: watermark(row.last_message_id),
    lastRouterEventId: watermark(row.last_router_event_id),
  };
}

function decisionKey(ref: FeishuCardRef): [string, number] {
  return ref.kind === "router_item" ? ["router_item", ref.itemId] : ["ask", ref.askMessageId];
}

function refKey(ref: FeishuPostRef): { kind: FeishuPostRef["kind"]; id: number; part: number } {
  switch (ref.kind) {
    case "message":
    case "file":
      return { kind: ref.kind, id: ref.messageId, part: ref.part };
    case "router_item":
      return { kind: ref.kind, id: ref.itemId, part: 0 };
    case "router_command":
      return { kind: ref.kind, id: ref.commandId, part: ref.part ?? 0 };
    case "chat_policy":
      return { kind: ref.kind, id: ref.pmId, part: 0 };
    case "router_settings":
      return { kind: ref.kind, id: 1, part: 0 };
  }
}

function toRef(row: PostRow): FeishuPostRef {
  switch (row.ref_kind) {
    case "message":
    case "file":
      return { kind: row.ref_kind, messageId: row.ref_id, part: row.part };
    case "router_item":
      return { kind: "router_item", itemId: row.ref_id };
    case "router_command":
      return { kind: "router_command", commandId: row.ref_id, ...(row.part > 0 ? { part: row.part } : {}) };
    default:
      return { kind: "chat_policy", pmId: row.ref_id };
  }
}

function toPost(row: PostRow): FeishuPostRecord {
  return {
    ref: toRef(row),
    chatId: row.chat_id as FeishuChatId,
    messageId: row.message_id as FeishuMessageId,
    cardId: row.card_id as FeishuCardId | null,
    sequence: row.sequence,
    state: row.state as FeishuPostState,
    mediaKey: row.media_key,
    updatedAt: row.updated_at,
  };
}
