// 出错时给人看的那句话：分类和说法都在这里（docs/ui-standard.md 第 17 条）。按通用的类型分，不按厂商的错误码散写在组件里；
// 各家的错误特征在 shared/vendors.ts（VENDOR_FAILURE_SIGNS），和厂商无关的网络错误特征在下面。原始错误放 title。
import { vendorFailureOf, type AgentVendor, type FailureKind } from "../shared/index.ts";

export type FailureCategory = FailureKind | "unknown";

export interface Failure {
  kind: FailureCategory;
  /** 给人看的一句话。 */
  text: string;
  /** 原始错误，放 title。 */
  raw: string;
}

/** 网络断了：Node 的网络错误码和常见说法，哪家厂商都一样。 */
const NETWORK = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|fetch failed|network error|connection error|unable to connect/i;

const TEXT: Readonly<Record<FailureKind, (serviceName: string) => string>> = {
  busy: (name) => `${name} 服务繁忙，稍后重试`,
  quota: (name) => `${name} 额度用完了`,
  network: () => "网络断了，稍后重试",
  missing: (name) => `找不到 ${name}`,
  start: (name) => `${name} 没能启动`,
  auth: (name) => `${name} 未登录或鉴权失败`,
  context: (name) => `${name} 上下文超长`,
};

const UNKNOWN_TEXT = "出错了";

/**
 * 原始错误 → 一句人话。认不出来的默认写“出错了”；原因本来就可能是给人看的话（Worker 这一轮没做完、定时任务没跑成）时
 * 传 unknown: "raw"，认不出来就原样显示。
 */
export function describeFailure(raw: string, options: { unknown?: "generic" | "raw"; vendor?: AgentVendor } = {}): Failure {
  const vendor = vendorFailureOf(raw, options.vendor);
  // 网络断了排在厂商的“服务繁忙”前面：“Connection error” 不是对方忙
  if (NETWORK.test(raw) && vendor?.kind !== "start" && vendor?.kind !== "missing") return { kind: "network", text: TEXT.network(""), raw };
  if (vendor) return { kind: vendor.kind, text: TEXT[vendor.kind](vendor.serviceName), raw };
  const text = options.unknown === "raw" && raw.trim() !== "" ? raw : UNKNOWN_TEXT;
  return { kind: "unknown", text, raw };
}
