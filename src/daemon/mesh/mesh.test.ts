import { describe, it } from "vitest";

describe("createMesh", () => {
  it.todo("没登录时能建，status 是 signed_out，dial 失败，没有租约");
  it.todo("已登录时启动就连中继、开组网入口");
  it.todo("登录完成后不重启守护进程就能拨通账号里的设备");
  it.todo("beginApproval、answerApproval 走完后新设备进信任表并推给其他可信设备");
  it.todo("setCenterPriority 只收账号里的设备并去重");
  it.todo("removeDevice 后那台设备的连接关掉、拨号失败，其他可信设备也删掉它");
  it.todo("不能 removeDevice 本机");
  it.todo("被中继告知已移除时清空 account.json，status 回到 signed_out");
  it.todo("request 走组网连接，对方离线时抛错");
  it.todo("status 里的 devices 带在线和连法，approvals 带核对码");
});
