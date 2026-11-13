// Settings → Providers 一键安装与界面内直接登录的前后端共享类型定义（docs/providers-install-login-design.md 第 5.1、6.3 节）。
// 浏览器安全：零 node:* 依赖、零具体厂商字面量硬编码。
import type { AgentVendor, VendorAvailability } from "./vendors.ts";

export type ProviderAuthManualInput = "none" | "code" | "callback_url" | "code_or_callback";

export interface ProviderAuthVariant {
  readonly id: string;
  readonly label: string;
}

export interface ProviderAuthTarget {
  readonly id: string;
  readonly label: string;
  readonly configured: boolean;
  readonly supportsOauth?: boolean;
}

/** 前端据此渲染登录弹窗中的选项卡与表单控件，零厂商硬编码。 */
export type ProviderAuthMethodDescriptor =
  | {
      readonly id: string;
      readonly kind: "browser_oauth";
      readonly label: string;
      /** 可选子模式单选（如订阅账号 vs API 控制台、个人账号 vs 企业账号）。 */
      readonly variants?: readonly ProviderAuthVariant[];
      /** 登录进行中是否允许用户粘贴授权码或回环回调 URL（远端无头服务器闭环）。 */
      readonly manualInput: ProviderAuthManualInput;
      /** 远端无头访问时是否优先推荐 device_code 方法。 */
      readonly preferDeviceCodeWhenRemote?: boolean;
      /** 聚合多子模型商时限定支持该 OAuth 方法的子目标 ID 列表；单厂商不传。 */
      readonly targetIds?: readonly string[];
    }
  | {
      readonly id: string;
      readonly kind: "device_code";
      readonly label: string;
      /** 聚合多子模型商时限定支持设备码登录的子目标 ID 列表；单厂商不传。 */
      readonly targetIds?: readonly string[];
    }
  | {
      readonly id: string;
      readonly kind: "api_key";
      readonly label: string;
      readonly placeholder: string;
      /** 多子模型商聚合厂商声明可选目标列表；单厂商不传。 */
      readonly targets?: readonly ProviderAuthTarget[];
    };

export type ProviderJobKind = "install" | "update";
export type ProviderJobPhase = "running" | "succeeded" | "failed" | "cancelled";

export interface ProviderJobSnapshot {
  readonly jobId: string;
  readonly kind: ProviderJobKind;
  readonly phase: ProviderJobPhase;
  /** 单行简短进度文案（英文，如 "Installing package…"），不刷屏。 */
  readonly progressLine: string | null;
  readonly error: string | null;
  /** 仅失败或取消后按需读取的脱敏尾部输出（最多 PROVIDER_JOB_LOG_MAX_LINES 行）。 */
  readonly logTail: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
}

export type ProviderAuthFlowPhase =
  | "starting"
  | "waiting_browser"
  | "waiting_device_code"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export interface ProviderAuthFlowSnapshot {
  readonly flowId: string;
  readonly methodId: string;
  readonly phase: ProviderAuthFlowPhase;
  /** 仅对发起该登录流的同一客户端会话暴露 URL 与验证码；其他客户端会话置 null。 */
  readonly authorizeUrl: string | null;
  readonly verificationUrl: string | null;
  readonly userCode: string | null;
  readonly manualInput: ProviderAuthManualInput;
  /** 被其他浏览器会话占用时为 true（界面提示 "Sign-in in progress in another window"）。 */
  readonly ownedByOtherClient: boolean;
  readonly error: string | null;
  readonly expiresAt: number;
}

export interface ProviderStatusItem {
  readonly vendor: AgentVendor;
  readonly label: string;
  readonly installed: boolean;
  readonly version: string | null;
  readonly availability: VendorAvailability;
  /** 克制的身份/凭据状态短语（如邮箱、"Signed in"、"API key configured"、"2 configured"），绝不含密钥原文。 */
  readonly accountSummary: string | null;
  readonly canInstall: boolean;
  readonly canUpdate: boolean;
  readonly canSignOut: boolean;
  readonly authMethods: readonly ProviderAuthMethodDescriptor[];
  readonly job: ProviderJobSnapshot | null;
  readonly authFlow: ProviderAuthFlowSnapshot | null;
}

export interface ProvidersStatusResponse {
  readonly platform: "darwin" | "win32" | "linux" | string;
  readonly gitInstalled: boolean;
  readonly canInstallGit: boolean;
  readonly gitJob: ProviderJobSnapshot | null;
  readonly providers: readonly ProviderStatusItem[];
}

export interface ProviderCancelJobRequest {
  readonly jobId: string;
}

export interface ProviderStartAuthRequest {
  readonly methodId: string;
  readonly variantId?: string;
  readonly targetId?: string;
  readonly remoteHint?: boolean;
}

export interface ProviderSubmitAuthRequest {
  readonly flowId: string;
  readonly input: string;
}

export interface ProviderCancelAuthRequest {
  readonly flowId: string;
}

export interface ProviderSaveApiKeyRequest {
  readonly targetId?: string;
  readonly apiKey: string;
}

export interface ProviderLogoutRequest {
  readonly targetId?: string;
}
