import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * 新来的消息淡入（docs/ui-standard.md 第 14 条，样子在 styles.css 的 .message-enter）：只给对话打开之后新出现在列表末尾的那几条加类，
 * 播完就摘掉。首次加载历史、往上翻页加载更早的、重新渲染都不播。
 *
 * 做法：每次提交后只看列表末尾 ENTER_WINDOW 项的 key（和上一次提交比），从末尾往前数到第一个上次就在的 key 为止，中间的就是新来的。
 * 在窗口里找不到上次的 key（整页换了、一下来了一批历史）就当没有新来的。开销只跟窗口大小有关，和历史条数无关。
 * key 是消息的身份（用户消息用 dedupeKey，和网页先显示的待发消息是同一个），所以待发消息被服务端确认、换成真消息时不会再播一次。
 */

/** 一次提交里新出现在末尾的项最多认这么多；比这多就当是整页换了（首次加载历史），不播。 */
const ENTER_WINDOW = 12;
const ENTER_CLASS = "message-enter";
const ENTER_ANIMATION = "message-enter";

export interface EnterItem {
  /** 身份：同一条消息前后两次渲染一样（待发和确认后的用户消息也一样）。 */
  key: string;
  /** agent 的一轮回复：如果是替掉了“正在想”那一行冒出来的（头像和名字已经在了），不再播。 */
  turn: boolean;
}

interface Snapshot {
  tail: ReadonlySet<string>;
  typing: boolean;
  /** 上次是“已经确定是空的”对话（不是还在拉历史）：第一条消息来了要播。 */
  settledEmpty: boolean;
}

const prefersReducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function play(el: Element) {
  el.classList.add(ENTER_CLASS);
  const done = (e: Event) => {
    // 子元素的动画（流光、转圈）结束也会冒泡上来，只认自己的
    if (e.target !== el || (e as AnimationEvent).animationName !== ENTER_ANIMATION) return;
    el.classList.remove(ENTER_CLASS);
    el.removeEventListener("animationend", done);
    el.removeEventListener("animationcancel", done);
  };
  el.addEventListener("animationend", done);
  el.addEventListener("animationcancel", done);
}

/**
 * container 的直接子元素依次是：leading 个别的元素（“加载更早”按钮、空对话）→ count 项每项一个元素（itemAt 取第几项，只会取末尾的几项）→
 * （typing 时）最后一个“正在想”的一轮。子元素个数对不上（某项没渲染出东西）就这次不播，不会播到别的消息上。
 * settledEmpty：这次渲染的对话确定是空的（没有消息、没有待发、不在忙、没有更早的）。
 */
export function useMessageEnter(
  container: RefObject<HTMLElement | null>,
  leading: number,
  count: number,
  itemAt: (index: number) => EnterItem,
  typing: boolean,
  settledEmpty: boolean,
): void {
  const prev = useRef<Snapshot | null>(null);
  useLayoutEffect(() => {
    const before = prev.current;
    const tailStart = Math.max(0, count - ENTER_WINDOW);
    const tailItems: EnterItem[] = [];
    for (let i = tailStart; i < count; i++) tailItems.push(itemAt(i));
    const tail = new Set(tailItems.map((item) => item.key));
    prev.current = { tail, typing, settledEmpty };
    const el = container.current;
    if (before === null || el === null || prefersReducedMotion()) return;

    const fresh: number[] = [];
    let anchored = false;
    for (let i = count - 1; i >= tailStart; i--) {
      if (before.tail.has(tailItems[i - tailStart]!.key)) {
        anchored = true;
        break;
      }
      fresh.push(i);
    }
    // 上次是空对话：从头开始的都是新来的（新对话里的第一句）
    if (!anchored && before.settledEmpty && before.tail.size === 0 && fresh.length === count) anchored = true;

    const children = el.children;
    if (children.length !== leading + count + (typing ? 1 : 0)) return;
    const offset = leading;
    if (anchored) {
      // “正在想”那一行被 agent 的这一轮替掉：头像和名字已经在那了，不再淡入一次
      const replacedTyping = before.typing && !typing;
      for (const i of fresh) {
        if (replacedTyping && tailItems[i - tailStart]!.turn) continue;
        const child = children[offset + i];
        if (child) play(child);
      }
    }
    if (typing && !before.typing) {
      const last = children[children.length - 1];
      if (last) play(last);
    }
  });
}
