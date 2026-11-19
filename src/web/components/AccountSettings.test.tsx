// 设置 → 电脑里的账号组：没登录、登录中、等批准、已登录（批准新电脑、中心顺序）四种样子和各自发的请求。
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AccountId, AccountStatusView, DeviceFingerprint } from "../../shared/index.ts";
import { FakeApi, makeSnapshot } from "../test-utils.ts";
import { AccountSettings } from "./AccountSettings.tsx";

const MAC = "a0b1c2d3-e4f5-4a6b-8c7d-9e0f1a2b3c4d";
const WIN = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f";
const LINUX = "33333333-3333-4333-8333-333333333333";
const FP = "a".repeat(64) as DeviceFingerprint;
const ACCOUNT_ID = "acct_abcdefghijklmnopqrstuvwxyz" as AccountId;
const login = { provider: "github" as const, userId: "1", login: "alice" };

function withAccount(initial: AccountStatusView) {
  const api = new FakeApi(makeSnapshot({}));
  let current = initial;
  const update = (next: AccountStatusView) => {
    current = next;
    return { status: 200, body: current };
  };
  api.account = () => ({ status: 200, body: current });
  api.accountLogin = () =>
    update({
      state: "signing_in",
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      expiresAt: Date.now() + 900_000,
    });
  api.accountCancelLogin = () => update({ state: "signed_out", lastError: null });
  api.accountLogout = () => update({ state: "signed_out", lastError: null });
  api.accountApprovalBegin = (id) =>
    update(
      current.state === "signed_in"
        ? {
            ...current,
            approvals: current.approvals.map((a) => (a.requestId === id ? { ...a, sas: "042917" } : a)),
          }
        : current,
    );
  api.accountApprovalAnswer = (_id, body) =>
    update(
      body.match
        ? signedIn({
            devices: [{ id: MAC, name: "Mac", platform: "darwin", fingerprint: FP, self: true, online: true, link: "local", lastSeenAt: null }],
            centerPriority: [MAC],
          })
        : { state: "signed_out", lastError: "核对码不一致" },
    );
  api.accountPriority = (body) => update(current.state === "signed_in" ? { ...current, centerPriority: body.priority } : current);
  api.install();
  render(<AccountSettings />);
  return api;
}

const signedIn = (over: Partial<Extract<AccountStatusView, { state: "signed_in" }>> = {}): AccountStatusView => ({
  state: "signed_in",
  login,
  accountId: ACCOUNT_ID,
  relayUrl: "https://relay.test",
  relay: "connected",
  devices: [],
  approvals: [],
  centerPriority: [MAC, WIN],
  feishuHolder: MAC,
  ...over,
});

describe("AccountSettings", () => {
  it("没登录：可展开自定义中继地址，点 Sign in with GitHub 开始登录并可取消", async () => {
    const api = withAccount({ state: "signed_out", lastError: "你在 GitHub 上拒绝了授权" });
    expect(await screen.findByRole("alert")).toHaveTextContent("你在 GitHub 上拒绝了授权");
    fireEvent.click(screen.getByRole("button", { name: "Relay…" }));
    fireEvent.change(screen.getByLabelText("Relay URL"), { target: { value: "https://relay.self.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
    expect(await screen.findByText("Enter WDJB-MJHT on GitHub")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /github\.com\/login\/device/ })).toHaveAttribute("href", "https://github.com/login/device");
    expect(api.callsTo("POST", /^\/api\/account\/login$/)[0]?.body).toEqual({ relayUrl: "https://relay.self.test" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: "Sign in with GitHub" })).toBeInTheDocument();
    expect(api.callsTo("DELETE", /^\/api\/account\/login$/)).toHaveLength(1);
  });

  it("等批准：核对码出来后显示 3+3 位的码，点 Match 发 answer { match: true }", async () => {
    const api = withAccount({
      state: "awaiting_approval",
      login,
      relay: "connected",
      approval: { requestId: MAC, device: { id: MAC, name: "Mac", platform: "darwin", fingerprint: FP }, requestedAt: 0, expiresAt: Date.now() + 600_000, sas: "042917" },
    });
    expect(await screen.findByTestId("sas-code")).toHaveTextContent("042 917");
    fireEvent.click(screen.getByRole("button", { name: "Match" }));
    expect(await screen.findByRole("region", { name: "Hub order" })).toBeInTheDocument();
    expect(api.callsTo("POST", new RegExp(`^/api/account/approvals/${MAC}/answer$`))[0]?.body).toEqual({ match: true });
  });

  it("已登录：新电脑先 Verify；中心顺序能上下挪，标出现在挂着飞书的那台", async () => {
    const api = withAccount(
      signedIn({
        devices: [
          { id: MAC, name: "Mac", platform: "darwin", fingerprint: FP, self: true, online: true, link: "local", lastSeenAt: null },
          { id: WIN, name: "Win", platform: "win32", fingerprint: FP, self: false, online: true, link: "lan", lastSeenAt: null },
        ],
        approvals: [{ requestId: LINUX, device: { id: LINUX, name: "Linux", platform: "linux", fingerprint: FP }, requestedAt: 0, expiresAt: 1, sas: null }],
      }),
    );
    const waiting = await screen.findByRole("region", { name: "Waiting to join" });
    fireEvent.click(within(waiting).getByRole("button", { name: "Verify" }));
    expect(await within(waiting).findByTestId("sas-code")).toHaveTextContent("042 917");
    expect(api.callsTo("POST", new RegExp(`^/api/account/approvals/${LINUX}/begin$`))).toHaveLength(1);

    const order = screen.getByRole("region", { name: "Hub order" });
    expect(within(order).getByText("Hosting the Feishu bot now")).toBeInTheDocument();
    expect(within(order).getByRole("button", { name: "Move Mac up" })).toBeDisabled();
    fireEvent.click(within(order).getByRole("button", { name: "Move Win up" }));
    await waitFor(() => expect(within(order).getByText("1. Win")).toBeInTheDocument());
    expect(api.callsTo("PUT", /^\/api\/account\/priority$/)[0]?.body).toEqual({ priority: [WIN, MAC] });
  });

  it("排第一的电脑离线、第二顺位电脑接管飞书时，中心顺序里同时标出 Offline 和当前持有者", async () => {
    withAccount(
      signedIn({
        devices: [
          { id: WIN, name: "Win", platform: "win32", fingerprint: FP, self: true, online: true, link: "local", lastSeenAt: null },
          { id: MAC, name: "Tokyo", platform: "linux", fingerprint: FP, self: false, online: false, link: null, lastSeenAt: 1_700_000_000_000 },
        ],
        centerPriority: [MAC, WIN],
        feishuHolder: WIN,
      }),
    );
    const order = await screen.findByRole("region", { name: "Hub order" });
    expect(within(order).getByText("1. Tokyo")).toBeInTheDocument();
    expect(within(order).getByText("Offline")).toBeInTheDocument();
    expect(within(order).getByText("2. Win")).toBeInTheDocument();
    expect(within(order).getByText("Hosting the Feishu bot now")).toBeInTheDocument();
  });

  it("离线退出账号且未送达其他设备时，退出后展示手动移除提示", async () => {
    const api = withAccount(
      signedIn({
        relay: "unreachable",
        devices: [{ id: MAC, name: "Mac", platform: "darwin", fingerprint: FP, self: true, online: true, link: "local", lastSeenAt: null }],
      }),
    );
    api.accountLogout = () => ({
      status: 200,
      body: {
        state: "signed_out",
        lastError: "已在本机退出；因未连上中继且无在线设备，请在其他设备上手动移除本机",
        remoteRevokePending: true,
      } satisfies AccountStatusView,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请在其他设备上手动移除本机");
    expect(api.callsTo("POST", /^\/api\/account\/logout$/)).toHaveLength(1);
  });
});
