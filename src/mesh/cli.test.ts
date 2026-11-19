import { describe, it } from "vitest";

describe("runMeshCli", () => {
  it.todo("login 打印 8 位码和 github.com/login/device，登录完成后退出码 0");
  it.todo("login 后本机要批准时打印核对码，输入 y 后等到加入");
  it.todo("核对时输入 n 退出码 1，批准作废");
  it.todo("status 打印账号、中继状态、设备列表和当前中心");
  it.todo("approve 对一条等批准的请求开始核对，输入 y 后完成");
  it.todo("priority 按给的顺序设中心顺序，不在账号里的设备报错");
  it.todo("守护进程连不上时退出码 1，提示先启动守护进程");
  it.todo("不认识的子命令打印用法，退出码 2");
});
