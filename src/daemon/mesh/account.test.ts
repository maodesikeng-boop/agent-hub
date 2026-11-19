import { describe, it } from "vitest";

describe("requestGithubDeviceCode / pollGithubDeviceToken", () => {
  it.todo("请求设备码只带 client_id，不带 client_secret");
  it.todo("authorization_pending、slow_down、access_denied、expired_token 各自分类");
  it.todo("slow_down 时按 GitHub 给的新间隔");
});

describe("readAccountFile / writeAccountFile", () => {
  it.todo("没有文件回 null");
  it.todo("写入后权限 0600，读回相同内容");
  it.todo("内容不对时抛错，错误里写文件路径");
});

describe("createAccountService", () => {
  it.todo("startLogin 立刻回 signing_in 和 8 位码");
  it.todo("用户授权后登记进中继、写 account.json、变成 signed_in 并通知 onChange");
  it.todo("登记请求带设备证书、公钥和签名，不带别的令牌");
  it.todo("GitHub token 不写盘、不进日志、不出现在 state() 里");
  it.todo("用户拒绝或码过期时回到 signed_out，lastError 写原因");
  it.todo("cancelLogin 后不再轮询");
  it.todo("logout 删 account.json，设备密钥留着");
  it.todo("已经登录时再 startLogin 抛错");
});
