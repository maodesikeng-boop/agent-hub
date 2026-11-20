import { PRODUCT_NAME } from "../../shared/names.ts";

export const FEISHU_GROUP_MSG_SCOPE = "im:message.group_msg";

export const FEISHU_TEMPLATE_SCOPES: readonly string[] = [
  "im:message:send_as_bot",
  "im:message.p2p_msg:readonly",
  "im:message.group_at_msg:readonly",
  "im:message:readonly",
  "im:message:update",
  "im:resource",
  "im:chat:create",
  "im:chat:update",
  "im:chat:read",
  "cardkit:card:write",
];

export interface FeishuAppAddons {
  preset: true;
  scopes: { tenant: readonly string[] };
  events: { items: { tenant: readonly string[] } };
}

export interface FeishuAppPreset {
  name: string;
  desc: string;
}

export const FEISHU_APP_ADDONS: FeishuAppAddons = {
  preset: true,
  scopes: {
    tenant: ["im:message.group_msg", "im:chat.members:read", "im:chat:operate_as_owner", "im:message.pins:write_only"],
  },
  events: {
    items: {
      tenant: ["im.chat.member.user.added_v1", "im.chat.member.user.deleted_v1", "im.chat.disbanded_v1", "im.chat.updated_v1"],
    },
  },
};

export const FEISHU_REQUIRED_SCOPES: readonly string[] = [
  "im:message:send_as_bot",
  "im:message.p2p_msg:readonly",
  "im:message.group_at_msg:readonly",
  "im:message:readonly",
  "im:message:update",
  "im:resource",
  "im:chat:create",
  "im:chat:update",
  "im:chat:read",
  "im:chat.members:read",
  "cardkit:card:write",
];

export const FEISHU_OPTIONAL_SCOPES: readonly string[] = [
  "im:message.group_msg",
  "im:chat:operate_as_owner",
  "im:message.pins:write_only",
];

export function feishuAppPreset(deviceName: string): FeishuAppPreset {
  const device = deviceName.trim();
  return {
    name: device === "" ? PRODUCT_NAME : `${PRODUCT_NAME} · ${device}`,
    desc: `${PRODUCT_NAME} 的飞书机器人：和总助单聊，每个项目经理一个项目群。一台设备一个应用。`,
  };
}

export interface FeishuScopeCheck {
  missing: string[];
  mentionOnly: boolean;
}

export function checkFeishuScopes(granted: readonly string[]): FeishuScopeCheck {
  const have = new Set(granted);
  return { missing: FEISHU_REQUIRED_SCOPES.filter((scope) => !have.has(scope)), mentionOnly: !have.has(FEISHU_GROUP_MSG_SCOPE) };
}
