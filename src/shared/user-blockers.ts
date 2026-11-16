// 要用户本人动手才解得开的阻塞（docs/user-blockers-design.md）：谁在等、等什么、在哪台设备、怎么解除，只在这里定义。
// 步骤显示“等你”、系统挂的提醒卡、点“已处理”后重查与接着派，都从这个形状推出来。
import { SYSTEM_MESSAGE_PREFIX } from "./domain.ts";
import { LedgerRequestError } from "./ledger.ts";
import {
  VENDOR_FAILURE_SIGNS,
  vendorSpec,
  isSelectable,
  vendorLabel,
  type AgentVendor,
  type VendorAvailability,
} from "./vendors.ts";

export type UserBlockerId = number;

/** 等什么：这家厂商在这台设备上没登录、没装。两种都是用户在那台设备上动手，系统重查厂商状态就知道解没解。 */
export const USER_BLOCKER_KINDS = ["vendor_signed_out", "vendor_not_installed"] as const;
export type UserBlockerKind = (typeof USER_BLOCKER_KINDS)[number];

/** 阻塞原因本身：同一家厂商、同一台设备只有一条在等（device 是这台守护进程的设备名，每台只判断自己）。 */
export interface UserBlockerCause {
  kind: UserBlockerKind;
  vendor: AgentVendor;
  device: string;
}

/** 一条阻塞的完整状态：原因，以及上次点“已处理”后重查的结果。卡是每个被卡住的项目经理对话里各一条消息（meta.blockerRef 指回这里）。 */
export interface UserBlocker extends UserBlockerCause {
  id: UserBlockerId;
  /** 点过“已处理”但重查还不能用时记下的那次状态；没重查过是 null。 */
  recheckedAs: VendorAvailability | null;
}

/** 厂商状态对应的阻塞种类；能用、认不出的是 null。 */
export function userBlockerKindOf(availability: VendorAvailability): UserBlockerKind | null {
  if (availability === "signed_out") return "vendor_signed_out";
  if (availability === "not_installed") return "vendor_not_installed";
  return null;
}

/** Worker 起不来时厂商给的原文对应的阻塞种类：认证失败是没登录，找不到程序是没装，别的（额度、网络……）是 null。 */
export function userBlockerKindOfFailure(raw: string, vendor: AgentVendor): UserBlockerKind | null {
  const signs = VENDOR_FAILURE_SIGNS[vendor];
  if (signs.signs.some((s) => s.kind === "missing" && s.pattern.test(raw))) return "vendor_not_installed";
  if (signs.auth.test(raw)) return "vendor_signed_out";
  return null;
}

/** 重查到的状态解开了这条阻塞没有。 */
export function userBlockerCleared(availability: VendorAvailability): boolean {
  return isSelectable(availability);
}

/** 要用户做什么、在哪台设备做：提醒卡的正文，也是 hub worker start 拒绝时的原因。 */
export function userBlockerText(cause: UserBlockerCause): string {
  const name = vendorLabel(cause.vendor);
  if (cause.kind === "vendor_not_installed") return `这台设备（${cause.device}）没装 ${name}：先在这台设备上装好 ${name}`;
  return `这台设备（${cause.device}）的 ${name} 没登录：先在这台设备的终端里跑 \`${vendorSpec(cause.vendor).cli.loginCommand}\` 登录`;
}

/** 提醒卡的正文：要做什么；点过 Done、重查还不能用的，后面补一句。对话里那条消息和任务图步骤上的卡都用它。 */
export function userBlockerCardText(blocker: UserBlockerCause & Pick<UserBlocker, "recheckedAs">): string {
  const head = `${userBlockerText(blocker)}。`;
  if (blocker.recheckedAs === null) return head;
  return `${head}\n\n${blocker.recheckedAs === "not_installed" ? "刚查过，还是没装。" : "刚查过，还是没登录。"}`;
}

/** 解开后卡住的 Worker 没有可重发的消息时，发给它的那句。 */
export function userBlockerResumeText(blocker: UserBlockerCause): string {
  return `${SYSTEM_MESSAGE_PREFIX}${vendorLabel(blocker.vendor)} 在这台设备上已经能用了，接着做你的任务。`;
}

/** 账本派 Worker 时发现要用户动手：带着原因抛出，自动开工的那一步据此挂卡等用户，而不是交给项目经理。 */
export class UserBlockedError extends LedgerRequestError {
  readonly blocker: UserBlockerCause;
  constructor(blocker: UserBlockerCause) {
    super("invalid", userBlockerText(blocker));
    this.name = "UserBlockedError";
    this.blocker = blocker;
  }
}
