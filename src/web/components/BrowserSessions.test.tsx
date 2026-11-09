// 设置里的“已登录的浏览器”（联机 P6）：列表、单个退出、全部退出（点两次）、在手机上打开（二维码 + 倒计时）。接口是假的。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { BrowserSessionInfo } from "../../shared/index.ts";
import { FakeApi, makeSnapshot } from "../test-utils.ts";
import { BrowserSessionsSettings } from "./BrowserSessions.tsx";
import { qrModules } from "./QrCode.tsx";

/** 老服务端回 { error: "internal_error" } 时网页显示的话：中文 + 怎么办（shared/errors.ts 的表）。 */
const INTERNAL = "守护进程出了意外的错，已记进日志，重试一次；还不行看日志";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";

const session = (over: Partial<BrowserSessionInfo> & { id: string }): BrowserSessionInfo => ({
  userAgent: MAC,
  createdAt: 0,
  lastSeenAt: Date.now(),
  current: false,
  ...over,
});

let api: FakeApi;
let onSignedOut: Mock<() => void>;
let list: BrowserSessionInfo[];

beforeEach(() => {
  api = new FakeApi(makeSnapshot({}));
  list = [session({ id: "mac", current: true }), session({ id: "phone", userAgent: IPHONE, lastSeenAt: Date.now() - 5 * 60_000 })];
  api.browserSessions = () => ({ status: 200, body: { sessions: list } });
  api.install();
  onSignedOut = vi.fn<() => void>();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function show() {
  render(<BrowserSessionsSettings onSignedOut={onSignedOut} />);
  await screen.findByText("iPhone Safari");
}

const rowOf = (name: string) => screen.getByText(name).closest("[data-slot='settings-row']") as HTMLElement;

describe("已登录的浏览器列表", () => {
  it("每个浏览器一行：名字是“设备 浏览器”，下面是最后活动；自己这一行标出来，不用 · 拼接", async () => {
    await show();
    const mine = rowOf("Mac Chrome");
    expect(within(mine).getByText(/这个浏览器/)).toBeInTheDocument();
    expect(within(mine).getByText(/刚刚/)).toBeInTheDocument();
    expect(mine.textContent).not.toContain("·");
    const phone = rowOf("iPhone Safari");
    expect(within(phone).getByText("5 分钟前")).toBeInTheDocument();
    expect(within(phone).queryByText(/这个浏览器/)).not.toBeInTheDocument();
    const region = screen.getByRole("region", { name: "已登录的浏览器" });
    expect(within(region).getByRole("button", { name: "显示二维码" })).toBeInTheDocument();
    expect(within(region).getByRole("button", { name: "全部退出" })).toBeInTheDocument();
  });

  it("读不出来（比如没登录）：框里一行说原因，不是空白", async () => {
    api.browserSessions = () => ({ status: 401, body: { error: "unauthorized" } });
    render(<BrowserSessionsSettings onSignedOut={onSignedOut} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("登录过期了，重新登录");
  });

  it("待批准（pending_approval）浏览器会话排在最前，展示“允许”与“拒绝”按钮；点“允许”调 POST /api/sessions/:id/approve 后变为已登录并标出“经公网”", async () => {
    list = [
      session({ id: "mac", current: true }),
      session({ id: "phone-pending", userAgent: IPHONE, status: "pending_approval", viaPublic: true, lastSeenAt: Date.now() - 60_000 }),
    ];
    await show();
    const region = screen.getByRole("region", { name: "已登录的浏览器" });
    const rows = region.querySelectorAll("[data-slot='settings-row']");
    // pending_approval 排在第一行
    expect(rows[0]).toHaveTextContent("iPhone Safari");
    expect(rows[0]).toHaveTextContent("待批准");
    expect(rows[0]).toHaveTextContent("经公网");
    expect(rows[0]!.textContent).not.toContain("·");

    const phoneRow = rowOf("iPhone Safari");
    expect(within(phoneRow).getByRole("button", { name: "拒绝" })).toBeInTheDocument();
    const approveBtn = within(phoneRow).getByRole("button", { name: "允许" });
    fireEvent.click(approveBtn);

    await waitFor(() => expect(api.callsTo("POST", /^\/api\/sessions\/phone-pending\/approve$/)).toHaveLength(1));
    await waitFor(() => expect(within(phoneRow).queryByText("待批准")).not.toBeInTheDocument());
    expect(within(phoneRow).getByText("经公网")).toBeInTheDocument();
    expect(within(phoneRow).getByRole("button", { name: /^退出/ })).toBeInTheDocument();
  });

  it("待批准（pending_approval）会话点“拒绝”调 DELETE /api/sessions/:id 并从列表移除", async () => {
    list = [
      session({ id: "mac", current: true }),
      session({ id: "phone-pending", userAgent: IPHONE, status: "pending_approval", viaPublic: true }),
    ];
    await show();
    const phoneRow = rowOf("iPhone Safari");
    fireEvent.click(within(phoneRow).getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(screen.queryByText("iPhone Safari")).not.toBeInTheDocument());
    expect(api.callsTo("DELETE", /^\/api\/sessions\/phone-pending$/)).toHaveLength(1);
  });
});

describe("单个退出", () => {
  it("退别的浏览器：发 DELETE，那一行消失，别的不动，页面不刷新", async () => {
    await show();
    fireEvent.click(within(rowOf("iPhone Safari")).getByRole("button", { name: /^退出/ }));
    await waitFor(() => expect(screen.queryByText("iPhone Safari")).not.toBeInTheDocument());
    expect(api.callsTo("DELETE", /^\/api\/sessions\/phone$/)).toHaveLength(1);
    expect(screen.getByText("Mac Chrome")).toBeInTheDocument();
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("退自己（这个浏览器）：先变确认态（确认退出 / 取消），点取消恢复，点确认退出才发 DELETE 并回到登录页", async () => {
    await show();
    const mine = rowOf("Mac Chrome");
    fireEvent.click(within(mine).getByRole("button", { name: /^退出/ }));
    expect(api.callsTo("DELETE", /^\/api\/sessions\/mac$/)).toHaveLength(0);
    expect(onSignedOut).not.toHaveBeenCalled();
    fireEvent.click(within(mine).getByRole("button", { name: "取消" }));
    expect(within(mine).getByRole("button", { name: /^退出/ })).toBeInTheDocument();
    fireEvent.click(within(mine).getByRole("button", { name: /^退出/ }));
    fireEvent.click(within(mine).getByRole("button", { name: "确认退出" }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
    expect(api.callsTo("DELETE", /^\/api\/sessions\/mac$/)).toHaveLength(1);
  });

  it("失败：那一行留着，下面写原因；按钮能再点", async () => {
    api.deleteBrowserSession = () => ({ status: 500, body: { error: "internal_error" } });
    await show();
    const row = rowOf("iPhone Safari");
    fireEvent.click(within(row).getByRole("button", { name: /^退出/ }));
    const alert = await within(row).findByRole("alert");
    expect(alert).toHaveTextContent(INTERNAL);
    expect(alert).toHaveAttribute("title", "internal_error"); // 英文码只在悬停的 title 里
    expect(within(row).getByRole("button", { name: /^退出/ })).toBeEnabled();
  });

  it("别人已经把它退了（404）：这一行也消失，不报错", async () => {
    api.deleteBrowserSession = () => ({ status: 404, body: { error: "not_found" } });
    await show();
    fireEvent.click(within(rowOf("iPhone Safari")).getByRole("button", { name: /^退出/ }));
    await waitFor(() => expect(screen.queryByText("iPhone Safari")).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("全部退出", () => {
  it("点一下只是变成“确认全部退出”，不发请求；再点才发，然后回到登录页", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "全部退出" }));
    expect(api.callsTo("POST", /logout-all/)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "确认全部退出" }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
    expect(api.callsTo("POST", /^\/api\/sessions\/logout-all$/)).toHaveLength(1);
  });

  it("点了又点别处（失去焦点）：退回“全部退出”，没发请求", async () => {
    await show();
    const button = screen.getByRole("button", { name: "全部退出" });
    button.focus();
    fireEvent.click(button);
    fireEvent.blur(screen.getByRole("button", { name: "确认全部退出" }));
    expect(screen.getByRole("button", { name: "全部退出" })).toBeInTheDocument();
    expect(api.callsTo("POST", /logout-all/)).toHaveLength(0);
  });

  it("失败：写原因，不刷新", async () => {
    api.logoutAll = () => ({ status: 500, body: { error: "internal_error" } });
    await show();
    fireEvent.click(screen.getByRole("button", { name: "全部退出" }));
    fireEvent.click(screen.getByRole("button", { name: "确认全部退出" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(INTERNAL);
    expect(onSignedOut).not.toHaveBeenCalled();
  });
});

describe("在手机上打开", () => {
  it("点“显示二维码”：发 POST，显示二维码和倒计时 5:00；二维码是图（有名字）", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: "显示二维码" }));
    const qr = await screen.findByRole("img", { name: "登录二维码" });
    expect(qr.querySelectorAll("path").length).toBeGreaterThan(0);
    expect(api.callsTo("POST", /^\/api\/login-links$/)).toHaveLength(1);
    expect(screen.getByText(/^[45]:\d\d$/)).toBeInTheDocument();
    // 链接本身（一次性令牌）不写在页面上
    expect(document.body.textContent).not.toContain("fake-code");
  });

  it("倒计时一秒一秒走；到点换成“已过期”和“重新生成”，二维码撤掉；重新生成发新的", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const start = Date.now();
    api.loginLink = () => ({ status: 201, body: { url: "http://127.0.0.1:4317/auth#link=a", expiresAt: Date.now() + 300_000 } });
    render(<BrowserSessionsSettings onSignedOut={onSignedOut} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByRole("button", { name: "显示二维码" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("5:00")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText("4:59")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(Date.now() - start).toBeGreaterThanOrEqual(300_000);
    expect(screen.getByText("已过期")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "登录二维码" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("img", { name: "登录二维码" })).toBeInTheDocument();
    expect(api.callsTo("POST", /^\/api\/login-links$/)).toHaveLength(2);
  });

  it("手机扫码登录之后（列表里多出一个浏览器）二维码自己收起来", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    render(<BrowserSessionsSettings onSignedOut={onSignedOut} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByRole("button", { name: "显示二维码" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("img", { name: "登录二维码" })).toBeInTheDocument();
    list = [...list, session({ id: "new", userAgent: IPHONE.replace("18_0", "18_1") })];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.queryByRole("img", { name: "登录二维码" })).not.toBeInTheDocument();
    expect(screen.getAllByText("iPhone Safari").length).toBe(2);
  });

  it("生成失败：写原因，没有二维码", async () => {
    api.loginLink = () => ({ status: 500, body: { error: "internal_error" } });
    await show();
    fireEvent.click(screen.getByRole("button", { name: "显示二维码" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(INTERNAL);
    expect(screen.queryByRole("img", { name: "登录二维码" })).not.toBeInTheDocument();
  });
});

describe("qrModules（二维码的点阵）", () => {
  it("正方形，每边至少 21 格（二维码最小的一档），里面有深有浅；同样的内容同样的点阵", () => {
    const m = qrModules("http://127.0.0.1:4317/auth#link=abc");
    expect(m.length).toBeGreaterThanOrEqual(21);
    expect(m.every((row) => row.length === m.length)).toBe(true);
    const dark = m.flat().filter(Boolean).length;
    expect(dark).toBeGreaterThan(0);
    expect(dark).toBeLessThan(m.length * m.length);
    expect(qrModules("http://127.0.0.1:4317/auth#link=abc")).toEqual(m);
  });

  it("三个角上有定位块（7×7 的框：外圈全深）", () => {
    const m = qrModules("hello");
    const n = m.length;
    for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]] as const) {
      for (let i = 0; i < 7; i++) {
        expect(m[r]![c + i]).toBe(true);
        expect(m[r + 6]![c + i]).toBe(true);
        expect(m[r + i]![c]).toBe(true);
        expect(m[r + i]![c + 6]).toBe(true);
      }
    }
  });

  it("内容越长点阵越大；长链接（43 位码的完整地址）也能编", () => {
    const short = qrModules("a").length;
    const url = `https://tokyo.tail1234.ts.net/auth#link=${"x".repeat(43)}`;
    expect(qrModules(url).length).toBeGreaterThan(short);
    expect(qrModules(url).length).toBeLessThanOrEqual(57);
  });
});
