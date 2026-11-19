// 设备密钥和证书（docs/account-mesh-design.md「设备身份与信任」）：首次登录时生成 Ed25519 私钥和自签证书，证书 CN 是设备编号。
// Node 能用证书不能生成证书，生成用 @peculiar/x509（实现时 pnpm add，整个仓库只有这个文件引它）。
// 不变量：私钥只在 state/mesh/key.pem（0600，在 READONLY_SECRET_STATE_FILES 里）；设备指纹 = 证书 DER 的 SHA-256，和 relay/auth.ts 的 fingerprintOfPem 一致。
import type { DeviceId } from "../../shared/api.ts";
import type { DeviceFingerprint } from "../../shared/mesh.ts";

export interface MeshIdentity {
  deviceId: DeviceId;
  fingerprint: DeviceFingerprint;
  certPem: string;
  keyPem: string;
  /** Ed25519 公钥（SPKI DER 的 base64url），登记到中继用。 */
  publicKey: string;
  /** 用设备私钥签名，返回 base64url。 */
  sign(message: Uint8Array): string;
}

/**
 * 读 <dir>/key.pem 和 <dir>/cert.pem；没有就生成一份写进去（目录 0700，私钥 0600）。
 * 后置：同一个目录多次调用得到同一个指纹；证书 CN 等于 deviceId；文件坏了、两份对不上、CN 不是 deviceId 时抛错，错误里写是哪个文件。
 */
export function loadOrCreateMeshIdentity(dir: string, deviceId: DeviceId): Promise<MeshIdentity> {
  throw new Error("未实现");
}

/** 后置：PEM 证书 DER 的 SHA-256（小写十六进制）；不是一张 PEM 证书时抛错。 */
export function fingerprintOfCertPem(certPem: string): DeviceFingerprint {
  throw new Error("未实现");
}

/** 后置：证书 CN 是合法设备编号时返回它，否则 null。 */
export function deviceIdOfCertPem(certPem: string): DeviceId | null {
  throw new Error("未实现");
}

/** 后置：用证书里的公钥验 base64url 签名，对得上回 true；证书或签名格式不对回 false，不抛错。 */
export function verifyWithCert(certPem: string, message: Uint8Array, signature: string): boolean {
  throw new Error("未实现");
}
