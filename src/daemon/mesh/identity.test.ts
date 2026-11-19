import { describe, it } from "vitest";

describe("loadOrCreateMeshIdentity", () => {
  it.todo("第一次生成 key.pem 和 cert.pem，私钥文件权限 0600、目录 0700");
  it.todo("再调一次读回同一份，指纹不变");
  it.todo("证书 CN 等于设备编号");
  it.todo("私钥和证书对不上、CN 不是这台的设备编号、文件坏了时抛错，错误里写文件路径");
  it.todo("sign 出的签名能被 verifyWithCert 和 relay/auth.ts 的 verifyDeviceSignature 验过");
});

describe("fingerprintOfCertPem / deviceIdOfCertPem", () => {
  it.todo("指纹和 relay/auth.ts 的 fingerprintOfPem 对同一张证书算出的一样");
  it.todo("CN 不是合法设备编号时 deviceIdOfCertPem 回 null");
});

describe("verifyWithCert", () => {
  it.todo("消息改一个字节、换一张证书都回 false");
  it.todo("证书或签名格式不对回 false，不抛错");
});
