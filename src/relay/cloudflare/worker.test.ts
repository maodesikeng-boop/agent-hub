// 实现时在 Workers 运行时里跑（Cloudflare 官方的 vitest 集成），这里先列行为。
import { describe, it } from "vitest";

describe("handleRelayRequest", () => {
  it.todo("POST /v1/register 验过 GitHub 后交给账号编号对应的 Durable Object");
  it.todo("/v1/accounts/<账号>/control 和 channels 的 WebSocket 升级交给同一个 Durable Object");
  it.todo("别的路径回 404，不是 WebSocket 升级的账号路径回 426");
  it.todo("同一 IP 每分钟登记超过 RELAY_REGISTER_PER_IP_PER_MINUTE 次回 429");
});

describe("RelayAccountObject", () => {
  it.todo("WebSocket 用 acceptWebSocket 收下，空闲时能休眠");
  it.todo("休眠醒来按 attachment 恢复在线、claim 时间和租约持有者");
  it.todo("每条消息处理完存 attachment、调 sweep，不开定时器");
  it.todo("控制连接关闭时交给 room，持有者断开马上改授租约");
});
