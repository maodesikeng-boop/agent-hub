// 中继的身份校验（docs/account-mesh-design.md「账号与登录」「中继」）：验 GitHub token、算账号编号、验设备签名。
// 只用 WebCrypto 和 fetch，Cloudflare Workers 和 Node 都能跑。中继没有任何服务端密钥：GitHub 设备码登录不需要 client secret，
// 验 token 用的是用户自己登录拿到的 token，用完就丢，不存。
import type { AccountId, AccountLogin, DeviceFingerprint } from "../shared/mesh.ts";

/** GitHub REST 的默认地址；自建中继和测试可以换。 */
export const GITHUB_API_ORIGIN = "https://api.github.com";

/**
 * 用用户的 GitHub access token 问 GET /user。
 * 后置：200 且带数字 id 回 { provider: "github", userId: 数字 id 的十进制, login }；401、403 回 null；网络错误和 5xx 抛错（调用方回 502，不当成登录失败）。
 */
export function verifyGithubToken(token: string, options?: { fetch?: typeof fetch; apiOrigin?: string }): Promise<AccountLogin | null> {
  throw new Error("未实现");
}

/** 后置：同一个登录方式和数字 id 永远得到同一个账号编号；登录名变了账号不变；parseAccountId 认得结果。 */
export function accountIdOf(login: Pick<AccountLogin, "provider" | "userId">): Promise<AccountId> {
  throw new Error("未实现");
}

/** 后置：PEM 证书的 DER 的 SHA-256（小写十六进制）；不是一张 PEM 证书时抛错。和守护进程 identity.ts 算出的一样。 */
export function fingerprintOfPem(certPem: string): Promise<DeviceFingerprint> {
  throw new Error("未实现");
}

/** 后置：publicKey（SPKI DER 的 base64url，Ed25519）对 message 的签名对得上回 true；公钥、签名格式不对回 false，不抛错。 */
export function verifyDeviceSignature(publicKey: string, message: Uint8Array, signature: string): Promise<boolean> {
  throw new Error("未实现");
}
