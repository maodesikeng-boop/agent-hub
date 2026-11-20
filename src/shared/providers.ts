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

export type ProviderAuthMethodDescriptor =
  | {
      readonly id: string;
      readonly kind: "browser_oauth";
      readonly label: string;
      readonly variants?: readonly ProviderAuthVariant[];
      readonly manualInput: ProviderAuthManualInput;
      readonly preferDeviceCodeWhenRemote?: boolean;
      readonly targetIds?: readonly string[];
    }
  | {
      readonly id: string;
      readonly kind: "device_code";
      readonly label: string;
      readonly targetIds?: readonly string[];
    }
  | {
      readonly id: string;
      readonly kind: "api_key";
      readonly label: string;
      readonly placeholder: string;
      readonly targets?: readonly ProviderAuthTarget[];
    };

export type ProviderJobKind = "install" | "update";
export type ProviderJobPhase = "running" | "succeeded" | "failed" | "cancelled";

export interface ProviderJobSnapshot {
  readonly jobId: string;
  readonly kind: ProviderJobKind;
  readonly phase: ProviderJobPhase;
  readonly progressLine: string | null;
  readonly error: string | null;
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
  readonly authorizeUrl: string | null;
  readonly verificationUrl: string | null;
  readonly userCode: string | null;
  readonly manualInput: ProviderAuthManualInput;
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
