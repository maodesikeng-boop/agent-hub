// 账号登录（docs/account-mesh-design.md「账号与登录」）：GitHub 设备码登录、把本机登记进中继、state/account.json、退出。
// 不变量：GitHub access token 只在登录那几秒的内存里，登记完就丢，不写盘、不进日志；state/account.json 是 0600，里面没有任何令牌。
import type { DeviceId } from "../../shared/api.ts";
import type { AccountId, AccountLogin, MeshDeviceState } from "../../shared/mesh.ts";
import type { MeshIdentity } from "./identity.ts";

/** GitHub 设备码登录的第一步结果。 */
export interface GithubDeviceCode {
  deviceCode: string;
  /** 给人输入的 8 位码，比如 WDJB-MJHT。 */
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalMs: number;
}

/** 后置：POST github.com/login/device/code（只带 client_id，scope 为空）；GitHub 回错误时抛错，message 是给人看的。 */
export function requestGithubDeviceCode(clientId: string, options?: { fetch?: typeof fetch; now?: () => number }): Promise<GithubDeviceCode> {
  throw new Error("未实现");
}

export type GithubPollResult =
  | { kind: "pending" }
  | { kind: "slow_down"; intervalMs: number }
  | { kind: "token"; accessToken: string }
  | { kind: "denied" }
  | { kind: "expired" };

/** 后置：按 GitHub 的 error 字段分类（authorization_pending、slow_down、access_denied、expired_token）；拿到 token 回 token；网络错误抛错。 */
export function pollGithubDeviceToken(clientId: string, deviceCode: string, options?: { fetch?: typeof fetch }): Promise<GithubPollResult> {
  throw new Error("未实现");
}

/** state/account.json。 */
export interface AccountFile {
  version: 1;
  relayUrl: string;
  accountId: AccountId;
  login: AccountLogin;
  state: MeshDeviceState;
}

/** 后置：没有文件回 null；内容不对抛错，错误里写文件路径和怎么办（删掉重新登录）。 */
export function readAccountFile(file: string): AccountFile | null {
  throw new Error("未实现");
}

/** 后置：原子写入，权限 0600。 */
export function writeAccountFile(file: string, data: AccountFile): void {
  throw new Error("未实现");
}

/** 登录进行到哪一步（AccountStatusView 的前半段由它给）。 */
export type AccountLoginState =
  | { kind: "signed_out" }
  | { kind: "signing_in"; userCode: string; verificationUri: string; expiresAt: number }
  | { kind: "signed_in"; account: AccountFile };

export interface AccountServiceOptions {
  file: string;
  identity: MeshIdentity;
  device: { id: DeviceId; name: string; platform: string };
  /** 默认中继网址；startLogin 可以换。 */
  relayUrl: string;
  githubClientId: string;
  fetch?: typeof fetch;
  now?: () => number;
  log: (line: string) => void;
}

export interface AccountService {
  state(): AccountLoginState;
  /**
   * 开始 GitHub 设备码登录。
   * 后置：立刻返回 signing_in（带 8 位码）；之后后台轮询，用户授权后把本机登记进中继、写 account.json、变成 signed_in 并通知 onChange；
   * 用户拒绝、码过期、中继拒绝时回到 signed_out 并通知，原因进 lastError。已经 signed_in 时抛错。
   */
  startLogin(input?: { relayUrl?: string }): Promise<AccountLoginState>;
  /** 后置：停止轮询，回到 signed_out；不在登录中时什么也不做。 */
  cancelLogin(): void;
  /** 后置：本机登记状态变了（中继把本机从 pending 改成 active）时写回 account.json。 */
  markState(state: MeshDeviceState): void;
  /** 后置：删 account.json、回到 signed_out、通知 onChange。设备密钥留着，下次登录沿用。 */
  logout(): Promise<void>;
  /** 最近一次登录失败的原因（给人看的，不带网络原文）。 */
  lastError(): string | null;
  onChange(listener: (state: AccountLoginState) => void): () => void;
  close(): void;
}

export function createAccountService(options: AccountServiceOptions): AccountService {
  throw new Error("未实现");
}
