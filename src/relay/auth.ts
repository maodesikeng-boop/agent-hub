// 中继的身份校验（docs/account-mesh-design.md「账号与登录」「中继」）：验 GitHub token、算账号编号、验设备签名。
// 只用 WebCrypto 和 fetch，Cloudflare Workers 和 Node 都能跑。中继没有任何服务端密钥：GitHub 设备码登录不需要 client secret，
// 验 token 用的是用户自己登录拿到的 token，用完就丢，不存。
import { parseAccountId, type AccountId, type AccountLogin, type DeviceFingerprint } from "../shared/mesh.ts";
import { base64UrlDecode } from "./protocol.ts";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ACCOUNT_ID_CHARS = 26;
const PEM_CERTIFICATE = /^-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n?-----END CERTIFICATE-----\r?\n?$/;
const GITHUB_USER_AGENT = "fusa-relay";

/** GitHub REST 的默认地址；自建中继和测试可以换。 */
export const GITHUB_API_ORIGIN = "https://api.github.com";

/**
 * 用用户的 GitHub access token 问 GET /user。
 * 后置：200 且带数字 id 回 { provider: "github", userId: 数字 id 的十进制, login }；401、403 回 null；网络错误和 5xx 抛错（调用方回 502，不当成登录失败）。
 */
export async function verifyGithubToken(token: string, options?: { fetch?: typeof fetch; apiOrigin?: string }): Promise<AccountLogin | null> {
  const res = await (options?.fetch ?? fetch)(`${options?.apiOrigin ?? GITHUB_API_ORIGIN}/user`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": GITHUB_USER_AGENT,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (res.status === 401 || res.status === 403) return null;
  if (res.status !== 200) throw new Error(`GitHub 回了 HTTP ${res.status}`);
  const body = (await res.json()) as { id?: unknown; login?: unknown };
  if (typeof body.id !== "number" || !Number.isSafeInteger(body.id) || body.id <= 0 || typeof body.login !== "string") {
    throw new Error("GitHub 回的用户信息不对");
  }
  return { provider: "github", userId: String(body.id), login: body.login };
}

/** 后置：同一个登录方式和数字 id 永远得到同一个账号编号；登录名变了账号不变；parseAccountId 认得结果。 */
export async function accountIdOf(login: Pick<AccountLogin, "provider" | "userId">): Promise<AccountId> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${login.provider}:${login.userId}`)));
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < ACCOUNT_ID_CHARS) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
    if (out.length === ACCOUNT_ID_CHARS) break;
  }
  const id = parseAccountId(`acct_${out}`);
  if (id === null) throw new Error("账号编号算错了");
  return id;
}

/** 后置：PEM 证书的 DER 的 SHA-256（小写十六进制）；不是一张 PEM 证书时抛错。和守护进程 identity.ts 算出的一样。 */
export async function fingerprintOfPem(certPem: string): Promise<DeviceFingerprint> {
  const der = derOfCertPem(certPem);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", der));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("") as DeviceFingerprint;
}

/** 后置：一张 PEM 证书的 DER；不是一张 PEM 证书（含多张、前后有别的内容）时抛错。 */
export function derOfCertPem(certPem: string): Uint8Array {
  const match = PEM_CERTIFICATE.exec(certPem);
  if (match === null) throw new Error("不是一张 PEM 证书");
  const body = match[1]!.replace(/[\r\n]/g, "");
  let binary: string;
  try {
    binary = atob(body);
  } catch {
    throw new Error("不是一张 PEM 证书");
  }
  if (binary.length === 0) throw new Error("不是一张 PEM 证书");
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** 后置：publicKey（SPKI DER 的 base64url，Ed25519）对 message 的签名对得上回 true；公钥、签名格式不对回 false，不抛错。 */
export async function verifyDeviceSignature(publicKey: string, message: Uint8Array, signature: string): Promise<boolean> {
  const spki = base64UrlDecode(publicKey);
  const sig = base64UrlDecode(signature);
  if (spki === null || sig === null) return false;
  try {
    const key = await crypto.subtle.importKey("spki", spki, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, message);
  } catch {
    return false;
  }
}

interface DerElement {
  tag: number;
  start: number;
  contentStart: number;
  end: number;
}

function readDerElement(buf: Uint8Array, offset: number): DerElement | null {
  if (offset + 2 > buf.length) return null;
  const tag = buf[offset]!;
  const first = buf[offset + 1]!;
  let headerLen = 2;
  let contentLen = 0;
  if ((first & 0x80) === 0) {
    contentLen = first;
  } else {
    const count = first & 0x7f;
    if (count === 0 || count > 4 || offset + 2 + count > buf.length) return null;
    if (buf[offset + 2] === 0) return null;
    for (let i = 0; i < count; i++) contentLen = contentLen * 256 + buf[offset + 2 + i]!;
    if (contentLen < 128) return null;
    headerLen = 2 + count;
  }
  const contentStart = offset + headerLen;
  const end = contentStart + contentLen;
  return end <= buf.length ? { tag, start: offset, contentStart, end } : null;
}

/** 后置：核对 certPem 中的 SubjectPublicKeyInfo 与 publicKey 完全一致，且证书本身的 Ed25519 自签名有效。 */
export async function verifyCertPublicKey(certPem: string, publicKey: string): Promise<boolean> {
  const expectedSpki = base64UrlDecode(publicKey);
  if (expectedSpki === null) return false;
  let der: Uint8Array;
  try {
    der = derOfCertPem(certPem);
  } catch {
    return false;
  }
  const cert = readDerElement(der, 0);
  if (cert === null || cert.tag !== 0x30 || cert.end !== der.length) return false;
  const tbs = readDerElement(der, cert.contentStart);
  if (tbs === null || tbs.tag !== 0x30 || tbs.end >= cert.end) return false;
  const sigAlg = readDerElement(der, tbs.end);
  if (sigAlg === null || sigAlg.tag !== 0x30 || sigAlg.end >= cert.end) return false;
  const sigVal = readDerElement(der, sigAlg.end);
  if (sigVal === null || sigVal.tag !== 0x03 || sigVal.end !== cert.end) return false;
  if (sigVal.contentStart >= sigVal.end || der[sigVal.contentStart] !== 0x00) return false;

  let cursor = tbs.contentStart;
  const maybeVersion = readDerElement(der, cursor);
  if (maybeVersion === null || maybeVersion.end > tbs.end) return false;
  if (maybeVersion.tag === 0xa0) cursor = maybeVersion.end;
  for (const expectedTag of [0x02, 0x30, 0x30, 0x30, 0x30]) {
    const field = readDerElement(der, cursor);
    if (field === null || field.tag !== expectedTag || field.end > tbs.end) return false;
    cursor = field.end;
  }
  const spki = readDerElement(der, cursor);
  if (spki === null || spki.tag !== 0x30 || spki.end > tbs.end) return false;
  const certSpki = der.subarray(spki.start, spki.end);
  if (certSpki.length !== expectedSpki.length) return false;
  for (let i = 0; i < certSpki.length; i++) {
    if (certSpki[i] !== expectedSpki[i]) return false;
  }
  try {
    const key = await crypto.subtle.importKey("spki", expectedSpki, { name: "Ed25519" }, false, ["verify"]);
    const tbsBytes = Uint8Array.from(der.subarray(tbs.start, tbs.end));
    const certSig = Uint8Array.from(der.subarray(sigVal.contentStart + 1, sigVal.end));
    return await crypto.subtle.verify({ name: "Ed25519" }, key, certSig, tbsBytes);
  } catch {
    return false;
  }
}
