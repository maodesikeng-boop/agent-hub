// 账号组网端到端（docs/account-mesh-design.md「验收方法」）：本机起一个 Node 中继和三个真守护进程（端口 0、各自数据目录、假的 GitHub 接口）。
// 取代 multi-device.test.ts（邀请码配对那一套随旧配对一起删）。
import { describe, it } from "vitest";

describe("账号组网", () => {
  it.todo("三台登录同一账号：第一台直接可用，后两台等批准，核对码一致、两边点一致后出现在三台的设备列表里");
  it.todo("从第一台的网页经 /d/ 打开另外两台的对话、发消息、收到回复");
  it.todo("回环地址当局域网候选时连法是 lan，屏蔽候选后是 relay，功能一样");
  it.todo("停掉一台，另两台 MESH_LEASE_TTL_MS 内显示离线；再起来自动恢复");
  it.todo("移除一台后它的请求被拒，它自己回到未登录");
  it.todo("中继只见到 TLS 记录：自建中继的数据帧首字节都是 0x17 或握手记录，搜不到消息正文");
});

describe("全账号一个飞书机器人（假飞书传输层）", () => {
  it.todo("只有中心顺序排第一的在线设备连长连接");
  it.todo("发到第二台项目群的消息进第二台的账本，只一次");
  it.todo("停掉持有者，MESH_LEASE_TTL_MS + MESH_LEASE_RENEW_MS 内下一台持有并接着收");
  it.todo("排前的设备回来后租约让回给它，期间不丢消息");
  it.todo("第二台离线时群里立刻回离线提示并暂存，第二台上线后送达");
  it.todo("飞书凭证在一台接入后出现在另外两台，中继的日志和存储里搜不到 App Secret");
});
