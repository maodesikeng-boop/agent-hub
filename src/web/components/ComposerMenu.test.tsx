import { act, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ComposerSource, FILE_SEARCH_DEBOUNCE_MS } from "../composer-suggest.ts";
import { useStagingStore } from "../upload.ts";
import { Composer } from "./Composer.tsx";

const COMMANDS = [
  { name: "review", description: "复查改动" },
  { name: "compact", description: "压缩上下文" },
  { name: "context", description: "看上下文用了多少" },
];

function source(over: Partial<ComposerSource> = {}): ComposerSource {
  return {
    commands: vi.fn(async () => COMMANDS),
    files: vi.fn(async () => ({ entries: [], truncated: false })),
    ...over,
  };
}

/** 草稿由外面存，和 App 里一样。 */
function Harness({ src, onSend = () => {}, initial = "" }: { src: ComposerSource | undefined; onSend?: (text: string, files: File[]) => void | Promise<void>; initial?: string }) {
  const [value, setValue] = useState(initial);
  const store = useStagingStore<number>();
  return <Composer value={value} placeholder="发消息" staging={store.of(1)} source={src} onChange={setValue} onSend={onSend} />;
}

const box = () => screen.getByRole("textbox", { name: "输入消息" }) as HTMLTextAreaElement;
const options = () => screen.queryAllByRole("option");
const active = () => options().find((o) => o.getAttribute("aria-selected") === "true");
let user: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  user = userEvent.setup();
});
const flush = () => act(async () => {});

describe("输入框 / 命令列表", () => {
  it("1 空输入框打 / 弹出列表，第一行高亮", async () => {
    render(<Harness src={source()} />);
    await user.type(box(), "/");
    expect(await screen.findByRole("listbox", { name: "命令" })).toBeInTheDocument();
    expect(options().map((o) => o.textContent)).toEqual(["/review复查改动", "/compact压缩上下文", "/context看上下文用了多少"]);
    expect(active()).toBe(options()[0]);
  });

  it("2 打 hi /co 不弹，也不去问后台", async () => {
    const src = source();
    render(<Harness src={src} />);
    await user.type(box(), "hi /co");
    await flush();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(src.commands).not.toHaveBeenCalled();
  });

  it("3 /usr/bin 打到第二个 / 时列表关掉", async () => {
    render(<Harness src={source()} />);
    await user.type(box(), "/usr");
    expect(await screen.findByText("没有匹配的命令")).toBeInTheDocument(); // 列表开着，只是没有匹配
    await user.type(box(), "/");
    expect(screen.queryByText("没有匹配的命令")).toBeNull();
  });

  it("4 打 /comp 实时筛选，名字开头命中的排前面", async () => {
    render(<Harness src={source({ commands: async () => [{ name: "init", description: "写 compact 说明" }, ...COMMANDS] })} />);
    await user.type(box(), "/co");
    await screen.findByRole("listbox");
    expect(options().map((o) => o.textContent)).toEqual(["/compact压缩上下文", "/context看上下文用了多少", "/init写 compact 说明"]);
    await user.type(box(), "mp");
    expect(options().map((o) => o.textContent)).toEqual(["/compact压缩上下文", "/init写 compact 说明"]);
  });

  it("5 ↑↓ 循环选；Enter 和 Tab 插入 /compact 带空格，光标在空格后", async () => {
    render(<Harness src={source()} />);
    await user.type(box(), "/");
    await screen.findByRole("listbox");
    await user.keyboard("{ArrowUp}");
    expect(active()).toBe(options()[2]); // 第一行往上：绕到最后一行
    await user.keyboard("{ArrowDown}");
    expect(active()).toBe(options()[0]); // 最后一行往下：绕回第一行
    await user.keyboard("{ArrowDown}");
    expect(active()).toBe(options()[1]);
    await user.keyboard("{Enter}");
    expect(box().value).toBe("/compact ");
    expect(box().selectionStart).toBe(9);
    expect(screen.queryByRole("listbox")).toBeNull();

    // Tab 同样
    await user.clear(box());
    await user.type(box(), "/co");
    await screen.findByRole("listbox");
    await user.keyboard("{Tab}");
    expect(box().value).toBe("/compact ");
    expect(box().selectionStart).toBe(9);
  });

  it("5 Esc 关列表，文字不动；接着打字不再弹出", async () => {
    render(<Harness src={source()} />);
    await user.type(box(), "/co");
    await screen.findByRole("listbox");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(box().value).toBe("/co");
    await user.type(box(), "m");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("6 列表开着时 Enter 只选中，不发送", async () => {
    const onSend = vi.fn();
    render(<Harness src={source()} onSend={onSend} />);
    await user.type(box(), "/com");
    await screen.findByRole("listbox");
    await user.keyboard("{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect(box().value).toBe("/compact ");
    // 列表关了以后 Enter 才发送
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("/compact", []);
  });

  it("7 输入法选字时的 Enter 不算", async () => {
    const onSend = vi.fn();
    render(<Harness src={source()} onSend={onSend} />);
    await user.type(box(), "/co");
    await screen.findByRole("listbox");
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(box(), { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(box(), { key: "ArrowDown", isComposing: true });
    expect(box().value).toBe("/co");
    expect(active()).toBe(options()[0]);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("10 没有匹配时显示“没有匹配的命令”，Enter 照常发送原文", async () => {
    const onSend = vi.fn();
    render(<Harness src={source()} onSend={onSend} />);
    await user.type(box(), "/zzz");
    expect(await screen.findByText("没有匹配的命令")).toBeInTheDocument();
    expect(options()).toHaveLength(0);
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("/zzz", []);
  });

  it("鼠标按下不抢走输入框的焦点；点一行就选中它", async () => {
    render(<Harness src={source()} />);
    await user.type(box(), "/");
    await screen.findByRole("listbox");
    const row = options()[1]!;
    expect(fireEvent.mouseDown(row)).toBe(false); // preventDefault 了
    await user.click(row);
    expect(box().value).toBe("/compact ");
    expect(box()).toHaveFocus();
  });

  it("鼠标移到某一行，那一行高亮", async () => {
    render(<Harness src={source()} />);
    await user.type(box(), "/");
    await screen.findByRole("listbox");
    await user.hover(options()[2]!);
    expect(active()).toBe(options()[2]);
  });

  it("最多 8 行高，更多的滚动", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `cmd${i}`, description: "x" }));
    render(<Harness src={source({ commands: async () => many })} />);
    await user.type(box(), "/");
    const list = await screen.findByRole("listbox");
    expect(options()).toHaveLength(20);
    expect(list.className).toMatch(/max-h-\[calc\(8\*/);
    expect(list.className).toContain("overflow-y-auto");
  });

  it("20 拿不到命令列表时不弹、不报错，照常能发", async () => {
    const onSend = vi.fn();
    render(<Harness src={source({ commands: async () => Promise.reject(new Error("boom")) })} onSend={onSend} />);
    await user.type(box(), "/xyz");
    await flush();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    await user.keyboard("{Enter}");
    expect(onSend).toHaveBeenCalledWith("/xyz", []);
  });

  it("20 后台给的是空列表时也不弹", async () => {
    render(<Harness src={source({ commands: async () => [] })} />);
    await user.type(box(), "/");
    await flush();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("没有 source（比如不在对话里）时什么都不弹", async () => {
    render(<Harness src={undefined} />);
    await user.type(box(), "/");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("输入框 @ 文件列表", () => {
  const entry = (path: string, insert = `@${path}`) => ({ path, root: "/repo", insert });
  const filesOf = (...entries: ReturnType<typeof entry>[]) => vi.fn(async () => ({ entries, truncated: false }));

  afterEach(() => vi.useRealTimers());

  // 真等一个防抖的时间。要精确控制时间的两条用假时钟 + fireEvent（user-event 的 asyncWrapper 在 vitest 假时钟下会卡住）
  const wait = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, FILE_SEARCH_DEBOUNCE_MS + 40)));
  const typeFake = (text: string) => fireEvent.change(box(), { target: { value: text } });
  const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  it("11 @ 弹出文件列表，一行是文件名和父目录", async () => {
    const files = filesOf(entry("src/web/App.tsx"), entry("README.md"));
    render(<Harness src={source({ files })} />);
    await user.type(box(), "@");
    await wait();
    expect(screen.getByRole("listbox", { name: "文件" })).toBeInTheDocument();
    const [first, second] = options();
    expect(first).toHaveTextContent("App.tsx");
    expect(first).toHaveTextContent("src/web");
    expect(second).toHaveTextContent("README.md");
    expect(active()).toBe(first);
  });

  it("11 选中后插入后台给的 insert，后面带空格；网页自己不拼 @", async () => {
    render(<Harness src={source({ files: filesOf(entry("src/a.ts", "@./src/a.ts")) })} />);
    await user.type(box(), "看 @a");
    await wait();
    await user.keyboard("{Enter}");
    expect(box().value).toBe("看 @./src/a.ts ");
    expect(box().selectionStart).toBe(box().value.length);
  });

  it("12 a@b.com 不弹，也不搜", async () => {
    const files = filesOf(entry("x"));
    render(<Harness src={source({ files })} />);
    await user.type(box(), "a@b.com");
    await wait();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(files).not.toHaveBeenCalled();
  });

  it("13 名字带空格的，照后台给的 @\"a b.md\" 插入", async () => {
    render(<Harness src={source({ files: filesOf(entry("docs/a b.md", '@"docs/a b.md"')) })} />);
    await user.type(box(), "@a");
    await wait();
    await user.keyboard("{Tab}");
    expect(box().value).toBe('@"docs/a b.md" ');
  });

  it("18 没有匹配时显示“没有匹配的文件”", async () => {
    render(<Harness src={source({ files: filesOf() })} />);
    await user.type(box(), "@zzz");
    await wait();
    expect(screen.getByText("没有匹配的文件")).toBeInTheDocument();
  });

  it("接着打字等 120ms 没再打才发请求", async () => {
    vi.useFakeTimers();
    const files = filesOf(entry("a.ts"));
    render(<Harness src={source({ files })} />);
    typeFake("@a");
    await tick(FILE_SEARCH_DEBOUNCE_MS - 20);
    expect(files).not.toHaveBeenCalled();
    typeFake("@ab"); // 又打了一个字：重新等
    await tick(FILE_SEARCH_DEBOUNCE_MS - 20);
    expect(files).not.toHaveBeenCalled();
    await tick(30);
    expect(files).toHaveBeenCalledTimes(1);
    expect(files).toHaveBeenLastCalledWith("ab", expect.any(AbortSignal));
  });

  it("19 后发先回时，旧结果作废", async () => {
    vi.useFakeTimers();
    const pending: Record<string, (v: { entries: ReturnType<typeof entry>[]; truncated: boolean }) => void> = {};
    const files = vi.fn((q: string) => new Promise<{ entries: ReturnType<typeof entry>[]; truncated: boolean }>((resolve) => (pending[q] = resolve)));
    render(<Harness src={source({ files })} />);
    typeFake("@a");
    await tick(FILE_SEARCH_DEBOUNCE_MS + 10); // 发出 “a”
    typeFake("@ab");
    await tick(FILE_SEARCH_DEBOUNCE_MS + 10); // 发出 “ab”
    expect(files).toHaveBeenCalledTimes(2);
    await act(async () => pending["ab"]!({ entries: [entry("new.ts")], truncated: false }));
    await act(async () => pending["a"]!({ entries: [entry("old.ts")], truncated: false })); // 旧请求后到
    expect(options().map((o) => o.textContent)).toEqual(["new.ts"]);
  });

  it("拿不到文件列表时不弹、不报错", async () => {
    render(<Harness src={source({ files: vi.fn(async () => Promise.reject(new Error("boom"))) })} />);
    await user.type(box(), "@a");
    await wait();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("发送被拦", () => {
  it("原因显示在输入框上方，用户原文还留在输入框里", async () => {
    const onSend = vi.fn(() => Promise.reject(new Error("/clear 会打乱对话，请用「开新会话」按钮")));
    render(<Harness src={source()} onSend={onSend} initial="/clear" />);
    await user.type(box(), " ");
    await user.keyboard("{Enter}");
    const reason = await screen.findByRole("alert");
    expect(reason).toHaveTextContent("/clear 会打乱对话，请用「开新会话」按钮");
    expect(box().value).toBe("/clear ");
    expect(reason.compareDocumentPosition(box()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
