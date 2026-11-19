// 账号组网对守护进程其余部分的出口（docs/account-mesh-design.md）。daemon.ts 建一个 Mesh，界面服务、peers/、总助跨设备派活、飞书都只认这里。
// 不变量：没登录时 Mesh 照样能建，dial 一律失败、没有租约，单机功能不受影响；登录、退出、被移除都不用重启守护进程。
import type { DeviceId } from "../../shared/api.ts";
import type { AccountStatusView, MeshLeaseName } from "../../shared/mesh.ts";
import type { MeshDialer } from "./dialer.ts";
import type { CenterLease } from "./lease.ts";
import type { MeshTrust } from "./trust.ts";

export { createAccountService, readAccountFile, type AccountFile, type AccountService } from "./account.ts";
export { createMeshDialer, localCandidates, startMeshListener, type MeshConnection, type MeshDialer, type MeshListener } from "./dialer.ts";
export { loadOrCreateMeshIdentity, type MeshIdentity } from "./identity.ts";
export { createCenterLease, stepCenterLease, type CenterLease } from "./lease.ts";
export { createRelayClient, registerWithRelay, RelayDialError, type RelayClient } from "./relay-client.ts";
export { acceptTrustStatement, openMeshTrust, signTrustStatement, startApproval, type MeshTrust, type TrustedDevice } from "./trust.ts";

export interface MeshOptions {
  /** state/mesh/（设备密钥）。 */
  identityDir: string;
  /** state/account.json。 */
  accountFile: string;
  /** state/peers.json（v2 信任表）。 */
  trustFile: string;
  device: { id: DeviceId; name: string };
  platform: string;
  /** 默认中继网址（设置里可以换）。 */
  relayUrl: string;
  githubClientId: string;
  /** 组网入口端口（MESH_LISTEN_PORT；测试给 0）。 */
  listenPort: number;
  /** 测试只听回环。 */
  listenHost?: string;
  fetch?: typeof fetch;
  now?: () => number;
  log: (line: string) => void;
}

export interface Mesh {
  readonly selfId: DeviceId;
  readonly trust: MeshTrust;
  readonly dialer: MeshDialer;
  /** GET /api/account。 */
  status(): AccountStatusView;
  startLogin(input?: { relayUrl?: string }): Promise<AccountStatusView>;
  cancelLogin(): void;
  logout(): Promise<void>;
  /** 本机用户在“等批准”那一条上点“核对”：开始批准仪式（本机当批准方）。 */
  beginApproval(requestId: string): Promise<AccountStatusView>;
  /** 本机用户点“一致”或“不一致”。 */
  answerApproval(requestId: string, match: boolean): Promise<AccountStatusView>;
  /** 后置：只收已在账号里的设备，去重；发给中继，中继推回后 status() 才变。 */
  setCenterPriority(priority: DeviceId[]): Promise<void>;
  /** 后置：本机删掉、签撤销声明发给其他可信设备、告诉中继删掉它；不能删本机（本机用 logout）。 */
  removeDevice(id: DeviceId): Promise<void>;
  /** 中继说它在线（离线、不知道都是 false）。 */
  isOnline(id: DeviceId): boolean;
  /** 经组网对一台可信设备发 HTTP 请求（走 dialer.agentFor）。对方离线、不在信任表里抛错。 */
  request(id: DeviceId, path: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }): Promise<Response>;
  lease(name: MeshLeaseName): CenterLease;
  /** 账号状态、设备表、在线、租约任一变化时调（界面服务据此推 account.updated）。 */
  onChange(listener: () => void): () => void;
  close(): Promise<void>;
}

/** 后置：读设备密钥（没有不生成，登录时才生成）、信任表、account.json；已登录就连中继、开组网入口。 */
export function createMesh(options: MeshOptions): Promise<Mesh> {
  throw new Error("未实现");
}
