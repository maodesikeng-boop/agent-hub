import { describe, it } from "vitest";

describe("registerWithRelay", () => {
  it.todo("请求体带设备证书、公钥和签名，签名能被中继验过");
  it.todo("中继拒绝时抛错，message 不带中继和网络的原文");
});

describe("createRelayClient", () => {
  it.todo("连上后回 challenge 的签名，收到 welcome 后状态变成 connected 并推 devices、presence、self");
  it.todo("连上后马上报一次候选地址；refreshCandidates 时再报");
  it.todo("断开后按 MESH_RELAY_BACKOFF_MIN_MS 起翻倍退避重连，封顶 MESH_RELAY_BACKOFF_MAX_MS，连上稳定后清零");
  it.todo("没连上时 send 回 false，不排队");
  it.todo("openChannel 对方接起后两边的字节流互通");
  it.todo("openChannel 收到 dial.failed 时按 code 抛 RelayDialError");
  it.todo("openChannel 超过 MESH_DIAL_TIMEOUT_MS 抛 timeout");
  it.todo("收到 removed 时推 removed 事件并不再重连");
  it.todo("close 后关掉所有数据通道，不再重连");
});
