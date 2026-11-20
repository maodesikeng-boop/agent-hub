import { useLayoutEffect, useRef } from "react";

const ENTER_WINDOW = 12;
const ENTER_CLASS = "message-enter";
const ENTER_ANIMATION = "message-enter";

export interface EnterItem {
  key: string;
  turn: boolean;
}

export interface EnterRows {
  row: (index: number) => Element | null | undefined;
  typingRow: Element | null | undefined;
}

/** Rows rendered as direct children after `leading` fixed elements; null while the DOM and the item count disagree. */
export function childRows(container: HTMLElement | null, leading: number, count: number, typing: boolean): EnterRows | null {
  if (container === null) return null;
  const children = container.children;
  if (children.length !== leading + count + (typing ? 1 : 0)) return null;
  return { row: (index) => children[leading + index], typingRow: typing ? children[children.length - 1] : null };
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
  rowsOf: () => EnterRows | null,
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
    if (before === null || prefersReducedMotion()) return;
    const rows = rowsOf();
    if (rows === null) return;

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

    if (anchored) {
      const replacedTyping = before.typing && !typing;
      for (const i of fresh) {
        if (replacedTyping && tailItems[i - tailStart]!.turn) continue;
        const row = rows.row(i);
        if (row) play(row);
      }
    }
    if (typing && !before.typing && rows.typingRow) play(rows.typingRow);
  });
}
