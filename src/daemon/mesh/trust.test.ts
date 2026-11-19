import { describe, it } from "vitest";

describe("openMeshTrust", () => {
  it.todo("没有 peers.json 时建一张只有本机的表");
  it.todo("读到 v1 格式时备份成 peers.v1.json，从只有本机的表开始");
  it.todo("内容不对时抛错，错误里写文件路径");
  it.todo("verifyPeerCert：指纹在表里且 CN 等于记下的编号才认");
  it.todo("verifyPeerCert：指纹在表里但 CN 换成别的设备编号时不认");
  it.todo("add 写盘后重新打开还在；表满 MESH_MAX_DEVICES_PER_ACCOUNT 台时抛错");
  it.todo("remove 记墓碑，不能删本机");
});

describe("signTrustStatement / acceptTrustStatement", () => {
  it.todo("签名人在本机表里、签名对得上的批准声明把设备加进表");
  it.todo("签名人不在表里或签名被改过时回 rejected，表不变");
  it.todo("批准一张已被撤销的证书回 rejected");
  it.todo("重复收到同一份声明回 ignored");
  it.todo("撤销本机的声明回 applied");
});

describe("startApproval", () => {
  it.todo("两边按 offer、commit、reveal、reveal、confirm 走完后都是 approved，核对码相同");
  it.todo("只有一边 confirm 时两边都还是 pending");
  it.todo("中继替换了任一方的证书时两边算出的核对码不同");
  it.todo("新设备 reveal 的随机数和 commit 的哈希对不上时 aborted");
  it.todo("顺序不对（没 offer 就 commit、重复 reveal）时 aborted 并回 abort");
  it.todo("对方证书的 CN 不是预期的设备编号时 aborted");
  it.todo("核对码出来之前 confirmLocal 抛错");
  it.todo("cancel 和过期都变成 aborted，之后再收什么都不变");
});
