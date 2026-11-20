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

export const USER_BLOCKER_KINDS = ["vendor_signed_out", "vendor_not_installed"] as const;
export type UserBlockerKind = (typeof USER_BLOCKER_KINDS)[number];

export interface UserBlockerCause {
  kind: UserBlockerKind;
  vendor: AgentVendor;
  device: string;
}

export interface UserBlocker extends UserBlockerCause {
  id: UserBlockerId;
  recheckedAs: VendorAvailability | null;
}

export function userBlockerKindOf(availability: VendorAvailability): UserBlockerKind | null {
  if (availability === "signed_out") return "vendor_signed_out";
  if (availability === "not_installed") return "vendor_not_installed";
  return null;
}

export function userBlockerKindOfFailure(raw: string, vendor: AgentVendor): UserBlockerKind | null {
  const signs = VENDOR_FAILURE_SIGNS[vendor];
  if (signs.signs.some((s) => s.kind === "missing" && s.pattern.test(raw))) return "vendor_not_installed";
  if (signs.auth.test(raw)) return "vendor_signed_out";
  return null;
}

export function userBlockerCleared(availability: VendorAvailability): boolean {
  return isSelectable(availability);
}

export function userBlockerText(cause: UserBlockerCause): string {
  const name = vendorLabel(cause.vendor);
  if (cause.kind === "vendor_not_installed") return `这台设备（${cause.device}）没装 ${name}：先在这台设备上装好 ${name}`;
  return `这台设备（${cause.device}）的 ${name} 没登录：先在这台设备的终端里跑 \`${vendorSpec(cause.vendor).cli.loginCommand}\` 登录`;
}

export function userBlockerCardText(blocker: UserBlockerCause & Pick<UserBlocker, "recheckedAs">): string {
  const head = `${userBlockerText(blocker)}。`;
  if (blocker.recheckedAs === null) return head;
  return `${head}\n\n${blocker.recheckedAs === "not_installed" ? "刚查过，还是没装。" : "刚查过，还是没登录。"}`;
}

export function userBlockerResumeText(blocker: UserBlockerCause): string {
  return `${SYSTEM_MESSAGE_PREFIX}${vendorLabel(blocker.vendor)} 在这台设备上已经能用了，接着做你的任务。`;
}

export class UserBlockedError extends LedgerRequestError {
  readonly blocker: UserBlockerCause;
  constructor(blocker: UserBlockerCause) {
    super("invalid", userBlockerText(blocker));
    this.name = "UserBlockedError";
    this.blocker = blocker;
  }
}
