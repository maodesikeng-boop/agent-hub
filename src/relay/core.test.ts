import { describe, it } from "vitest";

describe("createRelayAccountRoom：登记与登入", () => {
  it.todo("账号里第一台登记后直接 active，第二台起是 pending");
  it.todo("登记签名对不上回 unauthorized，账号不变");
  it.todo("设备满 MESH_MAX_DEVICES_PER_ACCOUNT 台后再登记回 too_many_devices");
  it.todo("同一设备编号换证书再登记，按新证书覆盖并回到 pending");
  it.todo("控制连接先收到 challenge，hello 签名对得上才收到 welcome");
  it.todo("hello 签名不对或设备不在账号里时发 error 后关闭");
  it.todo("pending 设备超过 RELAY_PENDING_DEVICE_TTL_MS 没被激活就从账号里删掉");
  it.todo("device.remove 后被删的设备收到 removed，之后登入回 removed");
  it.todo("只有 active 设备能 device.activate、device.remove、priority.set");
});

describe("createRelayAccountRoom：在线与转发", () => {
  it.todo("设备登入、断开、报候选地址时，账号里在线的 active 设备收到 presence");
  it.todo("别的账号的设备收不到这个账号的 presence 和 devices");
  it.todo("signal 只转给同账号的设备；pending 设备只能和 active 设备互发");
  it.todo("每台每秒超过 RELAY_CONTROL_FRAMES_PER_SECOND 条控制帧时断开它");
  it.todo("不合规的控制帧回 bad_frame 并断开");
});

describe("createRelayAccountRoom：拨号与数据通道", () => {
  it.todo("dial 后对方收到 incoming，两端开通道后帧原样互转");
  it.todo("拨 pending 设备、离线设备、别的账号的设备回 dial.failed");
  it.todo("没在 dial 里登记的 channel、会话令牌不对的一端被拒");
  it.todo("超过 RELAY_MAX_DATA_FRAME_BYTES 的帧关掉通道");
  it.todo("每台同时超过 RELAY_MAX_CHANNELS_PER_DEVICE 条通道时新通道被拒");
  it.todo("账号当天超过 RELAY_ACCOUNT_DAILY_BYTES 后新通道回 quota_exceeded，次日恢复");
  it.todo("一端关了另一端也关；超过 RELAY_CHANNEL_IDLE_MS 没有数据两端都关");
  it.todo("对方 RELAY_CHANNEL_ACCEPT_TIMEOUT_MS 内没接起，拨号方收到 dial.failed");
});

describe("createRelayAccountRoom：中心租约", () => {
  it.todo("中心顺序里排最前、在线且 claim 过的设备拿到租约，epoch 从 1 开始");
  it.todo("持有者 MESH_LEASE_TTL_MS 没续约，下一条消息到来时改授给下一台，epoch 加 1");
  it.todo("持有者控制连接关闭时立刻改授");
  it.todo("排得更靠前的设备回来后现持有者收到 lease.yield，release 后改授");
  it.todo("现持有者收到 yield 后不 release，等它的租约到期再改授");
  it.todo("任何时刻同一个租约名最多一台持有");
  it.todo("不在中心顺序里的设备 claim 永远拿不到租约");
  it.todo("priority.set 改了顺序后按新顺序裁决并推给在线设备");
  it.todo("休眠醒来按 attachment 恢复在线和 claim 时间，不丢租约");
});
