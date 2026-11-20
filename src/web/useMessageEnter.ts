import { useLayoutEffect, useRef, type RefObject } from "react";

const ENTER_WINDOW = 12;
const ENTER_CLASS = "message-enter";
const ENTER_ANIMATION = "message-enter";

export interface EnterItem {
  key: string;
  turn: boolean;
}

interface Snapshot {
  tail: ReadonlySet<string>;
  typing: boolean;
  settledEmpty: boolean;
}

const prefersReducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function play(el: Element) {
  el.classList.add(ENTER_CLASS);
  const done = (e: Event) => {
    if (e.target !== el || (e as AnimationEvent).animationName !== ENTER_ANIMATION) return;
    el.classList.remove(ENTER_CLASS);
    el.removeEventListener("animationend", done);
    el.removeEventListener("animationcancel", done);
  };
  el.addEventListener("animationend", done);
  el.addEventListener("animationcancel", done);
}

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
    if (!anchored && before.settledEmpty && before.tail.size === 0 && fresh.length === count) anchored = true;

    const children = el.children;
    if (children.length !== leading + count + (typing ? 1 : 0)) return;
    const offset = leading;
    if (anchored) {
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
