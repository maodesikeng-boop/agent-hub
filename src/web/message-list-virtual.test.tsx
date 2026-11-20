import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, MessageId } from "../shared/index.ts";
import { defaultLookOf } from "../shared/slimes.ts";
import { MessageList } from "./components/MessageList.tsx";
import type { MessageActions } from "./components/Messages.tsx";
import { makeMessage, makeUserMessage } from "./test-utils.ts";

const actions: MessageActions = { retry: {}, onOpenWorker: () => {}, onRetryMessage: () => {}, onRevertPersona: () => Promise.resolve() };
const ROW_PX = 100;

let viewportPx = 400;
const scrollTops = new WeakMap<Element, number>();
const isLog = (el: Element) => el.getAttribute("role") === "log";
const listHeight = (el: Element) => Number.parseFloat((el.querySelector("[data-index]")?.parentElement as HTMLElement | null)?.style.height ?? "0");

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return isLog(this) ? viewportPx : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute("data-index") ? ROW_PX : 0;
  });
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    return isLog(this) ? listHeight(this) : 0;
  });
  vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
    return scrollTops.get(this) ?? 0;
  });
  vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (this: Element, value: number) {
    const max = Math.max(0, this.scrollHeight - this.clientHeight);
    scrollTops.set(this, Math.max(0, Math.min(value, max)));
  });
  Element.prototype.scrollTo = function (this: Element, options?: ScrollToOptions | number) {
    if (typeof options === "object" && options.top !== undefined) this.scrollTop = options.top;
    this.dispatchEvent(new Event("scroll"));
  } as Element["scrollTo"];
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  viewportPx = 400;
  vi.restoreAllMocks();
  delete (Element.prototype as Partial<Element>).scrollTo;
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

/** Alternating user and agent messages, so every message is its own row (a user bubble or a one-reply turn). */
const conversation = (rows: number): Message[] =>
  Array.from({ length: rows }, (_, i) => (i % 2 === 0 ? makeUserMessage({ id: i + 1, text: `question ${i + 1}` }) : makeMessage({ id: i + 1, text: `answer ${i + 1}` })));

function list(messages: Message[], focus: { id: MessageId; n: number } | null = null) {
  return (
    <MessageList
      messages={messages}
      pending={[]}
      agentOf={() => ({ name: "Lin", look: defaultLookOf(1) })}
      hasMore={false}
      older={undefined}
      onLoadOlder={() => {}}
      onRetry={() => {}}
      actions={actions}
      focus={focus}
      onFocusDone={() => {}}
    />
  );
}

const mountedRows = () => document.querySelectorAll("[data-index]").length;

describe("MessageList virtual rows", () => {
  it("mounts only the rows around the bottom of a long conversation", () => {
    render(list(conversation(300)));
    expect(mountedRows()).toBeGreaterThan(0);
    expect(mountedRows()).toBeLessThan(30);
    expect(screen.getByText("answer 300")).toBeInTheDocument();
    expect(screen.queryByText("question 1")).not.toBeInTheDocument();
  });

  it("jumping to an unmounted message scrolls its row into the window, then centers the message itself and highlights it", () => {
    const messages = conversation(300);
    const view = render(list(messages));
    expect(document.querySelector('[data-message-id="150"]')).toBeNull();
    view.rerender(list(messages, { id: 150, n: 1 }));
    const target = document.querySelector('[data-message-id="150"]');
    expect(target).not.toBeNull();
    expect(target).toHaveAttribute("data-highlighted", "true");
    const rowTop = Number.parseFloat(/translateY\((.+)px\)/.exec(target!.closest<HTMLElement>("[data-index]")!.style.transform)![1]!);
    expect(rowTop - screen.getByRole("log").scrollTop).toBe(viewportPx / 2);
  });

  it("a viewport without layout renders a bounded tail instead of a single row", () => {
    viewportPx = 0;
    render(list(conversation(250)));
    expect(mountedRows()).toBe(200);
    expect(screen.getByText("answer 250")).toBeInTheDocument();
    expect(screen.queryByText("question 1")).not.toBeInTheDocument();
  });

  it("keeps the row holding keyboard focus mounted after scrolling away", () => {
    render(list(conversation(300)));
    const lastRow = document.querySelector('[data-index="299"]')!;
    const focusable = lastRow.querySelector("button")!;
    act(() => focusable.focus());
    const log = screen.getByRole("log");
    act(() => {
      log.scrollTop = 0;
      fireEvent.scroll(log);
    });
    expect(screen.getByText("question 1")).toBeInTheDocument();
    expect(lastRow.isConnected).toBe(true);
    expect(document.activeElement).toBe(focusable);
  });
});
