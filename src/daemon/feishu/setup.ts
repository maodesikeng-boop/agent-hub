import { z } from "zod";
import { FEISHU_BRANDS, FEISHU_GUEST_TIERS, FEISHU_TRIGGER_MODES } from "../../shared/feishu.ts";
import type {
  FeishuBindCodeResponse,
  FeishuChatPolicyRequest,
  FeishuChatView,
  FeishuCredentialsRequest,
  FeishuDisconnectRequest,
  FeishuStatusView,
} from "../../shared/feishu.ts";

export class FeishuSetupError extends Error {}

export const feishuCredentialsSchema = z
  .object({ brand: z.enum(FEISHU_BRANDS), appId: z.string().trim().min(1).max(64), appSecret: z.string().trim().min(1).max(256) })
  .strict();
export const feishuChatPolicyBodySchema = z
  .object({ triggerMode: z.enum(FEISHU_TRIGGER_MODES).optional(), guestTier: z.enum(FEISHU_GUEST_TIERS).optional() })
  .strict()
  .refine((v) => v.triggerMode !== undefined || v.guestTier !== undefined, "triggerMode 和 guestTier 至少给一个");
export const feishuDisconnectSchema = z.object({ dissolveChats: z.boolean() }).strict();

export interface FeishuSetupService {
  status(): FeishuStatusView;
  startRegistration(): Promise<FeishuStatusView>;
  cancelRegistration(): FeishuStatusView;
  saveCredentials(input: FeishuCredentialsRequest): Promise<FeishuStatusView>;
  issueBindCode(): FeishuBindCodeResponse;
  consumeBindCode(text: string, now: number): boolean;
  setChatPolicy(input: FeishuChatPolicyRequest): Promise<FeishuChatView>;
  resync(): Promise<FeishuStatusView>;
  disconnect(input: FeishuDisconnectRequest): Promise<FeishuStatusView>;
}
