import { describe, it } from "vitest";

describe("startNodeRelay", () => {
  it.todo("port 给 0 时随便挑一个空端口，返回实际端口");
  it.todo("POST /v1/register 用假 GitHub 验过后把设备登记进账号");
  it.todo("控制连接和数据通道按 RELAY_PATHS 接到对应账号的 RelayAccountRoom");
  it.todo("两个账号的设备互相看不到、拨不通");
  it.todo("重启后设备表和中心顺序还在，在线和租约从头来");
  it.todo("close 后所有连接关掉、端口释放");
  it.todo("日志里没有数据通道的内容和任何令牌");
});

describe("runRelayCli", () => {
  it.todo("缺 --port 或 --origin 时打印用法，返回 2");
  it.todo("收到 SIGTERM 时关掉中继再退出，返回 0");
});
