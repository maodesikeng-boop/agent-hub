// 联机 P0：接口约定（docs/multi-device-design.md 第 11 节）。只有类型和路径，这里钉住路径格式和几条类型约束。
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  API_PATHS,
  DEVICE_PROXY_PREFIX,
  PEER_DEVICE_HEADER,
  TAILSCALE_USER_LOGIN_HEADER,
  devicePath,
  isDeviceId,
  type ApiErrorBody,
  type ApiErrorCode,
  type DeviceInfo,
  type PushPayload,
  type WsClientMessage,
} from "./index.ts";

const MAC = "3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f";

describe("联机接口路径", () => {
  it("设备、配对、推送、浏览器会话", () => {
    expect(API_PATHS.devices).toBe("/api/devices");
    expect(API_PATHS.device(MAC)).toBe(`/api/devices/${MAC}`);
    expect(API_PATHS.deviceInvites).toBe("/api/devices/invites");
    expect(API_PATHS.peerPair).toBe("/api/peer/pair");
    expect(API_PATHS.peerDevices).toBe("/api/peer/devices");
    expect(API_PATHS.peerUnpair).toBe("/api/peer/unpair");
    expect(API_PATHS.pushKey).toBe("/api/push/key");
    expect(API_PATHS.pushSubscriptions).toBe("/api/push/subscriptions");
    expect(API_PATHS.pushUnsubscribe).toBe("/api/push/unsubscribe");
    expect(API_PATHS.browserSessions).toBe("/api/sessions");
    expect(API_PATHS.browserSession("s1")).toBe("/api/sessions/s1");
    expect(API_PATHS.logoutAll).toBe("/api/sessions/logout-all");
    expect(API_PATHS.loginLinks).toBe("/api/login-links");
  });

  it("别的设备的接口 = /d/<设备编号> + 原路径", () => {
    expect(DEVICE_PROXY_PREFIX).toBe("/d");
    expect(devicePath(MAC, API_PATHS.state)).toBe(`/d/${MAC}/api/state`);
    expect(devicePath(MAC, API_PATHS.messages(7))).toBe(`/d/${MAC}/api/conversations/7/messages`);
    // 本机（null）就是原路径，网页的 base 是 ""
    expect(devicePath(null, API_PATHS.ws)).toBe("/api/ws");
  });

  it("设备编号只认小写 UUID（转发前先查，挡住 ../ 之类）", () => {
    expect(isDeviceId(MAC)).toBe(true);
    expect(isDeviceId(MAC.toUpperCase())).toBe(false);
    expect(isDeviceId("..")).toBe(false);
    expect(isDeviceId(`${MAC}/..`)).toBe(false);
    expect(isDeviceId("")).toBe(false);
  });

  it("身份头、设备头都是小写（Node 收到的头名是小写）", () => {
    expect(TAILSCALE_USER_LOGIN_HEADER).toBe("tailscale-user-login");
    expect(PEER_DEVICE_HEADER).toBe("x-agent-hub-device");
  });
});

describe("联机接口类型", () => {
  it("错误码多一个 device_offline", () => {
    expectTypeOf<"device_offline">().toExtend<ApiErrorCode>();
    expectTypeOf<ApiErrorBody["code"]>().toEqualTypeOf<ApiErrorCode | undefined>();
  });

  it("推送只带标题不带正文（用户拍板）", () => {
    expectTypeOf<PushPayload>().toEqualTypeOf<{ title: string; url: string; tag: string }>();
  });

  it("设备清单一项", () => {
    expectTypeOf<DeviceInfo>().toEqualTypeOf<{ id: string; name: string; platform: string; self: boolean; url: string | null }>();
  });

  it("网页 → 服务端的 WebSocket 消息只有前台上报", () => {
    expectTypeOf<WsClientMessage["type"]>().toEqualTypeOf<"presence">();
  });
});
