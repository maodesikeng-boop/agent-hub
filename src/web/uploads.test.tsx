// 聊天框上传文件：回形针、拖放、粘贴、待发列表、发出后的缩略图、各种失败。接口和 WebSocket 都是假的（上传接口见 test-utils 的 FakeApi.upload）。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_UPLOAD_BYTES, type StateSnapshot } from "../shared/index.ts";
import { App } from "./App.tsx";
import {
  FakeApi,
  FakeWebSocket,
  installFakeWebSocket,
  makeAttachment,
  makeConvSnapshot,
  makeMessage,
  makePm,
  makeSnapshot,
  makeUserMessage,
  messageChange,
  type Reply,
} from "./test-utils.ts";
import { ATTACHMENTS_MISSING_MESSAGE } from "../shared/index.ts";

let api: FakeApi;

async function boot(snapshot: StateSnapshot = defaultSnapshot()) {
  api = new FakeApi(snapshot);
  api.install();
  installFakeWebSocket();
  render(<App />);
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  act(() => FakeWebSocket.last.open());
  return FakeWebSocket.last;
}

function defaultSnapshot(): StateSnapshot {
  return makeSnapshot({
    pms: [makePm({ id: 1, name: "小林" })],
    conversations: [
      makeConvSnapshot([makeUserMessage({ id: 1, text: "你好", createdAt: 5_000 }), makeMessage({ id: 2, text: "我在", createdAt: 6_000 })], {
        conversation: { id: 1, pmId: 1, title: "小林" },
      }),
    ],
  });
}

const box = () => screen.getByRole("textbox", { name: "输入消息" });
const sendButton = () => screen.getByRole("button", { name: "发送" });
const picker = () => screen.getByLabelText("选择文件") as HTMLInputElement;
const log = () => screen.getByRole("log", { name: "消息" });
const pendingList = () => screen.queryByRole("list", { name: "待发送的文件" });
const conversation = () => screen.getByRole("region", { name: "小林" });

function file(name: string, content = "内容", type = "text/plain"): File {
  return new File([content], name, { type });
}

/** 假装是一个很大的文件，不真的分配内存。 */
function hugeFile(name: string, size: number): File {
  const f = file(name, "x");
  Object.defineProperty(f, "size", { value: size });
  return f;
}

const posts = () => api.callsTo("POST", /\/messages$/);
const sentBody = (i = 0) => posts()[i]?.body as { clientId: string; text: string; attachmentIds?: string[] };

describe("选文件（回形针）", () => {
  it("点回形针选多个文件：输入框上方列出文件名；发送：先上传、再发消息，消息正文里带着编号，消息里显示文件名", async () => {
    const user = userEvent.setup();
    await boot();
    await user.type(box(), "看看这两个");
    await user.upload(picker(), [file("笔记.txt"), file("报告.pdf", "pdf", "application/pdf")]);
    const list = within(pendingList() as HTMLElement);
    expect(list.getByText("笔记.txt")).toBeInTheDocument();
    expect(list.getByText("报告.pdf")).toBeInTheDocument();
    expect(api.uploads).toHaveLength(0); // 点发送才上传

    await user.click(sendButton());
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(api.uploads.map((u) => u.name)).toEqual(["笔记.txt", "报告.pdf"]);
    expect(api.uploads.every((u) => u.contentType === "application/octet-stream")).toBe(true);
    expect(sentBody()).toEqual({
      clientId: expect.any(String),
      text: "看看这两个",
      attachmentIds: ["0000000000000001", "0000000000000002"],
    });
    // 马上显示：文字 + 两个文件名；输入框和待发列表清空
    const mine = within(log()).getAllByRole("article").at(-1) as HTMLElement;
    expect(mine).toHaveTextContent("看看这两个");
    expect(within(mine).getByText("笔记.txt")).toBeInTheDocument();
    expect(within(mine).getByText("报告.pdf")).toBeInTheDocument();
    expect(box()).toHaveValue("");
    expect(pendingList()).toBeNull();
  });

  it("可以连续选两次，第二次接在后面；选完同一个文件还能再选（输入控件被清空）", async () => {
    const user = userEvent.setup();
    await boot();
    await user.upload(picker(), file("a.txt"));
    await user.upload(picker(), file("b.txt"));
    expect(within(pendingList() as HTMLElement).getAllByRole("listitem")).toHaveLength(2);
    expect(picker().value).toBe("");
  });

  it("同名文件两个都列出来（各有各的 ×）", async () => {
    const user = userEvent.setup();
    await boot();
    await user.upload(picker(), [file("image.png", "1", "image/png"), file("image.png", "2", "image/png")]);
    expect(within(pendingList() as HTMLElement).getAllByText("image.png")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "去掉 image.png" })).toHaveLength(2);
  });

  it("文件名里带 ../、非 ASCII：原样交给上传接口（服务端清理），列表照常显示", async () => {
    const user = userEvent.setup();
    await boot();
    await user.upload(picker(), [file("../../etc/passwd"), file("屏幕截图 2026-11-04.png", "x", "image/png")]);
    await user.click(sendButton());
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(api.uploads.map((u) => u.name)).toEqual(["../../etc/passwd", "屏幕截图 2026-11-04.png"]);
  });
});

describe("待发文件", () => {
  it("点 × 去掉一个：列表里没了，发出去的消息不带它；全去掉后列表消失", async () => {
    const user = userEvent.setup();
    await boot();
    await user.upload(picker(), [file("a.txt"), file("b.txt")]);
    await user.click(screen.getByRole("button", { name: "去掉 a.txt" }));
    expect(within(pendingList() as HTMLElement).queryByText("a.txt")).toBeNull();
    await user.type(box(), "只发 b{Enter}");
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(api.uploads.map((u) => u.name)).toEqual(["b.txt"]);
    await user.upload(picker(), file("c.txt"));
    await user.click(screen.getByRole("button", { name: "去掉 c.txt" }));
    expect(pendingList()).toBeNull();
  });

  it("切到别的对话再回来，待发文件还在（和没发的文字一样）", async () => {
    const user = userEvent.setup();
    const snapshot = makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" }), makePm({ id: 2, name: "老马" })],
      conversations: [
        makeConvSnapshot([], { conversation: { id: 1, pmId: 1, title: "小林" } }),
        makeConvSnapshot([], { conversation: { id: 2, pmId: 2, title: "老马" } }),
      ],
    });
    await boot(snapshot);
    await user.upload(picker(), file("留着.txt"));
    await user.click(screen.getByRole("button", { name: /老马/ }));
    expect(pendingList()).toBeNull();
    await user.click(screen.getByRole("button", { name: /小林/ }));
    expect(within(pendingList() as HTMLElement).getByText("留着.txt")).toBeInTheDocument();
  });
});

describe("拖放", () => {
  const dragData = (files: File[]) => ({ dataTransfer: { files, types: ["Files"] } });

  it("文件拖到对话区上：出现“松手添加文件”的高亮；松手：加入待发列表，高亮消失", async () => {
    await boot();
    const area = conversation();
    expect(screen.queryByText("松手添加文件")).toBeNull();
    fireEvent.dragEnter(area, dragData([file("拖来的.png", "x", "image/png")]));
    fireEvent.dragOver(area, dragData([file("拖来的.png", "x", "image/png")]));
    expect(screen.getByText("松手添加文件")).toBeInTheDocument();
    fireEvent.drop(area, dragData([file("拖来的.png", "x", "image/png"), file("拖来的.txt")]));
    expect(screen.queryByText("松手添加文件")).toBeNull();
    const list = within(pendingList() as HTMLElement);
    expect(list.getByText("拖来的.png")).toBeInTheDocument();
    expect(list.getByText("拖来的.txt")).toBeInTheDocument();
  });

  it("拖进去又拖出来：高亮消失，不加入", async () => {
    await boot();
    const area = conversation();
    fireEvent.dragEnter(area, dragData([file("a.txt")]));
    expect(screen.getByText("松手添加文件")).toBeInTheDocument();
    fireEvent.dragLeave(area, dragData([file("a.txt")]));
    expect(screen.queryByText("松手添加文件")).toBeNull();
    expect(pendingList()).toBeNull();
  });

  it("拖的不是文件（比如选中的文字）：不高亮", async () => {
    await boot();
    fireEvent.dragEnter(conversation(), { dataTransfer: { files: [], types: ["text/plain"] } });
    expect(screen.queryByText("松手添加文件")).toBeNull();
  });

  it("拖放的文件也要过大小检查", async () => {
    await boot();
    fireEvent.drop(conversation(), dragData([hugeFile("大.mov", MAX_UPLOAD_BYTES + 1)]));
    expect(pendingList()).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("大.mov");
  });
});

describe("粘贴", () => {
  it("Cmd+V 粘贴截图：加入待发列表，不往输入框里塞文字", async () => {
    await boot();
    const shot = file("image.png", "png", "image/png");
    fireEvent.paste(box(), { clipboardData: { files: [shot], types: ["Files"], getData: () => "" } });
    expect(within(pendingList() as HTMLElement).getByText("image.png")).toBeInTheDocument();
    expect(box()).toHaveValue("");
  });

  it("粘贴的是纯文字：照常粘进输入框，不加文件", async () => {
    await boot();
    const notPrevented = fireEvent.paste(box(), { clipboardData: { files: [], types: ["text/plain"], getData: () => "一段话" } });
    expect(notPrevented).toBe(true); // 没拦：浏览器自己把字贴进去
    expect(pendingList()).toBeNull();
  });
});

describe("发出之后", () => {
  it("服务端推回真消息：图片显示小缩略图（指向上传接口）和文件名，别的文件只有文件名；不和临时消息重复", async () => {
    const user = userEvent.setup();
    const ws = await boot();
    await user.upload(picker(), [file("截图.png", "x", "image/png"), file("报告.pdf")]);
    await user.type(box(), "给你{Enter}");
    await waitFor(() => expect(posts()).toHaveLength(1));
    const { clientId } = sentBody();
    const png = makeAttachment({ id: "0000000000000001", name: "截图.png", mime: "image/png" });
    const pdf = makeAttachment({ id: "0000000000000002", name: "报告.pdf" });
    act(() =>
      ws.push(
        messageChange(11, "message.created", makeUserMessage({ id: 3, text: "给你", status: "queued", dedupeKey: `client:1:${clientId}`, meta: { attachments: [png, pdf] } })),
      ),
    );
    const articles = within(log()).getAllByRole("article");
    expect(articles).toHaveLength(3);
    const mine = articles.at(-1) as HTMLElement;
    const thumb = within(mine).getByRole("img", { name: "截图.png" });
    expect(thumb).toHaveAttribute("src", "/api/uploads/0000000000000001/%E6%88%AA%E5%9B%BE.png");
    expect(within(mine).getByText("截图.png")).toBeInTheDocument();
    expect(within(mine).getByText("报告.pdf")).toBeInTheDocument();
    expect(within(mine).queryByRole("img", { name: "报告.pdf" })).toBeNull();
    expect(within(mine).getByRole("link", { name: /报告\.pdf/ })).toHaveAttribute("href", "/api/uploads/0000000000000002/%E6%8A%A5%E5%91%8A.pdf");
  });

  it("刚发出还没收到服务端推回时，图片也先显示缩略图", async () => {
    const user = userEvent.setup();
    await boot();
    await user.upload(picker(), file("截图.png", "x", "image/png"));
    await user.click(sendButton());
    await waitFor(() => expect(posts()).toHaveLength(1));
    const mine = within(log()).getAllByRole("article").at(-1) as HTMLElement;
    expect(within(mine).getByRole("img", { name: "截图.png" })).toBeInTheDocument();
  });

  it("只有文件没有文字：发送按钮可点，消息里没有空的文字气泡，POST 的 text 是空串", async () => {
    const user = userEvent.setup();
    await boot();
    expect(sendButton()).toBeDisabled();
    await user.upload(picker(), file("只有它.txt"));
    expect(sendButton()).toBeEnabled();
    await user.click(sendButton());
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(sentBody()).toMatchObject({ text: "", attachmentIds: ["0000000000000001"] });
    const mine = within(log()).getAllByRole("article").at(-1) as HTMLElement;
    expect(within(mine).getByText("只有它.txt")).toBeInTheDocument();
    expect(mine.querySelector("[data-bubble]")).toBeNull();
  });

  it("按 Enter 也能只发文件", async () => {
    const user = userEvent.setup();
    await boot();
    await user.upload(picker(), file("a.txt"));
    box().focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(posts()).toHaveLength(1));
  });

  it("不带文件的消息照旧：不调上传接口，POST 里没有 attachmentIds", async () => {
    const user = userEvent.setup();
    await boot();
    await user.type(box(), "只是文字{Enter}");
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(api.uploads).toHaveLength(0);
    expect(sentBody()).toEqual({ clientId: expect.any(String), text: "只是文字" });
  });

  it("发送失败（消息接口出错）后点重试：同一个 clientId、同样的附件编号，不再重新上传", async () => {
    const user = userEvent.setup();
    await boot();
    api.postMessage = () => ({ status: 500, body: { error: "出错了" } });
    await user.upload(picker(), file("a.txt"));
    await user.type(box(), "带文件{Enter}");
    await waitFor(() => expect(within(log()).getByText("发送失败")).toBeInTheDocument());
    api.postMessage = () => ({ status: 200, body: { messageId: 9 } });
    await user.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(sentBody(1)).toEqual(sentBody(0));
    expect(api.uploads).toHaveLength(1);
  });
});

describe("检查文件", () => {
  it("超过 20 MB：不加入列表，用中文说是哪个文件、上限多少", async () => {
    const user = userEvent.setup();
    await boot();
    await user.upload(picker(), [hugeFile("录屏.mov", MAX_UPLOAD_BYTES + 1), file("小的.txt")]);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("录屏.mov");
    expect(alert).toHaveTextContent("超过 20 MB");
    const list = within(pendingList() as HTMLElement);
    expect(list.queryByText("录屏.mov")).toBeNull();
    expect(list.getByText("小的.txt")).toBeInTheDocument(); // 别的文件不受影响
  });

  it("刚好 20 MB 可以加入", async () => {
    const user = userEvent.setup();
    await boot();
    await user.upload(picker(), hugeFile("刚好.bin", MAX_UPLOAD_BYTES));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(within(pendingList() as HTMLElement).getByText("刚好.bin")).toBeInTheDocument();
  });

  it("空文件：不加入，中文提示", async () => {
    const user = userEvent.setup();
    await boot();
    await user.upload(picker(), new File([], "空.txt"));
    expect(pendingList()).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("空.txt");
    expect(screen.getByRole("alert")).toHaveTextContent("空");
  });

  it(`一条消息最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 个文件：多的不加入，中文提示`, async () => {
    const user = userEvent.setup();
    await boot();
    const many = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 2 }, (_, i) => file(`f${i}.txt`));
    await user.upload(picker(), many);
    expect(within(pendingList() as HTMLElement).getAllByRole("listitem")).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(screen.getByRole("alert")).toHaveTextContent(`最多带 ${MAX_ATTACHMENTS_PER_MESSAGE} 个`);
  });

  it("提示在下一次操作（去掉文件、再选文件）后消失", async () => {
    const user = userEvent.setup();
    await boot();
    await user.upload(picker(), hugeFile("大.bin", MAX_UPLOAD_BYTES + 1));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await user.upload(picker(), file("ok.txt"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("上传失败：消息不发出，提示可见，输入的文字和待发文件都还在", () => {
  async function failWith(reply: () => Reply, expected: string) {
    const user = userEvent.setup();
    await boot();
    const original = api.upload;
    api.upload = reply;
    await user.type(box(), "这段话不能丢");
    await user.upload(picker(), [file("a.txt"), file("b.txt")]);
    await user.click(sendButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(expected);
    expect(posts()).toHaveLength(0);
    expect(box()).toHaveValue("这段话不能丢");
    expect(within(pendingList() as HTMLElement).getAllByRole("listitem")).toHaveLength(2);
    expect(within(log()).getAllByRole("article")).toHaveLength(2); // 没有多出临时消息
    expect(sendButton()).toBeEnabled();
    return { user, restore: () => (api.upload = original) };
  }

  it("服务端出错（500）", async () => {
    await failWith(() => ({ status: 500, body: { error: "internal_error" } }), "上传失败");
  });

  it("服务端说文件太大（413）：中文提示 20 MB，不是“1 MB”", async () => {
    await failWith(() => ({ status: 413, body: { error: "Request body is too large" } }), "文件太大，单个文件最多 20 MB");
  });

  it("服务端拒绝（400，带中文原因）：原因原样显示", async () => {
    await failWith(() => ({ status: 400, body: { error: "文件是空的，没有内容可发", code: "invalid" } }), "文件是空的，没有内容可发");
  });

  it("网络断了：说连不上，不是英文报错", async () => {
    const user = userEvent.setup();
    await boot();
    api.fetch.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/uploads")) throw new TypeError("Failed to fetch");
      return new Response("{}", { status: 404 });
    });
    await user.type(box(), "文字在");
    await user.upload(picker(), file("a.txt"));
    await user.click(sendButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("连不上");
    expect(alert).not.toHaveTextContent("Failed to fetch");
    expect(box()).toHaveValue("文字在");
    expect(pendingList()).not.toBeNull();
  });

  it("失败后再点发送：重新上传、发出，成功后清空", async () => {
    const { user, restore } = await failWith(() => ({ status: 500, body: { error: "x" } }), "上传失败");
    restore();
    await user.click(sendButton());
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(sentBody().text).toBe("这段话不能丢");
    expect(sentBody().attachmentIds).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(box()).toHaveValue("");
    expect(pendingList()).toBeNull();
  });

  it("其中一个文件上传失败：整条消息不发（不发半截）", async () => {
    const user = userEvent.setup();
    await boot();
    const ok = api.upload;
    api.upload = (name, f) => (name === "坏.txt" ? { status: 500, body: { error: "x" } } : ok(name, f));
    await user.upload(picker(), [file("好.txt"), file("坏.txt")]);
    await user.click(sendButton());
    await screen.findByRole("alert");
    expect(posts()).toHaveLength(0);
    expect(screen.getByRole("alert")).toHaveTextContent("坏.txt");
  });
});

describe("上传过程中", () => {
  it("上传没完时：发送按钮不可点、不会重复发；文字框不让改；完成后清空", async () => {
    const user = userEvent.setup();
    await boot();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const ok = api.upload;
    api.upload = async (name, f) => {
      await gate;
      return ok(name, f);
    };
    await user.type(box(), "慢慢传");
    await user.upload(picker(), file("a.txt"));
    await user.click(sendButton());
    await waitFor(() => expect(api.uploads).toHaveLength(1));
    expect(sendButton()).toBeDisabled();
    expect(box()).toHaveAttribute("readonly");
    await user.keyboard("{Enter}");
    expect(api.uploads).toHaveLength(1);
    // 传的时候不能再去掉或添加文件
    expect(screen.getByRole("button", { name: "去掉 a.txt" })).toBeDisabled();
    finish();
    await waitFor(() => expect(posts()).toHaveLength(1));
    await waitFor(() => expect(box()).toHaveValue(""));
    expect(box()).not.toHaveAttribute("readonly");
  });
});

describe("老数据", () => {
  it("没有附件字段的老消息（meta 是 null、{}、别的内容）：照常显示文字，没有文件，没有报错", async () => {
    await boot(
      makeSnapshot({
        pms: [makePm({ id: 1, name: "小林" })],
        conversations: [
          makeConvSnapshot(
            [
              makeUserMessage({ id: 1, text: "老消息一", meta: null }),
              makeUserMessage({ id: 2, text: "老消息二", meta: {} }),
              makeUserMessage({ id: 3, text: "老消息三", meta: { something: "else" } }),
              makeUserMessage({ id: 4, text: "附件字段坏了", meta: { attachments: "oops" } }),
              makeUserMessage({ id: 5, text: "有一个好的", meta: { attachments: [null, 7, makeAttachment({ name: "好.txt" })] } }),
            ],
            { conversation: { id: 1, pmId: 1, title: "小林" } },
          ),
        ],
      }),
    );
    for (const text of ["老消息一", "老消息二", "老消息三", "附件字段坏了", "有一个好的"]) {
      expect(within(log()).getByText(text)).toBeInTheDocument();
    }
    expect(within(log()).getAllByText("好.txt")).toHaveLength(1);
    expect(within(log()).queryAllByRole("img")).toHaveLength(0);
  });
});

describe("上传没完时切走对话再切回来", () => {
  const twoConversations = () =>
    makeSnapshot({
      pms: [makePm({ id: 1, name: "小林" }), makePm({ id: 2, name: "老马" })],
      conversations: [
        makeConvSnapshot([], { conversation: { id: 1, pmId: 1, title: "小林" } }),
        makeConvSnapshot([], { conversation: { id: 2, pmId: 2, title: "老马" } }),
      ],
    });

  /** 让上传卡住，直到 finish()。 */
  function slowUploads() {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const ok = api.upload;
    api.upload = async (name, f) => {
      await gate;
      return ok(name, f);
    };
    return finish;
  }

  it("切回来发送键仍锁着、文字框仍锁着、不会把同一批文件再发一遍；传完发出一次，清掉；别的对话的草稿不受影响", async () => {
    const user = userEvent.setup();
    await boot(twoConversations());
    const finish = slowUploads();
    await user.type(box(), "慢慢传");
    await user.upload(picker(), file("a.txt"));
    await user.click(sendButton());
    await waitFor(() => expect(api.uploads).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: /老马/ }));
    await user.type(box(), "给老马的话");
    expect(sendButton()).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /小林/ }));

    expect(sendButton()).toBeDisabled();
    expect(box()).toHaveAttribute("readonly");
    expect(box()).toHaveValue("慢慢传");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "去掉 a.txt" })).toBeDisabled();
    expect(api.uploads).toHaveLength(1);

    finish();
    await waitFor(() => expect(posts()).toHaveLength(1));
    await waitFor(() => expect(box()).toHaveValue(""));
    expect(sendButton()).toBeDisabled(); // 没字没文件
    expect(pendingList()).toBeNull();
    expect(api.uploads).toHaveLength(1);
    expect(posts()).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /老马/ }));
    expect(box()).toHaveValue("给老马的话");
  });

  it("传的时候在文字框里又写了字（切回来之后）：传完只清提交的那一份，新写的字不丢", async () => {
    const user = userEvent.setup();
    await boot(twoConversations());
    const finish = slowUploads();
    await user.type(box(), "第一句");
    await user.upload(picker(), file("a.txt"));
    await user.click(sendButton());
    await waitFor(() => expect(api.uploads).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: /老马/ }));
    await user.click(screen.getByRole("button", { name: /小林/ }));
    fireEvent.change(box(), { target: { value: "第一句，后来补的" } }); // 程序改的（readonly 拦的是用户键盘）
    finish();
    await waitFor(() => expect(posts()).toHaveLength(1));
    await waitFor(() => expect(pendingList()).toBeNull());
    expect(box()).toHaveValue("第一句，后来补的");
  });

  it("切走期间上传失败：切回来能看到失败提示，文字和文件都在，发送键解锁", async () => {
    const user = userEvent.setup();
    await boot(twoConversations());
    let fail!: () => void;
    const gate = new Promise<void>((resolve) => (fail = resolve));
    api.upload = async () => {
      await gate;
      return { status: 500, body: { error: "x" } };
    };
    await user.type(box(), "别丢");
    await user.upload(picker(), file("a.txt"));
    await user.click(sendButton());
    await waitFor(() => expect(api.uploads).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: /老马/ }));
    await user.click(screen.getByRole("button", { name: /小林/ }));
    fail();
    expect(await screen.findByRole("alert")).toHaveTextContent("上传失败");
    expect(box()).toHaveValue("别丢");
    expect(sendButton()).toBeEnabled();
    expect(within(pendingList() as HTMLElement).getByText("a.txt")).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
});

describe("只发文件的消息在左栏和通知里的预览", () => {
  it("预览写“[文件] 名字”（多个用顿号），有文字的还是文字", async () => {
    await boot(
      makeSnapshot({
        pms: [makePm({ id: 1, name: "小林" })],
        conversations: [
          makeConvSnapshot(
            [makeUserMessage({ id: 1, text: "", meta: { attachments: [makeAttachment({ name: "报告.pdf" }), makeAttachment({ id: "1111111111111111", name: "图.png" })] } })],
            { conversation: { id: 1, pmId: 1, title: "小林" } },
          ),
        ],
      }),
    );
    expect(screen.getByText("[文件] 报告.pdf、图.png")).toBeInTheDocument();
  });
});

describe("发消息时文件已经不在", () => {
  it("服务端回“文件找不到了”：消息标发送失败，写“文件已不在，请重新添加”，没有重试按钮", async () => {
    const user = userEvent.setup();
    await boot();
    api.postMessage = () => ({ status: 400, body: { error: ATTACHMENTS_MISSING_MESSAGE, code: "invalid" } });
    await user.upload(picker(), file("a.txt"));
    await user.type(box(), "带文件{Enter}");
    const mine = await waitFor(() => {
      const last = within(log()).getAllByRole("article").at(-1) as HTMLElement;
      expect(within(last).getByText("文件已不在，请重新添加")).toBeInTheDocument();
      return last;
    });
    expect(within(mine).queryByRole("button", { name: "重试" })).toBeNull();
    expect(mine).toHaveTextContent("带文件");
  });

  it("别的发送失败照旧有“重试”", async () => {
    const user = userEvent.setup();
    await boot();
    api.postMessage = () => ({ status: 500, body: { error: "x" } });
    await user.upload(picker(), file("a.txt"));
    await user.type(box(), "带文件{Enter}");
    expect(await screen.findByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});
