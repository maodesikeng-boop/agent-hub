import { describe, it } from "vitest";

describe("localCandidates", () => {
  it.todo("只收私有 IPv4、IPv6 ULA 和链路本地，跳过回环、内部网卡和公网地址");
  it.todo("去重后最多 MESH_CANDIDATES_MAX 个，IPv4 在前，顺序稳定");
});

describe("createMeshDialer + startMeshListener", () => {
  it.todo("两台可信设备直连握手成功，linkOf 回 lan");
  it.todo("直连地址不通时经中继连上，linkOf 回 relay");
  it.todo("直连和中继都通时直连胜出，中继那条被关掉");
  it.todo("直连失败后 MESH_DIRECT_RETRY_MS 内不再试直连，networkChanged 后立刻再试");
  it.todo("对方证书不在信任表里时握手失败，不调 onConnection");
  it.todo("对方出示的是另一台可信设备的证书时拨号失败（防冒名接听）");
  it.todo("没出示证书或 ALPN 不对时握手失败");
  it.todo("拨不在信任表里的设备直接抛错，不发任何网络请求");
  it.todo("agentFor 同一台设备复用 keep-alive 连接，forget 后关掉");
  it.todo("中继上看到的数据帧都是 TLS 记录，没有明文");
});
