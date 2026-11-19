import { describe, it } from "vitest";

describe("stepCenterLease", () => {
  it.todo("候选收到授给本机的 grant 变成 holder 并发 connect");
  it.todo("holder 超过 ttl - fenceMargin 没收到回执，下一次 tick 变成 candidate 并发 disconnect");
  it.todo("holder 收到授给别的设备或 epoch 更小的 grant 时发 disconnect");
  it.todo("收到 yield 先 disconnect，disconnected 之后才 release");
  it.todo("中继连不上满 orphanMs 且本机是中心顺序第一台时降级持有并发 connect");
  it.todo("不是中心顺序第一台时中继连不上多久都不降级");
  it.todo("降级持有时中继连上，发 disconnect 回到 candidate 重新 claim");
  it.todo("eligible 变成 false 时持有的先 disconnect 再 release，回到 idle");
  it.todo("任何一步都不会在没 disconnect 的情况下离开持有状态");
});

describe("createCenterLease", () => {
  it.todo("候选时每 MESH_LEASE_RENEW_MS 发一次 lease.claim，idle 时不发");
  it.todo("持有时 holding() 为 true，onChange 收到本机编号");
  it.todo("close 时持有的先断开长连接再 release");
});
