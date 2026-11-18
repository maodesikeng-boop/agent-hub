// 群成员和背景近窗（docs/feishu-design.md「性能」）：判断单人还是多人、查显示名、暂存没 @机器人 的话。全在内存里，有上限。
// 不变量：
// - 成员按群缓存，最多 FEISHU_CHAT_CACHE_MAX 个群（lru-cache）；成员事件实时改，连上和重连时整份标过期，
//   每 FEISHU_MEMBERS_TTL_MS 对一遍，查失败只记 FEISHU_MEMBERS_RETRY_MS，期间按 shared 处理（宁可多要一次 @，不把访客当主人）；
// - 发言人不是主人时，这个群立刻算 shared，不等对账（访客的话本身就证明群里有别人）；
// - 背景近窗每群最多 FEISHU_CONTEXT_MAX_LINES 行、FEISHU_CONTEXT_MAX_CHARS 字，超过丢最早的；超过 FEISHU_CONTEXT_TTL_MS 的行丢掉；
//   守护进程重启后近窗为空（不落库，只是背景）；
// - 群解散、机器人被移出、断开时清掉这个群的全部缓存。
import type { FeishuChatId, FeishuChatMode, FeishuContextLine, FeishuOpenId } from "../../shared/feishu.ts";

export interface FeishuMember {
  openId: FeishuOpenId;
  /** 群成员接口给的显示名，已截到 FEISHU_DISPLAY_NAME_MAX_CHARS 字。 */
  name: string;
}

export interface FeishuDirectory {
  /** 后置：有新鲜缓存时直接返回；过期或没有时调 fetch 拉全群成员（不含机器人）再返回。fetch 失败返回 null 并按重试间隔记下。 */
  members(chatId: FeishuChatId, now: number): Promise<FeishuMember[] | null>;
  /**
   * 后置：除主人以外没有别人时 solo；有别人、或成员查不到时 shared。
   * speaker 不是主人时直接返回 shared，并把 speaker 记进成员。
   */
  modeOf(chatId: FeishuChatId, owner: FeishuOpenId, speaker: FeishuOpenId | null, now: number): Promise<FeishuChatMode>;
  /** 后置：缓存里有这个人返回显示名，没有时拉一次群成员；还是没有返回 fallback。 */
  nameOf(chatId: FeishuChatId, openId: FeishuOpenId, fallback: string, now: number): Promise<string>;
  /** 成员进出事件：直接改缓存，不发请求。 */
  applyJoined(chatId: FeishuChatId, members: readonly FeishuMember[], now: number): void;
  applyLeft(chatId: FeishuChatId, openIds: readonly FeishuOpenId[], now: number): void;
  /** 连上或重连：全部标过期，下一次 members 时重拉。 */
  markAllStale(): void;
  forget(chatId: FeishuChatId): void;
  clear(): void;
}

export function createFeishuDirectory(fetch: (chatId: FeishuChatId) => Promise<FeishuMember[]>): FeishuDirectory {
  throw new Error("未实现");
}

export interface FeishuContextWindows {
  /** 后置：记下这一行；超出行数或字数上限时丢最早的。 */
  add(chatId: FeishuChatId, line: FeishuContextLine): void;
  /** 后置：返回这个群未过期的背景（按时间先后），不清空。 */
  peek(chatId: FeishuChatId, now: number): FeishuContextLine[];
  /** 后置：这一轮已送达，清空这个群的背景。 */
  clear(chatId: FeishuChatId): void;
  clearAll(): void;
}

export function createFeishuContextWindows(): FeishuContextWindows {
  throw new Error("未实现");
}
