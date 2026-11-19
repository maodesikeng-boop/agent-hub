import { describe, it } from "vitest";

describe("verifyGithubToken", () => {
  it.todo("GET /user 回 200 时取数字 id 和登录名，请求带 Bearer token");
  it.todo("401、403 回 null");
  it.todo("网络错误和 5xx 抛错，不当成登录失败");
});

describe("accountIdOf", () => {
  it.todo("同一个数字 id 永远得到同一个账号编号，登录名不参与");
  it.todo("结果能被 parseAccountId 认");
});

describe("fingerprintOfPem", () => {
  it.todo("和守护进程 fingerprintOfCertPem 对同一张证书算出的一样");
  it.todo("不是 PEM 证书时抛错");
});

describe("verifyDeviceSignature", () => {
  it.todo("设备私钥签的对得上");
  it.todo("消息改一个字节、换一把公钥都回 false");
  it.todo("公钥或签名格式不对回 false，不抛错");
});
