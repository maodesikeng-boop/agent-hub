import { describe, it } from "vitest";

describe("runFeishuCli", () => {
  it.todo("connect 打出二维码，轮询到 connected 后打印应用和机器人名，退出码 0；被拒绝或过期退出码 1");
  it.todo("connect --manual 从标准输入读 App ID 和 App Secret，App Secret 不出现在任何输出里");
  it.todo("policy 把唤醒方式和访客档位交给守护进程，参数值不对时打印用法、退出码 2");
  it.todo("守护进程连不上时退出码 1，错误信息写清楚");
  it.todo("不认识的子命令打印用法，退出码 2");
});
