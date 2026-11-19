import { describe, it } from "vitest";

describe("parseRelayClientFrame / parseRelayServerFrame / encodeRelayFrame", () => {
  it.todo("每种帧 encode 后 parse 能原样读回");
  it.todo("未知 type、缺字段、字段类型不对、多余字段回 null");
  it.todo("超过 RELAY_MAX_CONTROL_FRAME_BYTES 的文本回 null，encode 超长抛 RangeError");
  it.todo("候选地址超过 MESH_CANDIDATES_MAX 个、host 不是 IP 字面量、端口越界回 null");
  it.todo("signal 的 payload 超过 RELAY_MAX_SIGNAL_BYTES 回 null");
  it.todo("priority.set 里有重复设备或超过 MESH_MAX_DEVICES_PER_ACCOUNT 台回 null");
});

describe("isRelayToken", () => {
  it.todo("22 个 base64url 字符认，别的长度和字符不认");
});

describe("relayRegisterMessage / relayControlMessage", () => {
  it.todo("同样输入两次结果逐字节相同");
  it.todo("中继 origin、账号、设备编号、指纹、challenge 任一不同结果不同");
  it.todo("登记用的和登入用的不会相等（防拿登记签名冒充登入）");
});
