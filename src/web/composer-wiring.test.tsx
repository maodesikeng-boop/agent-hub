// 输入框接上真接口：弹出列表走 API_PATHS，手打被拦的命令（发消息 400 + code invalid）原因显示在输入框上方、原文留着。
// 接口和 WebSocket 都是假的（和 m2.test.tsx 一样）。
import { act, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API_PATHS } from "../shared/index.ts";
import { App } from "./App.tsx";
import { FakeApi, FakeWebSocket, installFakeWebSocket, makeSnapshot, makeUserMessage, messageChange } from "./test-utils.ts";

let api: FakeApi;

async function boot() {
  api = new FakeApi(makeSnapshot());
  api.install();
  installFakeWebSocket();
  render(<App />);
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  act(() => FakeWebSocket.last.open());
  await screen.findByRole("textbox", { name: "输入消息" });
}

const box = () => screen.getByRole("textbox", { name: "输入消息" }) as HTMLTextAreaElement;
const BLOCKED = "/clear 会换掉对话的会话，请在资料页点“开新会话”";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("手打被拦的命令", () => {
  it("原因显示在输入框上方，原文还在输入框里，没有留下待发的消息", async () => {
    const user = userEvent.setup();
    await boot();
    api.postMessage = () => ({ status: 400, body: { error: BLOCKED, code: "invalid" } });
    await user.type(box(), "/clear{Enter}");
    const reason = await screen.findByRole("alert");
    expect(reason).toHaveTextContent(BLOCKED);
    expect(box().value).toBe("/clear");
    expect(reason.compareDocumentPosition(box()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("/clear", { selector: "div,p,span" })).toBeNull();
    expect(box()).not.toHaveAttribute("readonly"); // 能接着改
  });

  it("老服务端只回英文码：显示中文 + 怎么办，英文码只在 title 里", async () => {
    const user = userEvent.setup();
    await boot();
    api.postMessage = () => ({ status: 400, body: { error: "not_found" } });
    await user.type(box(), "/clear{Enter}");
    const reason = await screen.findByRole("alert");
    expect(reason).toHaveTextContent("要找的东西不在了，刷新页面再试");
    expect(reason).toHaveAttribute("title", "not_found");
    expect(reason).not.toHaveTextContent("not_found");
  });

  it("发出去了才清空输入框，消息照常显示成排队中", async () => {
    const user = userEvent.setup();
    await boot();
    await user.type(box(), "/compact{Enter}");
    await waitFor(() => expect(box().value).toBe(""));
    expect(api.callsTo("POST", /\/messages$/).map((c) => (c.body as { text: string }).text)).toEqual(["/compact"]);
    expect(await screen.findByText("/compact")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("服务端的推送比接口回应先到：只显示一条，不重复", async () => {
    const user = userEvent.setup();
    await boot();
    api.postMessage = (conversationId, body) => {
      act(() => FakeWebSocket.last.push(messageChange(1, "message.created", makeUserMessage({ id: 50, conversationId, text: body.text, dedupeKey: `client:${conversationId}:${body.clientId}`, status: "queued" }))));
      return { status: 200, body: { messageId: 50 } };
    };
    await user.type(box(), "/compact{Enter}");
    await waitFor(() => expect(box().value).toBe(""));
    expect(await screen.findAllByText("/compact")).toHaveLength(1);
  });

  it("网络或服务出错（不是被拦）：和普通消息一样，变成可重试的待发消息", async () => {
    const user = userEvent.setup();
    await boot();
    api.postMessage = () => ({ status: 500, body: { error: "boom" } });
    await user.type(box(), "/compact{Enter}");
    expect(await screen.findByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(box().value).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("普通文字还是先清空再发（不等接口）", async () => {
    const user = userEvent.setup();
    await boot();
    let release: () => void = () => {};
    api.postMessage = () => new Promise((resolve) => (release = () => resolve({ status: 200, body: { messageId: 9 } })));
    await user.type(box(), "你好{Enter}");
    expect(box().value).toBe("");
    expect(await screen.findByText("你好")).toBeInTheDocument();
    release();
  });
});

describe("任何接口回 401：直接切到登录界面，不弹报错", () => {
  it("发消息回 401：整页换成登录提示，没有报错提示", async () => {
    const user = userEvent.setup();
    await boot();
    api.postMessage = () => ({ status: 401, body: { error: "unauthorized" } });
    await user.type(box(), "你好{Enter}");
    expect(await screen.findByText(/还没有登录/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/登录过期了/)).toBeNull();
  });
});

describe("发消息被后台拒绝（400 invalid）", () => {
  const REASON = "消息里有不能发的内容";

  it("不管是不是 / 开头：原因写在那条消息下面，没有“重试”（同一条重发也还是会被拦）", async () => {
    const user = userEvent.setup();
    await boot();
    api.postMessage = () => ({ status: 400, body: { error: REASON, code: "invalid" } });
    await user.type(box(), "你好{Enter}");
    expect(await screen.findByText(REASON)).toBeInTheDocument();
    expect(screen.getByText("你好")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(screen.queryByText("发送失败")).toBeNull();
    expect(api.callsTo("POST", /\/messages$/)).toHaveLength(1);
  });

  it("别的失败（500、断网）照旧：发送失败加“重试”", async () => {
    const user = userEvent.setup();
    await boot();
    api.postMessage = () => ({ status: 500, body: { error: "boom" } });
    await user.type(box(), "你好{Enter}");
    expect(await screen.findByText("发送失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});

describe("弹出列表走真接口地址", () => {
  it("打 / 请求 API_PATHS.commands；选中后插入 /名字 和空格", async () => {
    const user = userEvent.setup();
    await boot();
    const base = api.fetch;
    const asked: string[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      asked.push(url);
      if (url === API_PATHS.commands(1)) return Promise.resolve(Response.json({ commands: [{ name: "compact", description: "压缩上下文" }] }));
      return base(input, init);
    });
    await user.type(box(), "/");
    await user.click(await screen.findByRole("option", { name: /compact/ }));
    expect(asked).toContain(API_PATHS.commands(1));
    expect(box().value).toBe("/compact ");
  });
});
