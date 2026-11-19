// 飞书应用要的权限、事件和回调（docs/feishu-design.md「飞书官方接口」）。权限和事件只在这里定义。
// 扫码建应用用平台的「智能体应用配置清单」做底（已含单聊和 @机器人 消息、建群改群、上传资源、卡片读写、卡片回传交互，
// 事件与回调默认走长连接），这里只列底座之外要加的增量，经 registerApp 的 addons 预填到确认页。

import { PRODUCT_NAME } from "../../shared/names.ts";

/** 收群里所有消息的权限：没授予时所有群按 mention_only。 */
export const FEISHU_GROUP_MSG_SCOPE = "im:message.group_msg";

/**
 * 平台「智能体应用配置清单」默认带的权限（docs/feishu-design.md「飞书官方接口」的默认模板一行）。addons 只能往上加。
 */
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

/** registerApp 的 addons（形状和官方 AppAddons 一致）。 */
export interface FeishuAppAddons {
  preset: true;
  scopes: { tenant: readonly string[] };
  events: { items: { tenant: readonly string[] } };
}

/** registerApp 的 appPreset（确认页预填，用户还能改）。 */
export interface FeishuAppPreset {
  name: string;
  desc: string;
}

/**
 * 底座之外要加的：
 * - im:message.group_msg：收群里不 @机器人 的话（单人群直聊、记背景）。敏感权限，个人版企业里主人自己就是管理员；
 * - im:chat.members:read：订阅成员进出群、列群成员和显示名；
 * - im:chat:operate_as_owner：机器人改自己建的群（群主转给主人以后仍能改名、换头像）；
 * - im:message.pins:write_only：置顶最新设置卡并替换旧置顶（没授予时静默降级）；
 * - 事件：成员进群、退群、群解散、群信息改了。
 */
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

/**
 * 缺了会让哪件事做不成的权限（核对 GET /open-apis/application/v6/scopes 的授予状态）。
 * 缺 im:message.group_msg 时不报失败，只把所有群降级成 mention_only；缺别的进 needs_permission。
 */
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

/** 可选的权限：缺了只降级，不进 needs_permission。 */
export const FEISHU_OPTIONAL_SCOPES: readonly string[] = [
  "im:message.group_msg",
  "im:chat:operate_as_owner",
  "im:message.pins:write_only",
];

/** 后置：扫码确认页上预填的应用名和说明，应用名带设备名（如“Fusa · 东京”），一台设备一个应用。 */
export function feishuAppPreset(deviceName: string): FeishuAppPreset {
  const device = deviceName.trim();
  return {
    name: device === "" ? PRODUCT_NAME : `${PRODUCT_NAME} · ${device}`,
    desc: `${PRODUCT_NAME} 的飞书机器人：和总助单聊，每个项目经理一个项目群。一台设备一个应用。`,
  };
}

export interface FeishuScopeCheck {
  /** 必需权限里还没授予的。 */
  missing: string[];
  /** 没授予 im:message.group_msg：群里只收 @机器人 的话。 */
  mentionOnly: boolean;
}

/**
 * 前置：granted 是 application/v6/scopes 里 grant_status 为 1 的权限名。
 * 后置：missing 按 FEISHU_REQUIRED_SCOPES 的顺序列出没授予的；可选权限不进 missing。
 */
export function checkFeishuScopes(granted: readonly string[]): FeishuScopeCheck {
  const have = new Set(granted);
  return { missing: FEISHU_REQUIRED_SCOPES.filter((scope) => !have.has(scope)), mentionOnly: !have.has(FEISHU_GROUP_MSG_SCOPE) };
}
