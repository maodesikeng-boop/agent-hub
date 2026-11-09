// 邀请码（docs/multi-device-design.md 第 3.2 节）：只在内存里（重启就作废），只存 sha256。
// 10 分钟内、只能用一次；按来配对的设备编号记错误次数（不对、过期、用过都算），同一台错 PEER_INVITE_MAX_FAILURES 次就锁住这一台，
// 别的设备、没用掉的邀请码不受影响；用户在本机重新生成一个才解锁（已配对的设备替第三台要的不解锁）。
import { PEER_INVITE_FAILURE_SOURCES, PEER_INVITE_MAX_FAILURES, PEER_INVITE_TTL_MS, type DeviceId } from "../../shared/index.ts";
import { matchesHash, newInviteCode, sha256Hex } from "./tokens.ts";

/** 邀请码是谁要的：user = 用户在本机点的；介绍 = 已配对的设备 via 替 for 要的（只给 for 用，via 还配着才有效）；slotPort = 中心给隧道槽位分的（绑槽位）。 */
type InviteFrom = "user" | { for: DeviceId; via: DeviceId } | { slotPort: number };

type ConsumeResult = { ok: true; by: InviteFrom } | { ok: false; reason: "invalid" | "locked" };

export interface InviteBook {
  /** by：user 或 slotPort 会解锁所有设备；介绍的，for 那台锁着时回 null。 */
  create(by: InviteFrom): { code: string; expiresAt: number } | null;
  /** deviceId：来配对的是哪台。替别的设备要的邀请码，来的不是那台也算错一次。 */
  consume(code: unknown, deviceId: DeviceId): ConsumeResult;
}

export function createInviteBook(opts: { now?: () => number; ttlMs?: number; maxFailures?: number } = {}): InviteBook {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? PEER_INVITE_TTL_MS;
  const maxFailures = opts.maxFailures ?? PEER_INVITE_MAX_FAILURES;
  let invites: Array<{ hash: string; expiresAt: number; by: InviteFrom }> = [];
  /** 每台来配对的设备错了几次；最多记 PEER_INVITE_FAILURE_SOURCES 台，满了丢最早的。 */
  const failures = new Map<DeviceId, number>();
  const locked = (id: DeviceId) => (failures.get(id) ?? 0) >= maxFailures;

  return {
    create(by) {
      if (by === "user" || "slotPort" in by) failures.clear();
      else if (locked(by.for)) return null;
      const code = newInviteCode();
      const expiresAt = now() + ttl;
      invites = invites.filter((i) => i.expiresAt > now());
      invites.push({ hash: sha256Hex(code), expiresAt, by });
      return { code, expiresAt };
    },
    consume(code, deviceId) {
      if (locked(deviceId)) return { ok: false, reason: "locked" };
      // 每个都比一遍（定时长），不在找到时提前结束
      let hit = -1;
      invites.forEach((invite, i) => {
        if (matchesHash(invite.hash, code) && hit === -1) hit = i;
      });
      const invite = hit === -1 ? undefined : invites[hit];
      if (invite !== undefined) invites.splice(hit, 1);
      if (invite !== undefined && invite.expiresAt > now() && (invite.by === "user" || "slotPort" in invite.by || invite.by.for === deviceId)) {
        return { ok: true, by: invite.by };
      }
      const count = (failures.get(deviceId) ?? 0) + 1;
      failures.delete(deviceId);
      if (failures.size >= PEER_INVITE_FAILURE_SOURCES) failures.delete(failures.keys().next().value!);
      failures.set(deviceId, count);
      return { ok: false, reason: locked(deviceId) ? "locked" : "invalid" };
    },
  };
}
