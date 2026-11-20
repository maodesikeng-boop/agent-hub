import { createHash } from "node:crypto";
import { truncateChars, type Pm, type PmId } from "../../shared/domain.ts";
import type { FeishuChatId } from "../../shared/feishu.ts";
import { FEISHU_CHAT_NAME_MAX_CHARS, FEISHU_CHAT_UUID_MAX_CHARS } from "../../shared/limits.ts";
import { PRODUCT_NAME } from "../../shared/names.ts";
import { lookKey, resolvePmLook, type SlimeLook } from "../../shared/slimes.ts";
import type { FeishuChatBinding } from "./store.ts";

export interface FeishuChatSpec {
  pmId: PmId;
  label: string;
  name: string;
  description: string;
  look: SlimeLook;
  archived: boolean;
}

export function desiredFeishuChats(pms: readonly Pm[], device: { id: string; name: string }): FeishuChatSpec[] {
  return pms.map((pm) => ({
    pmId: pm.id,
    label: pm.name,
    name: truncateChars(pm.name, FEISHU_CHAT_NAME_MAX_CHARS),
    description: `${PRODUCT_NAME}（${device.name}）上的项目经理「${pm.name}」。\n${feishuChatMarker(device.id, pm.id)}`,
    look: resolvePmLook(pm),
    archived: pm.archivedAt !== null && pm.archivedAt !== undefined,
  }));
}

export const FEISHU_CHAT_MARKER_PATTERN = /fusa:[0-9a-f-]+:pm:\d+/;

export function feishuChatMarker(deviceId: string, pmId: PmId): string {
  return `fusa:${deviceId}:pm:${pmId}`;
}

// Feishu dedupes chat creation by uuid for 10 hours; generation changes on every rebuild so a recreated chat is not dropped as a duplicate.
export function feishuChatCreateUuid(appId: string, deviceId: string, pmId: PmId, generation: number): string {
  const digest = createHash("sha256").update(`${appId}\n${deviceId}\n${pmId}\n${generation}`).digest("hex");
  return `fusa-${digest}`.slice(0, FEISHU_CHAT_UUID_MAX_CHARS);
}

export type FeishuChatOp =
  | { kind: "create"; spec: FeishuChatSpec; generation: number }
  | { kind: "adopt"; chatId: FeishuChatId; spec: FeishuChatSpec }
  | { kind: "rename"; chatId: FeishuChatId; name: string; label: string }
  | { kind: "set_avatar"; chatId: FeishuChatId; look: SlimeLook }
  | { kind: "dissolve"; chatId: FeishuChatId }
  | { kind: "retire"; chatId: FeishuChatId; dissolved: boolean };

export function planFeishuChatSync(
  desired: readonly FeishuChatSpec[],
  bindings: readonly FeishuChatBinding[],
  markedChats: ReadonlyMap<FeishuChatId, string>,
  deviceId: string,
): FeishuChatOp[] {
  const ops: FeishuChatOp[] = [];
  const byPm = new Map<PmId, FeishuChatBinding>();
  for (const binding of bindings) if (binding.target.kind === "pm" && binding.target.pmId !== null) byPm.set(binding.target.pmId, binding);
  const bound = new Set(bindings.map((b) => b.chatId));
  const wanted = new Set(desired.map((spec) => spec.pmId));
  for (const spec of desired) {
    const binding = byPm.get(spec.pmId);
    if (binding === undefined) {
      if (spec.archived) continue;
      const marker = feishuChatMarker(deviceId, spec.pmId);
      const adopted = [...markedChats].find(([chatId, mark]) => mark === marker && !bound.has(chatId));
      ops.push(adopted === undefined ? { kind: "create", spec, generation: 0 } : { kind: "adopt", chatId: adopted[0], spec });
      continue;
    }
    if (binding.archivedAt !== null) {
      if (!spec.archived) ops.push({ kind: "create", spec, generation: binding.archivedAt });
      continue;
    }
    if (spec.archived) {
      ops.push({ kind: "dissolve", chatId: binding.chatId });
      continue;
    }
    if (binding.label !== spec.label) ops.push({ kind: "rename", chatId: binding.chatId, name: spec.name, label: spec.label });
    if (binding.avatarLook === null || lookKey(binding.avatarLook) !== lookKey(spec.look)) ops.push({ kind: "set_avatar", chatId: binding.chatId, look: spec.look });
  }
  for (const binding of bindings) {
    if (binding.target.kind !== "pm") continue;
    if (binding.target.pmId === null || !wanted.has(binding.target.pmId)) {
      ops.push({ kind: "retire", chatId: binding.chatId, dissolved: binding.archivedAt !== null });
    }
  }
  return ops;
}
