// 设备令牌、邀请码：随机生成、只存 sha256、定时长比较（docs/multi-device-design.md 第 3.2 节）。
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { PEER_INVITE_BYTES, PEER_TOKEN_BYTES } from "../../shared/index.ts";

/** 设备令牌的样子：32 字节 base64url，43 个字符。对方发来的先查形状再查哈希。 */
export const PEER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const newPeerToken = (): string => randomBytes(PEER_TOKEN_BYTES).toString("base64url");

/** 邀请码：128 位随机，base64url 22 个字符（用户要抄到另一台上，不加别的字符）。 */
export const newInviteCode = (): string => randomBytes(PEER_INVITE_BYTES).toString("base64url");

export const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

/** 定时长比较：给的值先取 sha256 再和存着的哈希比，不泄露长度和前缀。存着的不是 64 位十六进制当不相等。 */
export function matchesHash(storedHex: string, given: unknown): boolean {
  if (typeof given !== "string" || !/^[0-9a-f]{64}$/.test(storedHex)) return false;
  return timingSafeEqual(Buffer.from(storedHex, "hex"), createHash("sha256").update(given).digest());
}
