import { describe, it } from "vitest";

describe("parseAccountId / parseDeviceFingerprint", () => {
  it.todo("acct_ 加 26 位小写 base32 的账号编号认，别的形状回 null");
  it.todo("64 位十六进制指纹认并转成小写，长度不对或带别的字符回 null");
});

describe("pickCenter", () => {
  it.todo("返回中心顺序里第一个在候选集合中的设备");
  it.todo("排前的不在候选里时跳过它，选下一个");
  it.todo("候选里有、但不在中心顺序里的设备永远不选");
  it.todo("一个候选都没有时回 null");
});

describe("meshSasCode", () => {
  it.todo("结果是 MESH_SAS_DIGITS 位十进制数字，不足补 0");
  it.todo("交换两方的顺序结果相同");
  it.todo("任一方的指纹或随机数变了结果就变");
  it.todo("同样的输入每次结果一样");
});
