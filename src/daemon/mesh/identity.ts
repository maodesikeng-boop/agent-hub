// 设备密钥和证书（docs/account-mesh-design.md「设备身份与信任」）：首次登录时生成 Ed25519 私钥和自签证书，证书 CN 是设备编号。
// Node 能用证书不能生成证书，生成用 @peculiar/x509（实现时 pnpm add，整个仓库只有这个文件引它）。
// 不变量：私钥只在 state/mesh/key.pem（0600；Worker 按数据目录读边界整个 state/ 禁读）；设备指纹 = 证书 DER 的 SHA-256，和 relay/auth.ts 的 fingerprintOfPem 一致。
import "reflect-metadata";
import { X509CertificateGenerator, cryptoProvider } from "@peculiar/x509";
import { X509Certificate, createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, webcrypto, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { isDeviceId, type DeviceId } from "../../shared/api.ts";
import { MESH_KEY_FILE_MODE, MESH_STATE_DIR_MODE } from "../../shared/limits.ts";
import type { DeviceFingerprint } from "../../shared/mesh.ts";
import { base64UrlDecode, base64UrlEncode } from "../../relay/protocol.ts";

cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0]);

const KEY_FILE = "key.pem";
const CERT_FILE = "cert.pem";
/** 证书有效期：设备证书只用来钉指纹，不靠有效期，给足年头免得过期后握手失败。 */
const CERT_VALID_YEARS = 100;

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
export async function loadOrCreateMeshIdentity(dir: string, deviceId: DeviceId): Promise<MeshIdentity> {
  const keyFile = join(dir, KEY_FILE);
  const certFile = join(dir, CERT_FILE);
  mkdirSync(dir, { recursive: true, mode: MESH_STATE_DIR_MODE });
  chmodSync(dir, MESH_STATE_DIR_MODE);
  const hasKey = existsSync(keyFile);
  const hasCert = existsSync(certFile);
  if (!hasKey && !hasCert) {
    const generated = await generateIdentity(deviceId);
    await writeFileAtomic(keyFile, generated.keyPem, { mode: MESH_KEY_FILE_MODE });
    await writeFileAtomic(certFile, generated.certPem, { mode: 0o644 });
  } else if (!hasKey || !hasCert) {
    throw new Error(`设备密钥不全：缺 ${hasKey ? certFile : keyFile}。删掉 ${dir} 后重新登录`);
  }
  const keyPem = await readFile(keyFile, "utf8");
  const certPem = await readFile(certFile, "utf8");
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(keyPem);
  } catch {
    throw new Error(`设备私钥坏了：${keyFile}。删掉 ${dir} 后重新登录`);
  }
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
  } catch {
    throw new Error(`设备证书坏了：${certFile}。删掉 ${dir} 后重新登录`);
  }
  if (privateKey.asymmetricKeyType !== "ed25519" || !cert.checkPrivateKey(privateKey)) {
    throw new Error(`设备私钥和证书对不上：${keyFile}、${certFile}。删掉 ${dir} 后重新登录`);
  }
  if (deviceIdOfCertPem(certPem) !== deviceId) {
    throw new Error(`设备证书不是这台的：${certFile}。删掉 ${dir} 后重新登录`);
  }
  const publicKey = base64UrlEncode(createPublicKey(privateKey).export({ type: "spki", format: "der" }));
  return {
    deviceId,
    fingerprint: fingerprintOfCertPem(certPem),
    certPem,
    keyPem,
    publicKey,
    sign: (message) => base64UrlEncode(cryptoSign(null, message, privateKey)),
  };
}

async function generateIdentity(deviceId: DeviceId): Promise<{ keyPem: string; certPem: string }> {
  const keys = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as webcrypto.CryptoKeyPair;
  const now = Date.now();
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + CERT_VALID_YEARS);
  const cert = await X509CertificateGenerator.createSelfSigned({
    serialNumber: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("hex").replace(/^[89a-f]/, "1"),
    name: `CN=${deviceId}`,
    notBefore: new Date(now - 24 * 60 * 60_000),
    notAfter,
    signingAlgorithm: { name: "Ed25519" },
    keys,
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey));
  const keyPem = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }).export({ type: "pkcs8", format: "pem" }).toString();
  return { keyPem, certPem: cert.toString("pem") + "\n" };
}

/** 后置：PEM 证书 DER 的 SHA-256（小写十六进制）；不是一张 PEM 证书时抛错。 */
export function fingerprintOfCertPem(certPem: string): DeviceFingerprint {
  return createHash("sha256").update(new X509Certificate(certPem).raw).digest("hex") as DeviceFingerprint;
}

/** 后置：证书 CN 是合法设备编号时返回它，否则 null。 */
export function deviceIdOfCertPem(certPem: string): DeviceId | null {
  let subject: string;
  try {
    subject = new X509Certificate(certPem).subject;
  } catch {
    return null;
  }
  const match = /^CN=([^\n]+)$/.exec(subject);
  return match !== null && isDeviceId(match[1]!) ? match[1]! : null;
}

/** 后置：用证书里的公钥验 base64url 签名，对得上回 true；证书或签名格式不对回 false，不抛错。 */
export function verifyWithCert(certPem: string, message: Uint8Array, signature: string): boolean {
  const sig = base64UrlDecode(signature);
  if (sig === null) return false;
  try {
    return cryptoVerify(null, message, new X509Certificate(certPem).publicKey, sig);
  } catch {
    return false;
  }
}
