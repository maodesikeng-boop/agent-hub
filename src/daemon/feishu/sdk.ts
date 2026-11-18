// 用官方 @larksuiteoapi/node-sdk（>= 1.61.1，有 registerApp）实现 transport.ts 的接口，整个仓库只有这个文件引这个包。
// 消息正文用 SDK 导出的 normalize 转成 markdown。
import type { FeishuBrandName } from "../../shared/feishu.ts";
import type { FeishuAppAddons, FeishuAppPreset } from "./scopes.ts";
import type { FeishuTransport } from "./transport.ts";

export interface FeishuSdkOptions {
  brand: FeishuBrandName;
  appId: string;
  appSecret: string;
  log: (line: string) => void;
}

/**
 * 前置：appId、appSecret 是同一个应用的。
 * 后置：返回的传输层还没连长连接（start 时才连）；call 用 tenant_access_token，SDK 自己换取和续期。
 */
export function createFeishuSdkTransport(options: FeishuSdkOptions): FeishuTransport {
  throw new Error("未实现");
}

export interface FeishuRegistrationHandlers {
  /** 飞书给出确认页链接（十分钟内有效，只能一个人扫）。 */
  onUrl(info: { url: string; expiresAt: number }): void;
}

export interface FeishuRegistrationResult {
  brand: FeishuBrandName;
  appId: string;
  appSecret: string;
  /** 扫码确认的那个人；飞书没给时是 null（这时走绑定码认主人）。 */
  scannerOpenId: string | null;
}

/** 扫码建应用失败：access_denied（用户拒绝）、expired_token（过期）、abort（取消）或别的错误码。 */
export class FeishuRegistrationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * registerApp：Device Authorization Grant（RFC 8628）扫码一键建应用。
 * 前置：addons 只放平台默认模板之外的增量（scopes.ts 的 FEISHU_APP_ADDONS）。
 * 后置：用户扫码确认后返回凭证；拒绝、过期、被 signal 取消时抛 FeishuRegistrationError。createOnly 为 true，确认页不给选已有应用。
 */
export function registerFeishuApp(input: {
  preset: FeishuAppPreset;
  addons: FeishuAppAddons;
  handlers: FeishuRegistrationHandlers;
  signal: AbortSignal;
}): Promise<FeishuRegistrationResult> {
  throw new Error("未实现");
}
