import type { HubCommand } from "./hub.ts";

import { truncateChars, type PmId } from "./domain.ts";
import { FEISHU_DISPLAY_NAME_MAX_CHARS } from "./limits.ts";

declare const feishuBrand: unique symbol;
type FeishuBrand<T extends string> = string & { readonly [feishuBrand]: T };

export type FeishuAppId = FeishuBrand<"FeishuAppId">;
export type FeishuOpenId = FeishuBrand<"FeishuOpenId">;
export type FeishuChatId = FeishuBrand<"FeishuChatId">;
export type FeishuMessageId = FeishuBrand<"FeishuMessageId">;
export type FeishuCardId = FeishuBrand<"FeishuCardId">;
export type FeishuImageKey = FeishuBrand<"FeishuImageKey">;

const ID_PATTERNS = {
  cli: /^cli_[A-Za-z0-9]+$/,
  ou: /^ou_[A-Za-z0-9]+$/,
  oc: /^oc_[A-Za-z0-9]+$/,
  om: /^om_[A-Za-z0-9_-]+$/,
} as const;

function brandIf<T extends string>(raw: unknown, pattern: RegExp): T | null {
  return typeof raw === "string" && pattern.test(raw) ? (raw as T) : null;
}

export function parseFeishuAppId(raw: unknown): FeishuAppId | null {
    return brandIf(raw, ID_PATTERNS.cli);
}

export function parseFeishuOpenId(raw: unknown): FeishuOpenId | null {
    return brandIf(raw, ID_PATTERNS.ou);
}

export function parseFeishuChatId(raw: unknown): FeishuChatId | null {
    return brandIf(raw, ID_PATTERNS.oc);
}

export function parseFeishuMessageId(raw: unknown): FeishuMessageId | null {
    return brandIf(raw, ID_PATTERNS.om);
}

export function parseFeishuCardId(raw: unknown): FeishuCardId | null {
    return brandIf(raw, /^[A-Za-z0-9]+$/);
}

export function parseFeishuImageKey(raw: unknown): FeishuImageKey | null {
    return typeof raw === "string" && raw !== "" ? (raw as FeishuImageKey) : null;
}

export const FEISHU_BRANDS = ["feishu", "lark"] as const;
export type FeishuBrandName = (typeof FEISHU_BRANDS)[number];

export const FEISHU_SPEAKER_ROLES = ["owner", "guest"] as const;
export type FeishuSpeakerRole = (typeof FEISHU_SPEAKER_ROLES)[number];

export const FEISHU_CHAT_MODES = ["solo", "shared"] as const;
export type FeishuChatMode = (typeof FEISHU_CHAT_MODES)[number];

export const FEISHU_TRIGGER_MODES = ["auto", "mention_only"] as const;
export type FeishuTriggerMode = (typeof FEISHU_TRIGGER_MODES)[number];

export const FEISHU_GUEST_TIERS = ["chat_only", "collaborator", "observer"] as const;
export type FeishuGuestTier = (typeof FEISHU_GUEST_TIERS)[number];

export type FeishuGuestAction = "talk" | "answer_card" | "stop" | "send_files";

const GUEST_ACTIONS: Readonly<Record<FeishuGuestTier, readonly FeishuGuestAction[]>> = {
  chat_only: ["talk"],
  collaborator: ["talk", "answer_card", "stop", "send_files"],
  observer: [],
};

export function feishuGuestMay(tier: FeishuGuestTier, action: FeishuGuestAction): boolean {
    return GUEST_ACTIONS[tier].includes(action);
}

export type FeishuChatTarget = { kind: "router" } | { kind: "pm"; pmId: PmId };

export interface FeishuContextLine {
  name: string;
  role: FeishuSpeakerRole;
  text: string;
  at: number;
}

export interface FeishuMessageOrigin {
  kind: "feishu";
  openId: FeishuOpenId;
  name: string;
  role: FeishuSpeakerRole;
  mode: FeishuChatMode;
  guestTier: FeishuGuestTier;
  context: FeishuContextLine[];
}

export const FEISHU_ROLE_LABELS: Readonly<Record<FeishuSpeakerRole, string>> = { owner: "主人", guest: "访客" };
const FEISHU_CONTEXT_HEADING = "群里之前的讨论（没 @机器人 的话，按时间先后）：";

export function feishuDisplayName(raw: string): string {
  const name = truncateChars(raw.replace(/\s+/g, " ").trim(), FEISHU_DISPLAY_NAME_MAX_CHARS);
  return name === "" ? "飞书用户" : name;
}

const isOne = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && (values as readonly string[]).includes(value);

function isContextLine(value: unknown): value is FeishuContextLine {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.name === "string" && isOne(FEISHU_SPEAKER_ROLES, v.role) && typeof v.text === "string" && typeof v.at === "number";
}

export function feishuOriginOf(message: { meta: Record<string, unknown> | null }): FeishuMessageOrigin | null {
  const raw = message.meta?.origin;
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (
    o.kind !== "feishu" ||
    parseFeishuOpenId(o.openId) === null ||
    typeof o.name !== "string" ||
    !isOne(FEISHU_SPEAKER_ROLES, o.role) ||
    !isOne(FEISHU_CHAT_MODES, o.mode) ||
    !isOne(FEISHU_GUEST_TIERS, o.guestTier) ||
    !Array.isArray(o.context)
  ) {
    return null;
  }
  return {
    kind: "feishu",
    openId: o.openId as FeishuOpenId,
    name: o.name,
    role: o.role,
    mode: o.mode,
    guestTier: o.guestTier,
    context: o.context.filter(isContextLine),
  };
}

export function feishuDeliveryPrefixes(origin: FeishuMessageOrigin): string[] {
    const prefixes: string[] = [];
  if (origin.mode === "shared") prefixes.push(`【飞书 · ${feishuDisplayName(origin.name)}（${FEISHU_ROLE_LABELS[origin.role]}）】`);
  if (origin.context.length > 0) {
    const lines = origin.context.map((line) => `${feishuDisplayName(line.name)}（${FEISHU_ROLE_LABELS[line.role]}）：${line.text}`);
    prefixes.push([FEISHU_CONTEXT_HEADING, ...lines].join("\n"));
  }
  return prefixes;
}

export const FEISHU_GUEST_BLOCKED_HUB_COMMANDS: Readonly<Record<FeishuGuestTier, readonly HubCommand[]>> = {
  chat_only: ["project.create", "project.attach", "project.detach", "project.setup", "project.review-status", "persona.edit", "graph.decide", "schedule.add"],
  collaborator: ["project.create", "project.attach", "project.detach", "project.setup", "project.review-status", "persona.edit"],
  observer: ["project.create", "project.attach", "project.detach", "project.setup", "project.review-status", "persona.edit", "graph.decide", "schedule.add"],
};

export function feishuGuestTurnBlockReason(command: HubCommand, origin: FeishuMessageOrigin | null): string | null {
    if (origin === null || origin.role !== "guest") return null;
  if (!FEISHU_GUEST_BLOCKED_HUB_COMMANDS[origin.guestTier].includes(command)) return null;
  return `这一轮是飞书群里的访客（${feishuDisplayName(origin.name)}）说的话触发的，访客不能让你做 ${command}。要做的话请等主人自己说。`;
}

export const FEISHU_CONNECTION_STATES = [
  "unconfigured",
  "registering",
  "connecting",
  "awaiting_owner",
  "needs_permission",
  "connected",
  "auth_failed",
  "disabled",
] as const;
export type FeishuConnectionState = (typeof FEISHU_CONNECTION_STATES)[number];

export interface FeishuChatView {
  chatId: FeishuChatId;
  target: FeishuChatTarget;
  name: string;
  mode: FeishuChatMode;
  triggerMode: FeishuTriggerMode;
  guestTier: FeishuGuestTier;
  guestCount: number;
  archived: boolean;
}

export interface FeishuStatusView {
  state: FeishuConnectionState;
  brand: FeishuBrandName | null;
  appId: FeishuAppId | null;
  botName: string | null;
  ownerOpenId: FeishuOpenId | null;
  ownerName: string | null;
  registration: FeishuRegistrationView | null;
  missing: string[];
  lastError: string | null;
  hosting?: boolean;
  chats: FeishuChatView[];
}

export interface FeishuRegistrationView {
  url: string;
  expiresAt: number;
}

export interface FeishuCredentialsRequest {
  brand: FeishuBrandName;
  appId: string;
  appSecret: string;
}

export interface FeishuBindCodeResponse {
  code: string;
  expiresAt: number;
}

export interface FeishuChatPolicyRequest {
  pmId: PmId;
  triggerMode?: FeishuTriggerMode;
  guestTier?: FeishuGuestTier;
}

export interface FeishuDisconnectRequest {
  dissolveChats: boolean;
}
