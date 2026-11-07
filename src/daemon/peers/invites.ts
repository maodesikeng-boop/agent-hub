// 邀请码（docs/multi-device-design.md 第 3.2 节）：只在内存里（重启就作废），只存 sha256。
// 10 分钟内、只能用一次；错 PEER_INVITE_MAX_FAILURES 次（不对、过期、用过都算）锁住：作废所有没用掉的，
// 用户在本机重新生成一个才解锁（已配对的设备替第三台要的不解锁）。
import { PEER_INVITE_MAX_FAILURES, PEER_INVITE_TTL_MS, type DeviceId } from "../../shared/index.ts";
import { matchesHash, newInviteCode, sha256Hex } from "./tokens.ts";

/** ok 时带上邀请码是谁要的：user = 用户在本机点的；DeviceId = 已配对的设备替这台要的（只给这台用）。 */
export type ConsumeResult = { ok: true; by: "user" | DeviceId } | { ok: false; reason: "invalid" | "locked" };

export interface InviteBook {
  /** by：user 会解锁；DeviceId 是替那台要的，锁着时回 null。 */
  create(by: "user" | DeviceId): { code: string; expiresAt: number } | null;
  /** deviceId：来配对的是哪台。替别的设备要的邀请码，来的不是那台也算错一次。 */
  consume(code: unknown, deviceId: DeviceId): ConsumeResult;
}

export function createInviteBook(opts: { now?: () => number; ttlMs?: number; maxFailures?: number } = {}): InviteBook {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? PEER_INVITE_TTL_MS;
  const maxFailures = opts.maxFailures ?? PEER_INVITE_MAX_FAILURES;
  let invites: Array<{ hash: string; expiresAt: number; by: "user" | DeviceId }> = [];
  let failures = 0;
  let locked = false;

  return {
    create(by) {
      if (by === "user") {
        locked = false;
        failures = 0;
      } else if (locked) {
        return null;
      }
      const code = newInviteCode();
      const expiresAt = now() + ttl;
      invites = invites.filter((i) => i.expiresAt > now());
      invites.push({ hash: sha256Hex(code), expiresAt, by });
      return { code, expiresAt };
    },
    consume(code, deviceId) {
      if (locked) return { ok: false, reason: "locked" };
      // 每个都比一遍（定时长），不在找到时提前结束
      let hit = -1;
      invites.forEach((invite, i) => {
        if (matchesHash(invite.hash, code) && hit === -1) hit = i;
      });
      const invite = hit === -1 ? undefined : invites[hit];
      if (invite !== undefined) invites.splice(hit, 1);
      if (invite !== undefined && invite.expiresAt > now() && (invite.by === "user" || invite.by === deviceId)) return { ok: true, by: invite.by };
      failures++;
      if (failures >= maxFailures) {
        locked = true;
        invites = [];
        return { ok: false, reason: "locked" };
      }
      return { ok: false, reason: "invalid" };
    },
  };
}
